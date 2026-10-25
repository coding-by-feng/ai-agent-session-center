/**
 * @module transcriptLocator
 * The one place that decides which file holds a session's conversation (AASC-49, AASC-41).
 *
 * Claude writes `~/.claude/projects/<encoded project>/<session id>.jsonl` (the hook reports it as
 * `transcriptPath`); Codex writes a rollout under `$CODEX_HOME/sessions` that only its session id
 * finds. A session reads its OWN file or nothing: never a neighbour's "newest .jsonl" in the same
 * project, and never the other CLI's folder. A Claude file moved into a worktree's projects folder
 * is still found by its id. Callers already fall back to the in-memory logs.
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { findCodexRollout, codexHome } from '../codexRollout.js';
import { findTranscriptFile } from '../extractPreviousAnswer.js';
import { planCliOf, type CliHints } from '../planUsageCodec.js';

/** The CLIs whose conversation AASC can read from disk. */
export type TranscriptCli = 'claude' | 'codex';

/**
 * Which CLI's transcript a session has, or null for anything else. An explicit `cliSource` decides
 * (an unknown one, e.g. a Gemini session, means none); without it, the same launch-command / model /
 * event hints the plan-usage chip uses.
 */
export function transcriptCliOf(session: CliHints): TranscriptCli | null {
  const explicit = typeof session.cliSource === 'string' ? session.cliSource.trim().toLowerCase() : '';
  if (explicit === 'claude' || explicit === 'codex') return explicit;
  if (explicit) return null;
  return planCliOf(session);
}

/** What the locator reads of a session. Structural, so a full Session satisfies it. */
export interface LocatorSession extends CliHints {
  sessionId: string;
  projectPath?: string | null;
  transcriptPath?: string | null;
  sshHost?: string | null;
}

export interface TranscriptLocation {
  cli: TranscriptCli;
  path: string;
}

export interface LocateOptions {
  now?: () => number;
}

/**
 * How long "no file yet" is believed: a Codex miss walks every day folder, a Claude miss every
 * projects folder, and a new session's chat is read several times a second.
 */
const MISS_TTL_MS = 10_000;
const CACHE_MAX = 256;
type LookupCache = Map<string, { path: string | null; at: number }>;
const codexCache: LookupCache = new Map();
const claudeMovedCache: LookupCache = new Map();

/** Forget remembered lookups (tests, and nothing else). */
export function resetTranscriptLocatorCache(): void {
  codexCache.clear();
  claudeMovedCache.clear();
}

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1']);

/** A session running on this Mac: an SSH session's files are on the other machine. */
const isLocalSession = (s: LocatorSession): boolean => LOCAL_HOSTS.has((s.sshHost ?? '').trim().toLowerCase());

async function isFile(path: string, follow: boolean): Promise<boolean> {
  try {
    return (await (follow ? stat(path) : lstat(path))).isFile();
  } catch {
    return false;
  }
}

/** Where Claude Code keeps transcripts: ~/.claude/projects, and $CLAUDE_CONFIG_DIR/projects when set. */
function claudeProjectRoots(): string[] {
  const home = homedir();
  const roots = [join(home, '.claude', 'projects')];
  const configDir = (process.env.CLAUDE_CONFIG_DIR ?? '').trim();
  if (configDir) roots.push(join(configDir === '~' || configDir.startsWith('~/') ? join(home, configDir.slice(1)) : configDir, 'projects'));
  return roots;
}

async function realOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * The hook-reported transcript, when it is a .jsonl file inside a Claude projects folder once links
 * are followed. A path anywhere else (the hook queue, another tool's log) is never a conversation a
 * phone may read, whatever a hook payload said.
 */
async function reportedTranscript(recorded: string | null | undefined): Promise<string | null> {
  if (!recorded || !recorded.endsWith('.jsonl')) return null;
  const real = await realOrNull(recorded);
  if (!real || !(await isFile(real, false))) return null;
  for (const root of claudeProjectRoots()) {
    const realRoot = await realOrNull(root);
    if (realRoot && real.startsWith(realRoot + sep)) return recorded;
  }
  return null;
}

/** A lookup remembered by key: a hit while its file is still there, a miss for MISS_TTL_MS. */
async function remembered(
  cache: LookupCache,
  key: string,
  now: () => number,
  find: () => Promise<string | null>,
): Promise<string | null> {
  const known = cache.get(key);
  if (known?.path && (await isFile(known.path, false))) return known.path;
  if (known && !known.path && now() - known.at < MISS_TTL_MS) return null;
  const path = await find();
  cache.delete(key);
  cache.set(key, { path, at: now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return path;
}

/** A session id that can only name a file, never a path. */
const SESSION_FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * `<sessionId>.jsonl` in any projects folder: `EnterWorktree` moves a running session's file into
 * the worktree's folder. Named by the session's own id, so it is still its own conversation; a link
 * is never followed out of the root.
 */
async function findMovedClaude(sessionId: string): Promise<string | null> {
  for (const root of claudeProjectRoots()) {
    let folders: string[];
    try {
      folders = await readdir(root);
    } catch {
      continue;
    }
    for (const folder of folders) {
      const file = join(root, folder, `${sessionId}.jsonl`);
      if (await isFile(file, false)) return file;
    }
  }
  return null;
}

async function locateClaude(s: LocatorSession, now: () => number): Promise<string | null> {
  const reported = await reportedTranscript(s.transcriptPath);
  if (reported) return reported;
  const inLaunchFolder = s.projectPath ? findTranscriptFile(s.sessionId, s.projectPath) : null;
  if (inLaunchFolder || !SESSION_FILE_ID_RE.test(s.sessionId)) return inLaunchFolder;
  const key = `${claudeProjectRoots().join('\0')}\0${s.sessionId}`;
  return remembered(claudeMovedCache, key, now, () => findMovedClaude(s.sessionId));
}

async function locateCodex(s: LocatorSession, now: () => number): Promise<string | null> {
  const root = codexHome();
  return remembered(codexCache, `${root}\0${s.sessionId}`, now, () => findCodexRollout(s.sessionId, root));
}

/** The file holding this session's conversation, or null when AASC can't read one from this disk. */
export async function locateTranscript(session: LocatorSession, opts: LocateOptions = {}): Promise<TranscriptLocation | null> {
  const cli = transcriptCliOf(session);
  if (!cli || !isLocalSession(session)) return null;
  const now = opts.now ?? Date.now;
  const path = cli === 'claude' ? await locateClaude(session, now) : await locateCodex(session, now);
  return path ? { cli, path } : null;
}
