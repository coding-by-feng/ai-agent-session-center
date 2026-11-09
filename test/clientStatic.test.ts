import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mountClientStatic } from '../server/clientStatic.js';

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'client-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'ChatView-new.js'), 'export default 1;');
  const app = express();
  mountClientStatic(app, dir);
  // The SPA fallback the real server registers after everything else.
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(join(dir, 'index.html'));
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe('mountClientStatic', () => {
  it('serves an existing build file', async () => {
    const res = await fetch(`${base}/assets/ChatView-new.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('answers a chunk from an older build with 404, not index.html', async () => {
    const res = await fetch(`${base}/assets/ChatView-old.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<div id="root">');
  });

  it('leaves the SPA routes on index.html', async () => {
    const res = await fetch(`${base}/history`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
