import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CALL_STARTS_PER_MINUTE, createVoiceRouter, type VoiceRouterDeps } from '../../server/voice/voiceRouter.js';
import { CallBusyError } from '../../server/voice/callManager.js';
import { LiveApiError } from '../../server/voice/liveApi.js';

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';

type Res = { status: number; body: any };
/** A small stand-in for supertest: one listen per request, closed after it. */
function request(a: express.Express) {
  const go = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const server = http.createServer(a);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
  return {
    get: (path: string) => go('GET', path),
    post: (path: string) => ({ send: (b: unknown) => go('POST', path, b), then: (f: (r: Res) => unknown, g?: (e: unknown) => unknown) => go('POST', path).then(f, g) }),
    put: (path: string) => ({ send: (b: unknown) => go('PUT', path, b) }),
  };
}

function app(over: Partial<VoiceRouterDeps> = {}, local = true) {
  let settings = { apiKey: KEY as string | null, voice: 'marin', brainCentralId: null as string | null };
  const deps: VoiceRouterDeps = {
    isLocal: () => local,
    callerKey: () => (local ? '' : 'lineage-phone'),
    settings: () => settings,
    saveSettings: vi.fn((patch) => { settings = { ...settings, ...patch }; return settings; }),
    brain: () => ({ state: 'ready', centralId: 'c1', title: 'Voice', shared: true }),
    startCall: vi.fn(async () => ({ callId: 'call-1', sdp: 'v=0 answer' })),
    endCall: vi.fn(() => true),
    activeCall: () => null,
    ...over,
  };
  const a = express();
  a.use(express.json());
  a.use('/api', createVoiceRouter(deps));
  return { a, deps };
}

describe('voice routes', () => {
  it('GET /voice/status says whether a call can start, without the key', async () => {
    const { a } = app();
    const res = await request(a).get('/api/voice/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { configured: true, voice: 'marin', brain: { state: 'ready', centralId: 'c1', title: 'Voice', shared: true }, call: null },
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('GET /voice/status hides an unshared central from a remote device', async () => {
    const { a } = app({ brain: () => ({ state: 'ready', centralId: 'c1', title: 'Voice', shared: false }) }, false);
    const res = await request(a).get('/api/voice/status');
    expect(res.body.data.brain).toEqual({ state: 'ready', centralId: null, title: null, shared: false });
  });

  it('POST /voice/call starts a call from an SDP offer', async () => {
    const { a, deps } = app();
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0 offer' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { callId: 'call-1', sdp: 'v=0 answer' } });
    expect(deps.startCall).toHaveBeenCalledWith({ sdp: 'v=0 offer', owner: { isLocal: true, key: '' } });
  });

  it('refuses a missing or oversized offer', async () => {
    const { a } = app();
    expect((await request(a).post('/api/voice/call').send({})).status).toBe(400);
    expect((await request(a).post('/api/voice/call').send({ sdp: 'x'.repeat(70_000) })).status).toBe(400);
  });

  it('refuses a call with no key, naming the fix', async () => {
    const { a } = app({ settings: () => ({ apiKey: null, voice: 'marin', brainCentralId: null }) });
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: 'no_key' });
  });

  it('refuses a call when the Voice central is not ready', async () => {
    const { a } = app({ brain: () => ({ state: 'no_central', centralId: null, title: null, shared: false }) });
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_central');
  });

  it('refuses a phone call when the Voice central is not shared with remote devices', async () => {
    const { a } = app({ brain: () => ({ state: 'ready', centralId: 'c1', title: 'Voice', shared: false }) }, false);
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_shared');
  });

  it('turns an OpenAI failure into a plain reason', async () => {
    const { a } = app({ startCall: vi.fn(async () => { throw new LiveApiError('access', 403, 'no access'); }) });
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ success: false, code: 'access' });
    expect(res.body.error).toMatch(/GPT-Live/);
  });

  it('POST /voice/call/:id/end ends that call, 404 for another', async () => {
    const { a } = app({ endCall: vi.fn((id: string) => id === 'call-1') });
    expect((await request(a).post('/api/voice/call/call-1/end')).status).toBe(200);
    expect((await request(a).post('/api/voice/call/other/end')).status).toBe(404);
  });

  it("a phone's start and end carry its sign-in, so only it (or this Mac) can end its call", async () => {
    const { a, deps } = app({}, false);
    await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(deps.startCall).toHaveBeenCalledWith({ sdp: 'v=0', owner: { isLocal: false, key: 'lineage-phone' } });
    await request(a).post('/api/voice/call/call-1/end');
    expect(deps.endCall).toHaveBeenCalledWith('call-1', { isLocal: false, key: 'lineage-phone' });
  });

  it('GET /voice/status shows a call id only to the device that may end it', async () => {
    const call = { callId: 'call-9', startedAt: 5, owner: { isLocal: false, key: 'lineage-mine' } };
    const other = app({ activeCall: () => call }, false);
    expect((await request(other.a).get('/api/voice/status')).body.data.call).toEqual({ callId: null, startedAt: 5, mine: false });
    const mine = app({ activeCall: () => call, callerKey: () => 'lineage-mine' }, false);
    expect((await request(mine.a).get('/api/voice/status')).body.data.call).toEqual({ callId: 'call-9', startedAt: 5, mine: true });
    const mac = app({ activeCall: () => call });
    expect((await request(mac.a).get('/api/voice/status')).body.data.call).toMatchObject({ callId: 'call-9' });
  });

  it('answers 409 busy while another call is being set up', async () => {
    const { a } = app({ startCall: vi.fn(async () => { throw new CallBusyError(); }) });
    const res = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('busy');
  });

  it(`allows ${CALL_STARTS_PER_MINUTE} call starts a minute, then 429`, async () => {
    let clock = 0;
    const { a, deps } = app({ now: () => clock });
    for (let i = 0; i < CALL_STARTS_PER_MINUTE; i += 1) {
      expect((await request(a).post('/api/voice/call').send({ sdp: 'v=0' })).status).toBe(201);
    }
    const over = await request(a).post('/api/voice/call').send({ sdp: 'v=0' });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(deps.startCall).toHaveBeenCalledTimes(CALL_STARTS_PER_MINUTE);
    clock = 60_000;
    expect((await request(a).post('/api/voice/call').send({ sdp: 'v=0' })).status).toBe(201);
  });

  it('settings are this Mac only', async () => {
    const { a } = app({}, false);
    expect((await request(a).get('/api/voice/settings')).status).toBe(404);
    expect((await request(a).put('/api/voice/settings').send({ voice: 'cedar' })).status).toBe(404);
  });

  it('GET /voice/settings never returns the key', async () => {
    const { a } = app();
    const res = await request(a).get('/api/voice/settings');
    expect(res.body.data).toEqual({ configured: true, keyHint: '…0123', voice: 'marin', brainCentralId: null });
  });

  it('PUT /voice/settings saves a valid patch and refuses a bad one', async () => {
    const { a, deps } = app();
    const ok = await request(a).put('/api/voice/settings').send({ apiKey: null, voice: 'cedar' });
    expect(ok.status).toBe(200);
    expect(deps.saveSettings).toHaveBeenCalledWith({ apiKey: null, voice: 'cedar' });
    expect(ok.body.data.configured).toBe(false);
    expect((await request(a).put('/api/voice/settings').send({ apiKey: 'short' })).status).toBe(400);
    expect((await request(a).put('/api/voice/settings').send({ voice: 'Bad Voice!' })).status).toBe(400);
    expect((await request(a).put('/api/voice/settings').send({ extra: 1 })).status).toBe(400);
  });
});
