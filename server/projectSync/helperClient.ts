/**
 * Talks to the project helper (projectHelper.ts) over a child process — locally or
 * through pinned SSH. Frames go in on stdin, one JSON reply per line comes back.
 * Nothing is buffered whole: manifests stream in, file bytes stream out in 1 MiB frames.
 * A two-way pull relays: the server's helper exports a file, this machine's helper applies it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { constants } from 'fs';
import { open, realpath } from 'fs/promises';
import { dirname, join } from 'path';
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
  /**
   * One JSON reply per line, read as the caller pulls: a device that floods replies waits on the
   * pipe, and a line stops at MAX_LINE bytes before its newline comes (readline held all of it).
   */
  async *lines(): AsyncGenerator<Record<string, unknown>> {
    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of this.proc.child.stdout as AsyncIterable<Buffer>) {
      this.touch();
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      for (let nl = pending.indexOf(10); nl !== -1; nl = pending.indexOf(10)) {
        const value = this.reply(pending.subarray(0, nl));
        pending = pending.subarray(nl + 1);
        if (value) yield value;
      }
      if (pending.length > MAX_LINE) throw this.refuse('The helper sent an oversized reply.');
    }
    // The helper ends every reply with a newline, so bytes left without one are a reply cut off
    // (or a session killed for going quiet): the caller's own message says what happened. Text
    // that never was a reply (a shell banner) still gets the Node.js hint.
    if (this.timedOut || pending.toString('utf8').trimStart().startsWith('{')) return;
    const last = this.reply(pending);
    if (last) yield last;
  }
  private reply(bytes: Buffer): Record<string, unknown> | null {
    if (bytes.length > MAX_LINE) throw this.refuse('The helper sent an oversized reply.');
    const line = bytes.toString('utf8');
    if (!line.trim()) return null;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw this.refuse(
        'The helper sent an invalid reply. Node.js 18+ is required on the server, and its shell must print nothing for non-interactive SSH.',
      );
    return value as Record<string, unknown>;
  }
  private refuse(message: string): Error {
    this.proc.child.kill('SIGTERM');
    return new Error(message);
  }
  async close(): Promise<void> {
    // A caller that stopped pulling (an export after `done`) leaves stdout paused with a reader
    // attached, and that holds the child's 'close' back for good. Nothing reads it from here on.
    this.proc.child.stdout.destroy();
    await this.exited;
    clearTimeout(this.timer);
    await this.proc.cleanup();
  }
  kill() {
    this.proc.child.kill('SIGTERM');
  }
  problem(fallback: string): Error {
    if (this.timedOut) return new Error('The sync stopped responding. Try again.');
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
      'The helper stopped before finishing. Check SSH access and Node.js 18+ on the server.',
    );
  return done;
}

export async function probe(launch: Launcher) {
  const r = await requestDone(launch, { op: 'probe' });
  return { home: String(r.home), platform: String(r.platform), node: String(r.node) };
}

export async function readManifest(
  launch: Launcher,
  req: {
    root: string;
    excludes: string[];
    base: Map<string, FileMeta>;
    inHome?: boolean;
    /** Only these names at the top of the folder (a pull of single files). */
    only?: string[];
  },
): Promise<{ manifest: Manifest; missing: boolean }> {
  const manifest: Manifest = new Map();
  let overflow = false;
  const r = await requestDone(
    launch,
    {
      op: 'manifest',
      root: req.root,
      excludes: req.excludes,
      inHome: req.inHome === true,
      ...(req.only ? { only: req.only } : {}),
    },
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
      error: 'It is gone on this computer. Compare again.',
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
        error: 'Changed on this computer since compare. Compare again.',
      });
      return;
    }
    await s.write('J', { e: filePut(op) });
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

const filePut = (op: ApplyOp) => ({
  id: op.entryId,
  op: 'put',
  kind: 'file',
  path: op.path,
  mode: op.meta!.mode,
  m: op.meta!.mtimeMs,
  size: op.meta!.size,
  sha: op.meta!.sha256,
  expect: expectOf(op.expect),
});

/** The server's files, streamed out one at a time by its helper (`export`), for a two-way pull. */
export interface Exporter {
  /** Streams one file. Resolves null when it arrived whole, else why it could not be sent. */
  fetch(
    op: ApplyOp,
    onStart: () => Promise<void>,
    onChunk: (data: Buffer) => Promise<void>,
  ): Promise<string | null>;
  /** Keep the export session alive while the receiving side works through folders and deletes. */
  touch(): void;
  close(): Promise<void>;
}

export async function openExport(
  launch: Launcher,
  req: { root: string; inHome?: boolean },
): Promise<Exporter> {
  const s = await session(launch);
  const lines = s.lines();
  const nextLine = async (): Promise<Record<string, unknown>> => {
    for (;;) {
      const r = await lines.next();
      if (r.done)
        throw s.problem('The server stopped sending files. Retry continues where it stopped.');
      if (r.value.hb) continue;
      if (typeof r.value.fatal === 'string') throw new Error(r.value.fatal);
      return r.value;
    }
  };
  try {
    await s.write('J', { op: 'export', root: req.root, inHome: req.inHome === true });
    const first = await nextLine();
    if (!first.ready) throw new Error('The server could not start sending files.');
  } catch (e) {
    s.kill();
    await s.close().catch(() => {});
    throw e;
  }
  return {
    async fetch(op, onStart, onChunk) {
      const meta = op.meta!;
      await s.write('J', {
        get: { id: op.entryId, path: op.source ?? op.path, size: meta.size, m: meta.mtimeMs },
      });
      for (;;) {
        const line = await nextLine();
        if (line.id !== op.entryId) throw new Error('The server answered out of order.');
        if (typeof line.error === 'string') return line.error;
        if (line.start) await onStart();
        else if (typeof line.d === 'string') await onChunk(Buffer.from(line.d, 'base64'));
        else if (line.end) return null;
      }
    },
    touch: () => s.touch(),
    async close() {
      try {
        await s.write('J', { end: true });
        s.end();
        for (;;) {
          const r = await lines.next();
          if (r.done || r.value.done) break;
        }
      } catch {
        s.kill();
      }
      await s.close().catch(() => {});
    },
  };
}

/** Relay one server file into this machine's helper. The receiving helper checks size and hash. */
async function relayFile(s: HelperSession, exporter: Exporter, op: ApplyOp, hooks: ApplyHooks) {
  let started = false;
  const error = await exporter.fetch(
    op,
    async () => {
      await s.write('J', { e: filePut(op) });
      started = true;
    },
    async (data) => {
      await s.write('D', data);
      hooks.onSent?.(data.length);
    },
  );
  if (error === null) await s.write('J', { commit: true });
  else if (started) await s.write('J', { abort: true });
  else hooks.onAck({ id: op.entryId, state: 'failed', error });
}

/** Where a put's bytes come from: this machine's disk, or the server's helper. */
export type FileSource = { kind: 'local'; root: string } | { kind: 'remote'; exporter: Exporter };

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
  header: { root: string; linkId: string; runId: string; side?: 'local' },
  from: string | FileSource,
  ops: ApplyOp[],
  hooks: ApplyHooks,
): Promise<void> {
  const source: FileSource = typeof from === 'string' ? { kind: 'local', root: from } : from;
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
      if (source.kind === 'remote') source.exporter.touch();
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
      if (op.op === 'put' && op.meta?.kind === 'file')
        await (source.kind === 'local'
          ? sendFile(s, source.root, op, local)
          : relayFile(s, source.exporter, op, local));
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
          'The connection ended before the run finished. Retry continues where it stopped.',
        );
}

export async function undoRun(
  launch: Launcher,
  header: { root: string; linkId: string; runId: string; side?: 'local' },
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

/** One row of a server folder listing. */
export interface ListedEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  size: number;
  mtimeMs: number;
}
const LISTED_KIND = { d: 'dir', f: 'file', l: 'link', o: 'other' } as const;

/** One level of a folder inside the helper's home. Credential folders are never listed. */
export async function listDir(
  launch: Launcher,
  path: string,
): Promise<{ home: string; entries: ListedEntry[]; missing: boolean; truncated: boolean }> {
  const entries: ListedEntry[] = [];
  const r = await requestDone(launch, { op: 'list', path }, (line) => {
    const kind = LISTED_KIND[line.k as keyof typeof LISTED_KIND];
    if (typeof line.n !== 'string' || !kind || entries.length >= 2000) return;
    entries.push({ name: line.n, kind, size: Number(line.s) || 0, mtimeMs: Number(line.m) || 0 });
  });
  return {
    home: String(r.home),
    entries,
    missing: r.missing === true,
    truncated: r.truncated === true,
  };
}

/** Free bytes where `path` is or would be; null when the helper cannot tell. */
export async function freeSpace(launch: Launcher, path: string): Promise<number | null> {
  const r = await requestDone(launch, { op: 'space', path });
  return typeof r.free === 'number' && Number.isFinite(r.free) && r.free >= 0 ? r.free : null;
}

/** Removes undo journals of a link's runs not in `keep` (and older than `minAgeMs`). */
export async function purgeRuns(
  launch: Launcher,
  req: { linkId: string; keep: string[]; side?: 'local'; minAgeMs?: number },
): Promise<number> {
  const r = await requestDone(launch, { op: 'purge', ...req });
  return Number(r.removed) || 0;
}
