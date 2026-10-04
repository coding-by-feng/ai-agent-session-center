/**
 * @module planUsageSources
 * Where plan-limit observations come from on disk.
 *
 * Claude Code reports its plan limits only on the stdin of a status-line command,
 * so `hooks/dashboard-statusline.sh` writes one small snapshot per session here;
 * Codex appends them to its own rollout files, which are read in place.
 *
 * Both are polled (planUsageService.ts), so every read is gated on the file's
 * mtime and size and a rollout is only ever read from the end — one can be over
 * 100 MB. Everything is async: this runs on the loop that also serves hooks and
 * terminal output. A missing directory, an unreadable file or garbage in either
 * is "no observation", never an error.
 */
import { homedir } from 'os';
import { join } from 'path';
import { lstat, open, readdir, readFile, rm, stat } from 'fs/promises';
import type { PlanCli, PlanUsage } from '../src/types/session.js';
import log from './logger.js';
import { latestCodexUsage, parseClaudeSnapshot } from './planUsageCodec.js';
import { globalRootPaths } from './resourceRoots.js';

// Same directory the hook message queue lives in (see mqReader.ts): /tmp on
// macOS/Linux because a hook cannot predict os.tmpdir(), which is /var/folders/…
// there. The status-line script hard-codes the same path; a test keeps the two
// from drifting.
const QUEUE_DIR = process.platform === 'win32'
  ? join(process.env.TEMP || process.env.TMP || 'C:\\Temp', 'claude-session-center')
  : '/tmp/claude-session-center';

/** `<queue dir>/usage/<session-id>.json`, one per Claude session the status-line script has seen. */
export const USAGE_DIR = join(QUEUE_DIR, 'usage');

/** A snapshot nobody has touched for this long is from a session that is long gone. */
export const CLAUDE_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** A real snapshot is a few hundred bytes. */
const MAX_SNAPSHOT_BYTES = 64 * 1024;
/** What the status-line script may name a file: `[A-Za-z0-9_-]{1,64}.json`. */
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.json$/;

/**
 * How many of the newest `sessions/YYYY/MM/DD` folders are walked. A rollout lives in
 * the folder of the day its session BEGAN and a long-lived session keeps appending to
 * it for weeks, so the folders cannot be limited to the recent ones (one on a real
 * install was still being written three weeks after its folder's day). Only files are
 * stat'ed here; the few most recently written are the only ones read.
 */
export const CODEX_MAX_DAY_DIRS = 366;
/** How many of the most recently written rollouts are read. */
const CODEX_TOP_FILES = 6;
/** How much of a rollout's end is read, widening when the newest limits are buried under output. */
const CODEX_TAIL_STEPS: readonly number[] = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
const ROLLOUT_NAME_RE = /^rollout-.*\.jsonl$/;

/** One place plan limits can be read from. `read` returns every observation currently on disk. */
export interface UsageSource {
  cli: PlanCli;
  read(now?: number): Promise<PlanUsage[]>;
}

interface Cached {
  mtimeMs: number;
  size: number;
  usage: PlanUsage | null;
}

const sameFile = (hit: Cached | undefined, mtimeMs: number, size: number): hit is Cached =>
  !!hit && hit.mtimeMs === mtimeMs && hit.size === size;

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** Is this ours: owned by the user this server runs as? (Where there are no uids — Windows — everything is.) */
const ownedByUs = (st: { uid: number }): boolean => typeof process.getuid !== 'function' || st.uid === process.getuid();

type DirectoryVerdict = { ok: true } | { ok: false; reason: string | null };

/**
 * May the usage directory be read — and, above all, swept? It lives under /tmp, shared
 * ground, and the sweep DELETES old files, so it must be a real directory (not a symlink
 * that leads the sweep into someone's project), owned by this user and not writable by
 * anyone else. The status-line script makes it `0700`. A directory that is simply not
 * there yet is the normal state before the first snapshot and says nothing (`reason: null`).
 */
async function checkUsageDirectory(dir: string): Promise<DirectoryVerdict> {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return { ok: false, reason: null };
  }
  if (!st.isDirectory()) return { ok: false, reason: 'it is not a plain directory (a symlink, or a file)' };
  if (!ownedByUs(st)) return { ok: false, reason: 'it is owned by another user' };
  if (process.platform !== 'win32' && (st.mode & 0o022) !== 0) return { ok: false, reason: 'it is writable by other users' };
  return { ok: true };
}

export function createClaudeSnapshotSource(dir: string = USAGE_DIR): UsageSource {
  const cache = new Map<string, Cached>();
  let warned = false;

  return {
    cli: 'claude',
    async read(now = Date.now()) {
      const verdict = await checkUsageDirectory(dir);
      if (!verdict.ok) {
        cache.clear();
        if (verdict.reason && !warned) {
          warned = true;
          log.warn('plan-usage', `not reading ${dir}: ${verdict.reason}`);
        }
        return [];
      }

      const found: PlanUsage[] = [];
      const seen = new Set<string>();

      for (const name of await namesIn(dir)) {
        if (!SNAPSHOT_NAME_RE.test(name)) continue;
        const path = join(dir, name);
        let st;
        try {
          // lstat: a symlink in here is not ours, and must not lead a read elsewhere.
          st = await lstat(path);
        } catch {
          continue;
        }
        // A file another user left here is neither read nor swept.
        if (!st.isFile() || !ownedByUs(st)) continue;
        if (now - st.mtimeMs > CLAUDE_SNAPSHOT_MAX_AGE_MS) {
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        if (st.size > MAX_SNAPSHOT_BYTES) continue;

        seen.add(path);
        const hit = cache.get(path);
        let usage: PlanUsage | null;
        if (sameFile(hit, st.mtimeMs, st.size)) {
          usage = hit.usage;
        } else {
          const raw = await readFile(path, 'utf8').catch(() => '');
          usage = parseClaudeSnapshot(raw);
          cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, usage });
        }
        if (usage) found.push(usage);
      }

      for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

interface Rollout {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Folder names of one fixed-width numeric kind, newest first (lexicographic order is numeric order). */
const newestFirst = (names: string[], shape: RegExp): string[] =>
  names.filter((n) => shape.test(n)).sort().reverse();

/** The most recently WRITTEN rollouts under `<root>/sessions/YYYY/MM/DD` — in any of the `maxDayDirs` newest folders. */
async function recentRollouts(root: string, maxDayDirs: number): Promise<Rollout[]> {
  const base = join(root, 'sessions');
  const days: string[] = [];
  collect: for (const year of newestFirst(await namesIn(base), /^\d{4}$/)) {
    for (const month of newestFirst(await namesIn(join(base, year)), /^\d{2}$/)) {
      for (const day of newestFirst(await namesIn(join(base, year, month)), /^\d{2}$/)) {
        days.push(join(base, year, month, day));
        if (days.length >= maxDayDirs) break collect;
      }
    }
  }

  const files: Rollout[] = [];
  for (const dir of days) {
    for (const name of await namesIn(dir)) {
      if (!ROLLOUT_NAME_RE.test(name)) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        if (st.isFile()) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, CODEX_TOP_FILES);
}

/** The last `bytes` of a file as text, without the line the cut may have split. */
async function readTail(path: string, size: number, bytes: number): Promise<string> {
  const length = Math.min(size, bytes);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8', 0, bytesRead);
    if (size <= length) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } finally {
    await handle.close();
  }
}

async function usageFromRollout(file: Rollout): Promise<PlanUsage | null> {
  const fallbackAsOf = Math.round(file.mtimeMs);
  for (const bytes of CODEX_TAIL_STEPS) {
    const usage = latestCodexUsage(await readTail(file.path, file.size, bytes), fallbackAsOf);
    if (usage) return usage;
    if (bytes >= file.size) break;
  }
  return null;
}

export function createCodexRolloutSource(
  codexRoot: string = globalRootPaths(process.env, homedir()).codexRoot,
  options: { maxDayDirs?: number } = {},
): UsageSource {
  const maxDayDirs = options.maxDayDirs ?? CODEX_MAX_DAY_DIRS;
  const cache = new Map<string, Cached>();

  return {
    cli: 'codex',
    async read() {
      const files = await recentRollouts(codexRoot, maxDayDirs);
      const found: PlanUsage[] = [];
      const keep = new Set<string>();

      for (const file of files) {
        keep.add(file.path);
        const hit = cache.get(file.path);
        let usage: PlanUsage | null;
        if (sameFile(hit, file.mtimeMs, file.size)) {
          usage = hit.usage;
        } else {
          usage = await usageFromRollout(file).catch(() => null);
          cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, usage });
        }
        if (usage) found.push(usage);
      }

      for (const key of [...cache.keys()]) if (!keep.has(key)) cache.delete(key);
      return found;
    },
  };
}
