// diskUsage.test.ts — GET /api/sessions/:id/disk (Nov 26 2026): the room left on a session's disk, this Mac only.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { createDiskUsageRouter, DISK_CACHE_MS, type DiskSessionRef } from '../server/diskUsage.js';

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function start(opts: { local?: boolean; sessions?: Record<string, DiskSessionRef>; fail?: boolean } = {}) {
  const reads: string[] = [];
  let clock = 1_000;
  const app = express();
  app.use('/api', createDiskUsageRouter({
    getSession: (id) => (opts.sessions ?? { s1: { projectPath: '/work/proj' } })[id] ?? null,
    isLocalHost: (h) => !h || h === 'localhost',
    isLocal: () => opts.local ?? true,
    statfs: async (path) => {
      reads.push(path);
      if (opts.fail) throw new Error('ENOENT');
      return { freeBytes: 4e9, totalBytes: 5e11 };
    },
    now: () => clock,
    home: '/Users/me',
  }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const base = addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '';
  const get = async (id: string) => {
    const res = await fetch(`${base}/api/sessions/${id}/disk`);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { get, reads, advance: (ms: number) => { clock += ms; } };
}

describe('GET /api/sessions/:id/disk', () => {
  it('reads the disk of the session’s project folder', async () => {
    const { get, reads } = await start();
    const res = await get('s1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, freeBytes: 4e9, totalBytes: 5e11, path: '/work/proj' });
    expect(reads).toEqual(['/work/proj']);
  });

  it('caches a folder’s reading for DISK_CACHE_MS', async () => {
    const { get, reads, advance } = await start();
    await get('s1');
    await get('s1');
    expect(reads).toHaveLength(1);
    advance(DISK_CACHE_MS);
    await get('s1');
    expect(reads).toHaveLength(2);
  });

  it('falls back to the home folder when the session has no absolute project folder', async () => {
    const { get, reads } = await start({ sessions: { s1: { projectPath: '' }, s2: { projectPath: 'relative/dir' } } });
    expect((await get('s1')).body.path).toBe('/Users/me');
    expect((await get('s2')).body.path).toBe('/Users/me');
    expect(reads).toEqual(['/Users/me']);
  });

  it('is 404 from another device, without reading anything', async () => {
    const { get, reads } = await start({ local: false });
    expect((await get('s1')).status).toBe(404);
    expect(reads).toEqual([]);
  });

  it('is 404 for a session on another SSH host: this Mac’s disk says nothing about it', async () => {
    const { get, reads } = await start({ sessions: { r: { projectPath: '/srv/app', sshHost: 'build-box' }, l: { projectPath: '/work', sshHost: 'localhost' } } });
    const remote = await get('r');
    expect(remote.status).toBe(404);
    expect(remote.body.reason).toBe('remote-host');
    expect((await get('l')).status).toBe(200);
    expect(reads).toEqual(['/work']);
  });

  it('is 404 for an unknown session and for a folder it cannot read', async () => {
    expect((await (await start()).get('nope')).status).toBe(404);
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const failing = await start({ fail: true });
    const res = await failing.get('s1');
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('unreadable');
  });
});
