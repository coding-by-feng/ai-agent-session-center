/**
 * @module sessionRuntimeWatch
 * Feeds `sessionRuntime.ts` its two reports as they change:
 *
 * - the status-line snapshots in `<queue>/runtime/` (one fs.watch on the directory,
 *   written by `hooks/dashboard-statusline.sh`), and
 * - each live session's transcript, Claude's or Codex's rollout (one fs.watch per file,
 *   re-synced from the session list rather than tied to the many teardown paths a session has).
 *
 * Each transcript read also says whether the user stopped the newest turn (Esc, a declined
 * tool), which no hook reports (`stoppedTurn`, transcriptInterrupt.ts).
 *
 * The directory is shared /tmp ground: it is read only while it passes the same check
 * as the plan-usage directory (`checkUsageDirectory`: a real directory, ours, not
 * writable by others), and each file is `lstat`ed, size-capped and name-checked first.
 */
import { watch as fsWatch, type FSWatcher } from 'fs';
import { lstat, readFile, readdir, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import log from './logger.js';
import { USAGE_DIR, checkUsageDirectory } from './planUsageSources.js';
import { readTranscriptTail, stoppedTurn, type StoppedTurn } from './transcriptInterrupt.js';
import { readingFromStatusLine, readingFromTranscript, type RuntimeReading } from './sessionRuntime.js';

/** `<queue dir>/runtime/<session-id>.json` — beside `usage/`, same hard-coded path as the tap.
 *  `AASC_RUNTIME_DIR` exists only so tests never read this machine's real directory. */
export const RUNTIME_DIR = process.env.AASC_RUNTIME_DIR || join(dirname(USAGE_DIR), 'runtime');
/** Enough for the last few turns; a `/model` older than this was already applied when it happened. */
export const RUNTIME_TAIL_BYTES = 64 * 1024;
/** Coalesces a burst of writes (a streaming reply appends many lines) into one read. */
export const RUNTIME_READ_DEBOUNCE_MS = 200;
/** How often a directory that was missing or refused is looked at again. */
export const RUNTIME_DIR_RETRY_MS = 10_000;
/** A snapshot nobody touched for this long belongs to a session that is long gone. */
export const RUNTIME_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** A real snapshot is ~200 bytes. */
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.json$/;

export interface RuntimeWatchHost {
  /** A status-line snapshot, keyed by the session id it was written for. */
  applyToSession(sessionId: string, reading: RuntimeReading): void;
  /** A transcript reading, for every live session that writes this transcript. */
  applyToTranscript(path: string, reading: RuntimeReading): void;
  /** This transcript's newest turn was stopped by the user, reported on every read that still sees it. */
  applyToStoppedTurn?(path: string, stopped: StoppedTurn): void;
}

export interface RuntimeWatch {
  start(): void;
  stop(): void;
  /** Track exactly these transcripts; also retries a missing runtime directory now and then. */
  syncTranscripts(paths: Iterable<string>, options?: { retryDirNow?: boolean }): void;
}

export function createRuntimeWatch(
  host: RuntimeWatchHost,
  options: { dir?: string; watch?: typeof fsWatch; debounceMs?: number; tailBytes?: number } = {},
): RuntimeWatch {
  const dir = options.dir ?? RUNTIME_DIR;
  const watchFn = options.watch ?? fsWatch;
  const debounceMs = options.debounceMs ?? RUNTIME_READ_DEBOUNCE_MS;
  const tailBytes = options.tailBytes ?? RUNTIME_TAIL_BYTES;

  let running = false;
  let dirWatcher: FSWatcher | null = null;
  let dirSetupInFlight = false;
  /** A retry asked for while a check was already running: run one more when it ends. */
  let dirRetryQueued = false;
  let lastDirAttempt = 0;
  let dirRefusalLogged: string | null = null;
  const transcripts = new Map<string, FSWatcher>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const debounce = (key: string, fn: () => Promise<void>): void => {
    if (!running) return;
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      timers.delete(key);
      if (running) void fn().catch(() => undefined);
    }, debounceMs);
    timer.unref?.();
    timers.set(key, timer);
  };

  // ---- Status-line snapshots ------------------------------------------------

  async function readSnapshot(name: string): Promise<void> {
    // Re-checked on every read: the directory could have been swapped for a symlink since.
    if (!(await checkUsageDirectory(dir)).ok) return;
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return;
    if (Date.now() - st.mtimeMs > RUNTIME_SNAPSHOT_MAX_AGE_MS) {
      await unlink(path).catch(() => undefined);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return; // half-written files never appear (temp + rename); anything else is not ours
    }
    const reading = readingFromStatusLine(parsed);
    if (reading) host.applyToSession(name.slice(0, -'.json'.length), reading);
  }

  const scheduleSnapshot = (name: string | null): void => {
    if (!name || !SNAPSHOT_NAME_RE.test(name)) return;
    debounce(`snap:${name}`, () => readSnapshot(name));
  };

  async function setUpDir(): Promise<void> {
    if (dirWatcher || !running) return;
    if (dirSetupInFlight) {
      dirRetryQueued = true;
      return;
    }
    dirSetupInFlight = true;
    lastDirAttempt = Date.now();
    try {
      const verdict = await checkUsageDirectory(dir);
      if (!verdict.ok) {
        if (verdict.reason && dirRefusalLogged !== verdict.reason) {
          dirRefusalLogged = verdict.reason;
          log.warn('session-runtime', `not reading ${dir}: ${verdict.reason}`);
        }
        return;
      }
      if (!running || dirWatcher) return;
      const watcher = watchFn(dir, (_event, filename) => scheduleSnapshot(filename ? String(filename) : null));
      watcher.on('error', () => {
        watcher.close();
        if (dirWatcher === watcher) dirWatcher = null;
      });
      dirWatcher = watcher;
      for (const name of await readdir(dir).catch(() => [] as string[])) scheduleSnapshot(name);
    } catch {
      // fs.watch can throw (the directory vanished between the check and the watch): retried later.
    } finally {
      dirSetupInFlight = false;
      if (dirRetryQueued) {
        dirRetryQueued = false;
        void setUpDir();
      }
    }
  }

  // ---- Transcripts -----------------------------------------------------------

  async function readTranscript(path: string): Promise<void> {
    if (!transcripts.has(path)) return;
    const lines = await readTranscriptTail(path, tailBytes);
    if (!lines || !transcripts.has(path)) return;
    const reading = readingFromTranscript(lines);
    if (reading.modelAt !== undefined || reading.effortAt !== undefined) host.applyToTranscript(path, reading);
    const stopped = stoppedTurn(lines);
    if (stopped) host.applyToStoppedTurn?.(path, stopped);
  }

  const dropTranscript = (path: string): void => {
    transcripts.get(path)?.close();
    transcripts.delete(path);
    const pending = timers.get(`tx:${path}`);
    if (pending) clearTimeout(pending);
    timers.delete(`tx:${path}`);
  };

  function trackTranscript(path: string): void {
    // Only Claude's own .jsonl transcripts — the path arrives in a hook payload.
    if (!path.endsWith('.jsonl') || transcripts.has(path)) return;
    let watcher: FSWatcher;
    try {
      watcher = watchFn(path, (event) => {
        // A replaced file is a different inode: let the next sync watch the new one.
        if (event === 'rename') dropTranscript(path);
        else debounce(`tx:${path}`, () => readTranscript(path));
      });
    } catch {
      return; // not written yet (no first message): the next sync tries again
    }
    watcher.on('error', () => dropTranscript(path));
    transcripts.set(path, watcher);
    debounce(`tx:${path}`, () => readTranscript(path));
  }

  return {
    start() {
      if (running) return;
      running = true;
      void setUpDir();
    },
    stop() {
      running = false;
      dirWatcher?.close();
      dirWatcher = null;
      for (const path of [...transcripts.keys()]) dropTranscript(path);
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    syncTranscripts(paths, opts = {}) {
      if (!running) return;
      const wanted = new Set(paths);
      for (const path of [...transcripts.keys()]) if (!wanted.has(path)) dropTranscript(path);
      for (const path of wanted) trackTranscript(path);
      if (!dirWatcher && (opts.retryDirNow || Date.now() - lastDirAttempt >= RUNTIME_DIR_RETRY_MS)) void setUpDir();
    },
  };
}
