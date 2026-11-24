// POST /api/voice/call/:id/attach, POST …/skill, DELETE …/attach/:attachId (Nov 24 2026): the call
// screen's ＋ Add. Only the caller who may control the call adds to it; a file is streamed to disk
// (application/octet-stream, so the JSON parser never reads it) and held for the next question.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createVoiceRouter, type VoiceRouterDeps } from '../../server/voice/voiceRouter.js';
import { createPendingList, MAX_CALL_ATTACHMENTS, type CallAttachment } from '../../server/voice/callAttach.js';

type Res = { status: number; body: any };

async function send(a: express.Express, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Res> {
  const server = http.createServer(a);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const fileHeaders = (name: string, type: string) => ({
  'content-type': 'application/octet-stream',
  'x-file-name': encodeURIComponent(name),
  'x-file-type': type,
});

describe('voice call attachments', () => {
  let dir: string;
  let list: ReturnType<typeof createPendingList>;
  let ended: boolean;
  let a: express.Express;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'voice-attach-'));
    list = createPendingList();
    ended = false;
    const call = {
      attach: (item: Omit<CallAttachment, 'id'>) => (ended ? null : list.add(item)),
      detach: (id: string) => list.remove(id),
      pending: () => list.items(),
    };
    const deps: VoiceRouterDeps = {
      isLocal: () => false,
      callerKey: () => 'lineage-phone',
      settings: () => ({ apiKey: null, voice: 'marin', brainCentralId: null }),
      saveSettings: (p) => ({ apiKey: null, voice: 'marin', brainCentralId: null, ...p }),
      brain: () => ({ state: 'ready', centralId: 'c1', title: 'Voice', shared: true }),
      startCall: async () => ({ callId: 'call-1', sdp: '' }),
      endCall: () => true,
      activeCall: () => null,
      transcribe: async () => '',
      // Only this caller's call-1 exists.
      callAttachments: (callId, caller) => (callId === 'call-1' && caller.key === 'lineage-phone' ? call : null),
      attachDir: dir,
    };
    a = express();
    a.use(express.json());
    a.use('/api', createVoiceRouter(deps));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('saves a photo and holds it for the next question, answering its name and kind but not the path', async () => {
    const res = await send(a, 'POST', '/api/voice/call/call-1/attach', 'jpegbytes', fileHeaders('收据 1.jpg', 'image/jpeg'));
    expect(res.status).toBe(201);
    expect(res.body.data.item).toEqual({ id: 'att1', kind: 'photo', name: '收据 1.jpg' });
    const [held] = list.items();
    expect(held.path?.startsWith(dir)).toBe(true);
    expect(held.path?.endsWith('.jpg')).toBe(true);
    expect(readFileSync(held.path!, 'utf8')).toBe('jpegbytes');
  });

  it('takes any file type', async () => {
    const res = await send(a, 'POST', '/api/voice/call/call-1/attach', '{"a":1}', fileHeaders('data.json', 'application/json'));
    expect(res.status).toBe(201);
    expect(res.body.data.item.kind).toBe('file');
    expect(readFileSync(list.items()[0].path!, 'utf8')).toBe('{"a":1}');
  });

  it('refuses a body that is not raw bytes (the JSON parser would have read it)', async () => {
    const res = await send(a, 'POST', '/api/voice/call/call-1/attach', '{"a":1}', { 'content-type': 'application/json' });
    expect(res.status).toBe(415);
    expect(list.items()).toEqual([]);
  });

  it('is 404 for another call or device, and saves nothing', async () => {
    expect((await send(a, 'POST', '/api/voice/call/call-2/attach', 'x', fileHeaders('a.txt', 'text/plain'))).status).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses once the next question holds the most it can, and saves nothing', async () => {
    for (let i = 0; i < MAX_CALL_ATTACHMENTS; i += 1) list.add({ kind: 'skill', name: `/s${i}` });
    const res = await send(a, 'POST', '/api/voice/call/call-1/attach', 'x', fileHeaders('a.txt', 'text/plain'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('full');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('removes the saved file when the call ended during the upload', async () => {
    ended = true;
    const res = await send(a, 'POST', '/api/voice/call/call-1/attach', 'x', fileHeaders('a.txt', 'text/plain'));
    expect(res.status).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('holds a picked skill or command, and refuses anything else', async () => {
    const json = { 'content-type': 'application/json' };
    const ok = await send(a, 'POST', '/api/voice/call/call-1/skill', JSON.stringify({ name: '/expense-log' }), json);
    expect(ok.status).toBe(201);
    expect(ok.body.data.item).toEqual({ id: 'att1', kind: 'skill', name: '/expense-log' });
    expect((await send(a, 'POST', '/api/voice/call/call-1/skill', JSON.stringify({ name: 'rm -rf' }), json)).status).toBe(400);
    expect((await send(a, 'POST', '/api/voice/call/call-1/skill', JSON.stringify({ name: '/x', extra: 1 }), json)).status).toBe(400);
  });

  it('takes one back before the question', async () => {
    list.add({ kind: 'skill', name: '/a' });
    expect((await send(a, 'DELETE', '/api/voice/call/call-1/attach/att1')).status).toBe(200);
    expect(list.items()).toEqual([]);
    expect((await send(a, 'DELETE', '/api/voice/call/call-1/attach/att1')).status).toBe(404);
  });
});
