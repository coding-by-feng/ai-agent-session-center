// test/instanceLock.test.ts — the folder lock and the machine lock (server/instanceLock.ts, plan §7.1),
// and the queue-folder ownership check a headless server runs before it trusts the machine lock.
//
// Every lock lives in a temporary folder. Liveness is injected, except in the one case that needs a
// really dead pid: that pid belongs to a child this test started and already reaped.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, statSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { createServer, type Server } from 'net';
import {
  acquireLock, releaseLock, readLock, isLockLive, markLockListening, probeHost, checkQueueDirOwnership,
  STARTUP_GRACE_MS, type LockRecord,
} from '../server/instanceLock.js';

// Any real signal other than the liveness probe (signal 0) fails the test instead of reaching a process.
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`instanceLock.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);
afterAll(() => killGuard.mockRestore());

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aasc-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const record = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: process.pid, port: 45678, edition: 'headless', startedAt: 1, dataDir: '/data', ...over,
});

describe('acquireLock', () => {
  it('writes a 0600 lock naming the pid, port, edition and folder', async () => {
    const path = join(dir, 'server.lock');
    const result = await acquireLock(path, record(), { isLive: async () => true });
    expect(result).toEqual({ acquired: true });
    expect(readLock(path)).toEqual(record());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses while another live server holds it, and leaves its lock as it was', async () => {
    const path = join(dir, 'server.lock');
    const holder = record({ pid: 4121, port: 3333, edition: 'desktop' });
    writeFileSync(path, JSON.stringify(holder));
    const result = await acquireLock(path, record(), { isLive: async () => true });
    expect(result).toEqual({ acquired: false, holder });
    expect(readLock(path)).toEqual(holder);
  });

  it('takes over a stale lock', async () => {
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify(record({ pid: 4121 })));
    const result = await acquireLock(path, record(), { isLive: async () => false });
    expect(result).toEqual({ acquired: true });
    expect(readLock(path)?.pid).toBe(process.pid);
  });

  it('treats an unreadable lock as stale', async () => {
    const path = join(dir, 'server.lock');
    writeFileSync(path, 'not json');
    expect(await acquireLock(path, record(), { isLive: async () => true })).toEqual({ acquired: true });
  });

  it('treats its own pid as stale (a restart inside one process)', async () => {
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify(record({ port: 1 })));
    expect(await acquireLock(path, record(), { isLive: async () => true })).toEqual({ acquired: true });
  });

  it('refuses a server that is still starting: a live pid, a silent port, a recent startedAt', async () => {
    const path = join(dir, 'server.lock');
    const port = await silentPort();
    const starting = record({ pid: process.ppid, port, startedAt: Date.now() });
    writeFileSync(path, JSON.stringify(starting));
    expect(await acquireLock(path, record())).toEqual({ acquired: false, holder: starting });
    // Past the grace period, a pid whose port never answered is stale.
    writeFileSync(path, JSON.stringify({ ...starting, startedAt: Date.now() - STARTUP_GRACE_MS - 1000 }));
    expect(await acquireLock(path, record())).toEqual({ acquired: true });
  });

  it('lets exactly one of two concurrent takeovers of a stale lock win', async () => {
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify(record({ pid: 999, startedAt: 5 })));
    // Slow liveness: both callers judge the old lock stale before either acts on it.
    const isLive = async (h: LockRecord): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 50));
      return h.pid !== 999;
    };
    const a = record({ pid: 1001 });
    const b = record({ pid: 1002 });
    const [ra, rb] = await Promise.all([acquireLock(path, a, { isLive }), acquireLock(path, b, { isLive })]);
    const winners = [ra, rb].filter((r) => r.acquired);
    expect(winners).toHaveLength(1);
    const winner = ra.acquired ? a : b;
    expect(readLock(path)).toEqual(winner);
    expect(ra.acquired ? rb : ra).toEqual({ acquired: false, holder: winner });
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });

  it('clears a takeover sentinel left by a dead process', async () => {
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify(record({ pid: 999 })));
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(`${path}.takeover`, JSON.stringify({ pid: dead, at: Date.now() }));
    expect(await acquireLock(path, record(), { isLive: async () => false })).toEqual({ acquired: true });
    expect(existsSync(`${path}.takeover`)).toBe(false);
  });
});

describe('markLockListening', () => {
  it('records the bound address on our own lock, and leaves another server lock alone', async () => {
    const path = join(dir, 'server.lock');
    const mine = record();
    await acquireLock(path, mine, { isLive: async () => false });
    markLockListening(path, mine, '100.64.0.7');
    expect(readLock(path)).toEqual({ ...mine, listening: true, bindAddress: '100.64.0.7' });
    expect(readdirSync(dir)).toEqual(['server.lock']);
    const other = record({ pid: 4242 });
    writeFileSync(path, JSON.stringify(other));
    markLockListening(path, mine, '127.0.0.1');
    expect(readLock(path)).toEqual(other);
  });
});

describe('releaseLock', () => {
  it('removes the lock only while it still names this process', async () => {
    const path = join(dir, 'server.lock');
    await acquireLock(path, record(), { isLive: async () => false });
    writeFileSync(path, JSON.stringify(record({ pid: 999999 })));
    releaseLock(path);
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify(record()));
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
    expect(() => releaseLock(path)).not.toThrow();
  });
});

async function silentPort(): Promise<number> {
  const probe: Server = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe('probeHost', () => {
  it('probes loopback for a wildcard bind and the bound address otherwise', () => {
    expect(probeHost(undefined)).toBe('127.0.0.1');
    expect(probeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(probeHost('::')).toBe('127.0.0.1');
    expect(probeHost('100.64.0.7')).toBe('100.64.0.7');
    expect(probeHost('::1')).toBe('::1');
  });
});

describe('isLockLive', () => {
  it('is false for a pid that is gone', async () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    expect(await isLockLive(record({ pid: child.pid! }))).toBe(false);
  });

  it('is false when the pid lives but nothing listens on the port it said it listens on', async () => {
    const port = await silentPort();
    expect(await isLockLive(record({ pid: process.pid, port, listening: true }))).toBe(false);
    expect(await isLockLive(record({ pid: process.pid, port, startedAt: 1 }))).toBe(false);
  });

  it('is true for a live pid that has not listened yet, within the start-up grace', async () => {
    expect(await isLockLive(record({ pid: process.pid, port: await silentPort(), startedAt: Date.now() }))).toBe(true);
  });

  it('is true when the pid lives and the port answers', async () => {
    const holder: Server = createServer();
    await new Promise<void>((r) => holder.listen(0, '127.0.0.1', r));
    const port = (holder.address() as { port: number }).port;
    try {
      expect(await isLockLive(record({ pid: process.pid, port, listening: true, bindAddress: '127.0.0.1' }))).toBe(true);
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  });
});

describe('checkQueueDirOwnership', () => {
  const uid = process.getuid?.() ?? 0;

  it('creates a missing folder with mode 0700 and accepts it', () => {
    const q = join(dir, 'queue');
    expect(checkQueueDirOwnership(q, { uid })).toBeNull();
    expect(statSync(q).mode & 0o777).toBe(0o700);
  });

  it('tightens our own folder to 0700 (dashboard-statusline.sh may create it 0755) and accepts it', () => {
    const q = join(dir, 'queue');
    mkdirSync(q);
    chmodSync(q, 0o755);
    expect(checkQueueDirOwnership(q, { uid })).toBeNull();
    expect(statSync(q).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlink, even to a good folder', () => {
    const real = join(dir, 'real');
    mkdirSync(real, { mode: 0o700 });
    const q = join(dir, 'queue');
    symlinkSync(real, q);
    expect(checkQueueDirOwnership(q, { uid })).toMatch(/symlink/);
  });

  it('refuses a folder another user owns', () => {
    const q = join(dir, 'queue');
    mkdirSync(q, { mode: 0o700 });
    expect(checkQueueDirOwnership(q, { uid: uid + 1 })).toMatch(/owned by uid/);
  });

  it('refuses a file where the folder should be', () => {
    const q = join(dir, 'queue');
    writeFileSync(q, '');
    expect(checkQueueDirOwnership(q, { uid })).toMatch(/not a folder/);
    expect(readFileSync(q, 'utf8')).toBe('');
  });
});
