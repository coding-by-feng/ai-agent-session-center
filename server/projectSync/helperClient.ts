/**
 * Talks to the project helper (projectHelper.ts) over a child process — locally or
 * through pinned SSH. Frames go in on stdin, one JSON reply per line comes back.
 * Nothing is buffered whole: manifests stream in, file bytes stream out in 1 MiB frames.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { constants } from 'fs';
import { open, realpath } from 'fs/promises';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { PROJECT_HELPER } from './projectHelper.js';
import type { ApplyOp, Manifest, ManifestEntry } from './classify.js';
import type { FileMeta, SyncKind } from '../../src/types/projectSync.js';

export interface HelperProcess {
  child: ChildProcessWithoutNullStreams;
  cleanup: () => Promise<void>;
}
export type Launcher = () => Promise<HelperProcess>;

const CHUNK = 1024 * 1024;
const IDLE_MS = 60_000;
/** A reply line longer than this, or a manifest larger than MAX_ENTRIES, is a misbehaving device. */
const MAX_LINE = 1024 * 1024;
const MAX_ENTRIES = 500_000;

/** The helper on this machine. Under Electron, process.execPath is Electron, which runs as Node with this flag. */
export function localLauncher(env: NodeJS.ProcessEnv = process.env): Launcher {
  return async () => ({
    child: spawn(process.execPath, ['-e', PROJECT_HELPER], {
      env: { ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    cleanup: async () => {},
  });
}

class HelperSession {
  private timer: NodeJS.Timeout | undefined;
  private stderr = '';
  private exited: Promise<number | null>;
  timedOut = false;
  constructor(private proc: HelperProcess) {
    const { child } = proc;
    child.stderr.on('data', (b: Buffer) => {
      if (this.stderr.length < 2000) this.stderr += b.toString('utf8');
    });
    child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', () => resolve(-1));
    });
    this.touch();
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.proc.child.kill('SIGTERM');
    }, IDLE_MS);
  }
  async write(type: 'J' | 'D', payload: Buffer | object): Promise<void> {
    const body = type === 'J' ? Buffer.from(JSON.stringify(payload)) : (payload as Buffer);
    const head = Buffer.alloc(5);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(body.length, 1);
    const stdin = this.proc.child.stdin;
    if (stdin.destroyed || !stdin.writable) throw new Error('The helper stopped.');
    const ok = stdin.write(Buffer.concat([head, body]));
    if (!ok)
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          cleanup();
          reject(new Error('The helper stopped.'));
        };
        const cleanup = () => {
          stdin.off('drain', onDrain);
          this.proc.child.off('close', onClose);
        };
        stdin.on('drain', onDrain);
        this.proc.child.on('close', onClose);
      });
    this.touch();
  }
  end() {
    this.proc.child.stdin.end();
  }
  async *lines(): AsyncGenerator<Record<string, unknown>> {
    const rl = createInterface({ input: this.proc.child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      this.touch();
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) {
        this.proc.child.kill('SIGTERM');
        throw new Error('The helper sent an oversized reply.');
      }
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line);
      } catch {
        this.proc.child.kill('SIGTERM');
        throw new Error(
          'The helper sent an invalid reply. Node.js 18+ is required on the device, and its shell must print nothing for non-interactive SSH.',
        );
      }
      yield value;
    }
  }
  async close(): Promise<void> {
    await this.exited;
    clearTimeout(this.timer);
    await this.proc.cleanup();
  }
  kill() {
    this.proc.child.kill('SIGTERM');
  }
  problem(fallback: string): Error {
    if (this.timedOut) return new Error('The device stopped responding. Try again.');
    return new Error(fallback);
  }
}

async function session(launch: Launcher) {
  return new HelperSession(await launch());
}

const KIND: Record<string, SyncKind> = { f: 'file', d: 'dir', l: 'symlink', o: 'other' };

function entryOf(row: Record<string, unknown>): [string, ManifestEntry] | null {
  const kind = KIND[String(row.k)];
  if (typeof row.p !== 'string' || !kind) return null;
  const e: ManifestEntry = {
    kind,
    size: Number(row.s) || 0,
    mtimeMs: Number(row.m) || 0,
    mode: Number(row.mo) || 0,
  };
  if (typeof row.h === 'string' && /^[a-f0-9]{64}$/.test(row.h)) e.sha256 = row.h;
  if (typeof row.t === 'string') e.linkTarget = row.t;
  if (typeof row.x === 'string') e.text = row.x;
  return [row.p, e];
}

/** One-shot request: send a header, read lines until `done`, surface `fatal`. */
async function requestDone(
  launch: Launcher,
  header: object,
  onLine?: (line: Record<string, unknown>) => void,
  extra?: (s: HelperSession) => Promise<void>,
): Promise<Record<string, unknown>> {
  const s = await session(launch);
  let done: Record<string, unknown> | null = null;
  let fatal: string | null = null;
  const reading = (async () => {
    for await (const line of s.lines()) {
      if (typeof line.fatal === 'string') fatal = line.fatal;
      else if (line.done) done = line;
      else onLine?.(line);
    }
  })();
  reading.catch(() => {}); // awaited below; only prevents an early "unhandled" report
  try {
    await s.write('J', header);
    if (extra) await extra(s);
    s.end();
    await reading;
  } catch (e) {
    s.kill();
    await reading.catch(() => {});
    await s.close().catch(() => {});
    throw fatal ? new Error(fatal) : e;
  }
  await s.close();
  if (fatal) throw new Error(fatal);
  if (!done)
    throw s.problem(
      'The helper stopped before finishing. Check SSH access and Node.js 18+ on the device.',
    );
  return done;
}

export async function probe(launch: Launcher) {
  const r = await requestDone(launch, { op: 'probe' });
  return { home: String(r.home), platform: String(r.platform), node: String(r.node) };
}

export async function readManifest(
  launch: Launcher,
  req: { root: string; excludes: string[]; base: Map<string, FileMeta>; inHome?: boolean },
): Promise<{ manifest: Manifest; missing: boolean }> {
  const manifest: Manifest = new Map();
  let overflow = false;
  const r = await requestDone(
    launch,
    { op: 'manifest', root: req.root, excludes: req.excludes, inHome: req.inHome === true },
    (line) => {
      const e = entryOf(line);
      if (!e) return;
      if (manifest.size >= MAX_ENTRIES && !manifest.has(e[0])) overflow = true;
      else manifest.set(e[0], e[1]);
    },
    async (s) => {
      let batch: unknown[] = [];
      for (const [p, m] of req.base) {
        if (m.kind !== 'file' || !m.sha256) continue;
        batch.push([p, m.size, m.mtimeMs, m.mode, m.sha256]);
        if (batch.length === 2000) {
          await s.write('J', { base: batch });
          batch = [];
        }
      }
      if (batch.length) await s.write('J', { base: batch });
      await s.write('J', { end: true });
    },
  );
  if (overflow)
    throw new Error('More than 500,000 entries. Add exclude patterns or split the project.');
  return { manifest, missing: r.missing === true };
}

export interface Ack {
  id: string;
  state: 'done' | 'failed' | 'skipped';
  error?: string;
}
export interface ApplyHooks {
  onAck: (ack: Ack) => void;
  onSent?: (bytes: number) => void;
  cancelled: () => boolean;
}

const expectOf = (m: FileMeta | null) =>
  m ? { kind: m.kind, mode: m.mode, sha256: m.sha256, linkTarget: m.linkTarget } : null;

/** Stream one local file after checking it is still the file the plan saw. */
async function sendFile(s: HelperSession, localRoot: string, op: ApplyOp, hooks: ApplyHooks) {
  const meta = op.meta!;
  let fh;
  try {
    const abs = join(localRoot, op.path);
    if ((await realpath(dirname(abs))) !== dirname(abs)) throw new Error('parent is a link');
    fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    hooks.onAck({
      id: op.entryId,
      state: 'failed',
      error: 'It is gone on this machine. Compare again.',
    });
    return;
  }
  try {
    const st = await fh.stat();
    if (
      !st.isFile() ||
      st.size !== meta.size ||
      Math.abs(Math.floor(st.mtimeMs) - meta.mtimeMs) > 1
    ) {
      hooks.onAck({
        id: op.entryId,
        state: 'failed',
        error: 'Changed on this machine since compare. Compare again.',
      });
      return;
    }
    await s.write('J', {
      e: {
        id: op.entryId,
        op: 'put',
        kind: 'file',
        path: op.path,
        mode: meta.mode,
        m: meta.mtimeMs,
        size: meta.size,
        sha: meta.sha256,
        expect: expectOf(op.expect),
      },
    });
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let intact = true;
    try {
      while (pos < meta.size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, meta.size - pos), pos);
        if (!bytesRead) break;
        await s.write('D', Buffer.from(buf.subarray(0, bytesRead)));
        pos += bytesRead;
        hooks.onSent?.(bytesRead);
      }
      const after = await fh.stat();
      intact = pos === meta.size && after.size === st.size && after.mtimeMs === st.mtimeMs;
    } catch (e) {
      if (e instanceof Error && e.message === 'The helper stopped.') throw e;
      intact = false; // a local read error: only this file fails
    }
    await s.write('J', intact ? { commit: true } : { abort: true });
  } finally {
    await fh.close();
  }
}

/** The repository (`…/.git`) a path belongs to, or null. */
export function repoOfPath(path: string): string | null {
  const parts = path.split('/');
  const i = parts.lastIndexOf('.git');
  return i === -1 ? null : parts.slice(0, i + 1).join('/');
}
/** Refs, HEAD, index and deletes must not run past a failed object write in their repository. */
export function isRepoBarrier(op: ApplyOp): boolean {
  if (op.op === 'delete') return true;
  const repo = repoOfPath(op.path);
  if (!repo || op.meta?.kind === 'dir') return false;
  const inner = op.path.slice(repo.length + 1);
  return (
    inner === 'packed-refs' || inner.startsWith('refs/') || inner === 'HEAD' || inner === 'index'
  );
}

export async function applyOps(
  launch: Launcher,
  header: { root: string; linkId: string; runId: string },
  localRoot: string,
  ops: ApplyOp[],
  hooks: ApplyHooks,
): Promise<void> {
  const s = await session(launch);
  let fatal: string | null = null,
    done = false,
    stopped = false;
  // Per repository: entries sent but not yet acknowledged, and whether one failed.
  const repoOf = new Map(ops.map((o) => [o.entryId, repoOfPath(o.path)]));
  const inFlight = new Map<string, Set<string>>();
  const repoFailed = new Set<string>();
  let wake: (() => void) | null = null;
  const ack = (a: Ack) => {
    const repo = repoOf.get(a.id);
    if (repo) {
      inFlight.get(repo)?.delete(a.id);
      if (a.state === 'failed') repoFailed.add(repo);
    }
    hooks.onAck(a);
    wake?.();
  };
  const settled = async (repo: string) => {
    while ((inFlight.get(repo)?.size ?? 0) > 0 && !stopped)
      await new Promise<void>((resolve) => (wake = resolve));
  };
  const reading = (async () => {
    for await (const line of s.lines()) {
      if (typeof line.fatal === 'string') fatal = line.fatal;
      else if (line.done) done = true;
      else if (typeof line.id === 'string')
        ack({
          id: line.id,
          state: line.state === 'done' || line.state === 'skipped' ? line.state : 'failed',
          ...(typeof line.error === 'string' ? { error: line.error } : {}),
        });
    }
  })().finally(() => {
    stopped = true;
    wake?.();
  });
  reading.catch(() => {}); // awaited below; this only keeps an early failure from being "unhandled"
  const local: ApplyHooks = { ...hooks, onAck: ack };
  let writeError: unknown = null;
  try {
    await s.write('J', { op: 'apply', ...header });
    for (const op of ops) {
      if (hooks.cancelled() || stopped) break;
      const repo = repoOf.get(op.entryId) ?? null;
      if (repo && isRepoBarrier(op)) {
        await settled(repo);
        if (stopped) break;
        if (repoFailed.has(repo)) {
          ack({
            id: op.entryId,
            state: 'failed',
            error:
              'Not applied: an earlier write in this repository failed. Retry after fixing it.',
          });
          continue;
        }
      }
      if (repo) {
        const set = inFlight.get(repo) ?? new Set<string>();
        set.add(op.entryId);
        inFlight.set(repo, set);
      }
      if (op.op === 'put' && op.meta?.kind === 'file') await sendFile(s, localRoot, op, local);
      else if (op.op === 'put')
        await s.write('J', {
          e: {
            id: op.entryId,
            op: 'put',
            kind: op.meta!.kind,
            path: op.path,
            mode: op.meta!.mode,
            ...(op.meta!.kind === 'symlink' ? { target: op.meta!.linkTarget } : {}),
            expect: expectOf(op.expect),
          },
        });
      else
        await s.write('J', {
          e: { id: op.entryId, op: 'delete', path: op.path, expect: expectOf(op.expect) },
        });
    }
    if (!stopped) await s.write('J', { finish: true });
  } catch (e) {
    // Usually the helper already stopped; its own reason (fatal) arrives on the reader.
    writeError = e;
  }
  s.end();
  await reading.catch((e) => {
    writeError ??= e;
  });
  await s.close();
  if (fatal) throw new Error(fatal);
  if (!done)
    throw writeError instanceof Error && !s.timedOut
      ? writeError
      : s.problem(
          'The device connection ended before the run finished. Retry continues where it stopped.',
        );
}

export async function undoRun(
  launch: Launcher,
  header: { root: string; linkId: string; runId: string },
): Promise<{ restored: number; skipped: number }> {
  const r = await requestDone(launch, { op: 'undo', ...header });
  return { restored: Number(r.restored) || 0, skipped: Number(r.skipped) || 0 };
}

export async function readText(
  launch: Launcher,
  req: { root: string; path: string; max: number; inHome?: boolean },
): Promise<Buffer | null> {
  const r = await requestDone(launch, { op: 'read', ...req });
  return typeof r.data === 'string' ? Buffer.from(r.data, 'base64') : null;
}
