/**
 * @module instanceLock
 * The two single-instance locks taken in startServer() (startupGuard.ts):
 *
 * - the FOLDER lock, `<data folder>/server.lock`: two servers on one folder would keep two in-memory
 *   views of one sessions.db. Every edition refuses a live holder.
 * - the MACHINE lock, `<hook queue folder>/server.lock`: every server on a machine reads the same hook
 *   queue, so two would both build cards from the same events. Only a headless server refuses on it.
 *
 * A lock is a small JSON record. Its holder is live while the pid exists and either the server is
 * still starting (no `listening` yet, inside STARTUP_GRACE_MS of `startedAt`) or something answers on
 * the address it bound. Anything else is stale and is taken over.
 *
 * Creation is `open(…, 'wx')`, so of two servers starting together only one creates the file. A
 * takeover runs under a second `wx` file, `<lock>.takeover`, and removes the old lock only if it is
 * still byte-for-byte the one judged stale: without that, a slow second taker would delete the fresh
 * lock the first one had just written.
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, lstatSync, mkdirSync, chmodSync, writeFileSync, renameSync } from 'fs';
import { connect } from 'net';
import { z } from 'zod';

const LockRecordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(0).max(65535),
  edition: z.enum(['headless', 'desktop', 'dev']),
  startedAt: z.number(),
  dataDir: z.string(),
  /** Set once the server listens; until then a live pid counts as starting. */
  listening: z.boolean().optional(),
  /** The address the server bound, so a non-loopback bind is probed where it listens. */
  bindAddress: z.string().optional(),
});

export type LockRecord = z.infer<typeof LockRecordSchema>;
export type Edition = LockRecord['edition'];

export type AcquireResult = { acquired: true } | { acquired: false; holder: LockRecord };

/** How long a live pid that hasn't listened yet still counts as a server starting up. */
export const STARTUP_GRACE_MS = 60_000;
/** How long a port probe waits before calling the port silent. */
const PORT_PROBE_TIMEOUT_MS = 1000;
/** A takeover sentinel older than this, or whose pid is gone, was left by a crash. */
const TAKEOVER_STALE_MS = 10_000;
/** How long acquireLock waits for another process's takeover to finish. */
const TAKEOVER_WAIT_MS = 5_000;
const TAKEOVER_POLL_MS = 25;

const SentinelSchema = z.object({ pid: z.number().int().positive(), at: z.number() });

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseLock(text: string | null): LockRecord | null {
  if (text === null) return null;
  try {
    const parsed = LockRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The record in `path`, or null when it is missing or unreadable (an unreadable lock is stale). */
export function readLock(path: string): LockRecord | null {
  return parseLock(readText(path));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Where to probe a server that bound `bindAddress`: loopback for a wildcard bind. */
export function probeHost(bindAddress: string | undefined): string {
  if (!bindAddress || bindAddress === '0.0.0.0' || bindAddress === '::') return '127.0.0.1';
  return bindAddress;
}

function portAnswers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (answered: boolean): void => {
      socket.destroy();
      resolve(answered);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Is the server that wrote `record` still running? */
export async function isLockLive(record: LockRecord, now: number = Date.now()): Promise<boolean> {
  if (!pidAlive(record.pid)) return false;
  if (!record.listening && now - record.startedAt < STARTUP_GRACE_MS) return true;
  return portAnswers(record.port, probeHost(record.bindAddress));
}

function createExclusive(path: string, contents: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

const serialize = (record: LockRecord): string => `${JSON.stringify(record)}\n`;

/** Take `<lock>.takeover`, clearing one left by a dead or long-gone taker. False while another holds it. */
function takeSentinel(sentinel: string): boolean {
  try {
    createExclusive(sentinel, JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let holder: z.infer<typeof SentinelSchema> | null = null;
  try {
    const parsed = SentinelSchema.safeParse(JSON.parse(readText(sentinel) ?? ''));
    holder = parsed.success ? parsed.data : null;
  } catch { /* unreadable: stale */ }
  if (holder && pidAlive(holder.pid) && Date.now() - holder.at < TAKEOVER_STALE_MS) return false;
  try { unlinkSync(sentinel); } catch { /* another taker cleared it */ }
  return false;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Create the lock, or report the live server holding it. A stale holder, an unreadable file or a
 * record naming the caller's own pid (a restart inside one process) is replaced.
 */
export async function acquireLock(
  path: string,
  record: LockRecord,
  { isLive = (h: LockRecord) => isLockLive(h) }: { isLive?: (holder: LockRecord) => Promise<boolean> } = {},
): Promise<AcquireResult> {
  const sentinel = `${path}.takeover`;
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while (true) {
    try {
      createExclusive(path, serialize(record));
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const judged = readText(path);
    const holder = parseLock(judged);
    if (holder && holder.pid !== record.pid && await isLive(holder)) return { acquired: false, holder };

    // Stale. Replace it under the sentinel, and only if it is still the lock judged stale.
    if (takeSentinel(sentinel)) {
      try {
        if (readText(path) === judged) {
          try { unlinkSync(path); } catch { /* already gone */ }
          createExclusive(path, serialize(record));
          return { acquired: true };
        }
      } finally {
        try { unlinkSync(sentinel); } catch { /* already gone */ }
      }
      // It changed under us: another server wrote it. Judge the new one.
      continue;
    }
    if (Date.now() > deadline) {
      const now = readLock(path);
      if (now) return { acquired: false, holder: now };
      throw new Error(`could not take the lock ${path}: another start-up holds ${sentinel}`);
    }
    await sleep(TAKEOVER_POLL_MS);
  }
}

/** After listen: record that `mine` is serving on `bindAddress`, if the lock is still mine. */
export function markLockListening(path: string, mine: LockRecord, bindAddress: string): void {
  const current = readLock(path);
  if (current?.pid !== mine.pid || current.startedAt !== mine.startedAt) return;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, serialize({ ...current, listening: true, bindAddress }), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Remove the lock if it still names `pid`; another server's lock is left alone. */
export function releaseLock(path: string, pid: number = process.pid): void {
  if (readLock(path)?.pid !== pid) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * The hook-queue folder must be ours before a headless server trusts a lock in it: another local user
 * who created /tmp/claude-session-center first could plant a "live" lock (a permanent refusal) and
 * read every hook event. The same idea as dashboard-hook.sh's `-O` check. A missing folder is created
 * 0700; our own folder with a looser mode (dashboard-statusline.sh's `mkdir -p` makes it 0755) is
 * tightened. Returns why the folder is refused, or null when it is fine.
 */
export function checkQueueDirOwnership(dir: string, { uid }: { uid: number | null }): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return `cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) return `${dir} is a symlink`;
  if (!stat.isDirectory()) return `${dir} is not a folder`;
  // Windows has no uids or POSIX modes to check.
  if (uid === null) return null;
  if (stat.uid !== uid) return `${dir} is owned by uid ${stat.uid}, not ${uid}`;
  if ((stat.mode & 0o777) !== 0o700) {
    try {
      chmodSync(dir, 0o700);
    } catch (err) {
      return `cannot set ${dir} to mode 0700: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}
