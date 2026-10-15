/**
 * @module transcriptLocator
 * The one place that decides which file holds a session's conversation (AASC-49, AASC-41).
 *
 * Claude writes `~/.claude/projects/<encoded project>/<session id>.jsonl` (the hook reports it as
 * `transcriptPath`); Codex writes a rollout under `$CODEX_HOME/sessions` that only its session id
 * finds. A session reads its OWN file or nothing: never a neighbour's "newest .jsonl" in the same
 * project, and never the other CLI's folder. Callers already fall back to the in-memory logs.
 */
import { lstat, realpath, stat } from 'node:fs/promises';
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

/** How long "this Codex session has no rollout yet" is believed: a miss walks every day folder. */
const CODEX_MISS_TTL_MS = 10_000;
const CODEX_CACHE_MAX = 256;
const codexCache = new Map<string, { path: string | null; at: number }>();

/** Forget remembered rollout lookups (tests, and nothing else). */
export function resetTranscriptLocatorCache(): void {
  codexCache.clear();
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

async function locateClaude(s: LocatorSession): Promise<string | null> {
  const reported = await reportedTranscript(s.transcriptPath);
  if (reported) return reported;
  return s.projectPath ? findTranscriptFile(s.sessionId, s.projectPath) : null;
}

async function locateCodex(s: LocatorSession, now: () => number): Promise<string | null> {
  const root = codexHome();
  const key = `${root}\0${s.sessionId}`;
  const known = codexCache.get(key);
  if (known?.path && (await isFile(known.path, false))) return known.path;
  if (known && !known.path && now() - known.at < CODEX_MISS_TTL_MS) return null;
  const path = await findCodexRollout(s.sessionId, root);
  codexCache.delete(key);
  codexCache.set(key, { path, at: now() });
  if (codexCache.size > CODEX_CACHE_MAX) codexCache.delete(codexCache.keys().next().value as string);
  return path;
}

/** The file holding this session's conversation, or null when AASC can't read one from this disk. */
export async function locateTranscript(session: LocatorSession, opts: LocateOptions = {}): Promise<TranscriptLocation | null> {
  const cli = transcriptCliOf(session);
  if (!cli || !isLocalSession(session)) return null;
  const path = cli === 'claude' ? await locateClaude(session) : await locateCodex(session, opts.now ?? Date.now);
  return path ? { cli, path } : null;
}
