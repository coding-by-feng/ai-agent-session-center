// test/queueMediaRouter.test.ts — POST /api/queue-media (Oct 27 2026): a phone's video for a prompt,
// streamed to disk next to the prompt images, so a queued or sent message can carry its path.
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { createQueueMediaRouter, MAX_QUEUE_MEDIA_BYTES, QUEUE_MEDIA_TYPES } from '../server/queueMediaRouter.js';
import { isQueueImageId, resolveQueueImage } from '../server/queueImages.js';

let server: Server;
let baseUrl = '';
let dir = '';
const SMALL_CAP = 64;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-queue-media-'));
  const app = express();
  // The global JSON parser the real server mounts first must leave a video body alone.
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', createQueueMediaRouter({ dir }));
  app.use('/small', createQueueMediaRouter({ dir, maxBytes: SMALL_CAP }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true });
});

const post = (path: string, body: BodyInit | null, type: string | null) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', body, headers: type ? { 'Content-Type': type } : {} });

describe('POST /api/queue-media', () => {
  it('saves a video as a queue file and answers its path and id, which the prompt route resolves', async () => {
    const bytes = Buffer.from('fake-mp4-bytes');
    const res = await post('/api/queue-media', bytes, 'video/mp4');
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; path: string; id: string; bytes: number };
    expect(json.ok).toBe(true);
    expect(json.bytes).toBe(bytes.length);
    expect(json.id).toBe(basename(json.path));
    expect(isQueueImageId(json.id)).toBe(true);
    expect(json.id).toMatch(/\.mp4$/);
    expect(readFileSync(json.path)).toEqual(bytes);
    expect(resolveQueueImage(json.id, dir)).toBe(json.path);
  });

  it('names each video type with its own extension', async () => {
    const exts: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' };
    expect(Object.keys(QUEUE_MEDIA_TYPES).sort()).toEqual(Object.keys(exts).sort());
    for (const [type, ext] of Object.entries(exts)) {
      const json = await (await post('/api/queue-media', Buffer.from('v'), type)).json() as { id: string };
      expect(json.id.endsWith(`.${ext}`), type).toBe(true);
    }
  });

  it('refuses anything that is not a video (415), and an empty body (400), writing nothing', async () => {
    expect((await post('/api/queue-media', Buffer.from('x'), 'image/png')).status).toBe(415);
    expect((await post('/api/queue-media', '{"a":1}', 'application/json')).status).toBe(415);
    expect((await post('/api/queue-media', Buffer.from('x'), 'video/x-msvideo')).status).toBe(415);
    expect((await post('/api/queue-media', Buffer.from('x'), null)).status).toBe(415);
    expect((await post('/api/queue-media', Buffer.alloc(0), 'video/mp4')).status).toBe(400);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a video over the cap (413) and leaves no partial file', async () => {
    const res = await post('/small/queue-media', Buffer.alloc(SMALL_CAP + 1, 1), 'video/mp4');
    expect(res.status).toBe(413);
    const json = await res.json() as { ok: boolean; code: string };
    expect(json).toMatchObject({ ok: false, code: 'too_large' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses a streamed body that outgrows the cap without a length up front', async () => {
    const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2)];
    const stream = new ReadableStream({
      pull(controller) {
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
    });
    const res = await fetch(`${baseUrl}/small/queue-media`, {
      method: 'POST',
      body: stream,
      headers: { 'Content-Type': 'video/mp4' },
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(413);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('allows 100 MB', () => {
    expect(MAX_QUEUE_MEDIA_BYTES).toBe(100 * 1024 * 1024);
  });
});
