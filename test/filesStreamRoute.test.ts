// test/filesStreamRoute.test.ts — the real /api/files/read and /api/files/stream routes over sparse
// files (no 150 MB is written to disk): media past 100 MB opens and streams by Range, a PDF past
// 100 MB is still refused, and a Range that names no byte gets 416 (fileStreamPolicy.ts, Nov 5 2026).
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, ftruncateSync, writeSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// apiRouter pulls in db.ts; the native better-sqlite3 here is built for Electron, and no route under
// test touches the database, so every statement is a no-op.
vi.mock('better-sqlite3', () => {
  const statement = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [], iterate: () => [][Symbol.iterator](), pluck: () => statement };
  class FakeDatabase {
    prepare() { return statement; }
    exec() { return this; }
    pragma() { return []; }
    transaction<T extends (...a: unknown[]) => unknown>(fn: T) { return fn; }
    close() {}
  }
  return { default: FakeDatabase };
});

const BIG = 150 * 1024 * 1024;
let tmp = '';
let base = '';
let server: Server;

function sparse(path: string, size: number, head = 'AASC'): void {
  const fd = openSync(path, 'w');
  writeSync(fd, head);
  ftruncateSync(fd, size);
  closeSync(fd);
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-files-stream-')));
  sparse(join(tmp, 'big.mp4'), BIG);
  sparse(join(tmp, 'big.pdf'), BIG);
  sparse(join(tmp, 'small.mp4'), 1000);
  // A shell here can inherit the desktop app's APP_USER_DATA: never let an import write the real one.
  process.env.APP_USER_DATA = join(tmp, 'user-data');
  const { default: apiRouter } = await import('../server/apiRouter.js');
  const app = express();
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 30_000);

afterAll(() => {
  server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const url = (route: string, path: string) => `${base}/api/files/${route}?root=${encodeURIComponent(tmp)}&path=${encodeURIComponent(path)}`;

describe('/api/files over 100 MB', () => {
  it('opens a 150 MB video as streamable', async () => {
    const res = await fetch(url('read', '/big.mp4'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ streamable: true, ext: 'mp4', size: BIG });
  });

  it('streams it by Range: the iOS probe and a chunk near the end', async () => {
    const probe = await fetch(url('stream', '/big.mp4'), { headers: { Range: 'bytes=0-1' } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${BIG}`);
    expect(await probe.text()).toBe('AA');

    const tail = await fetch(url('stream', '/big.mp4'), { headers: { Range: `bytes=${BIG - 10}-${BIG + 50}` } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${BIG - 10}-${BIG - 1}/${BIG}`);
    expect((await tail.arrayBuffer()).byteLength).toBe(10);
  });

  it('answers 416 for a range past the end', async () => {
    const res = await fetch(url('stream', '/small.mp4'), { headers: { Range: 'bytes=5000-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });

  it('still refuses a 150 MB PDF on both routes', async () => {
    expect((await fetch(url('read', '/big.pdf'))).status).toBe(413);
    expect((await fetch(url('stream', '/big.pdf'))).status).toBe(413);
  });
});
