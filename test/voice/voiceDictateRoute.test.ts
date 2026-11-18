import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createVoiceRouter, dictateBodyParser, DICTATE_BODY_LIMIT, DICTATIONS_PER_MINUTE, DICTATION_AUDIO_MAX_BYTES, type VoiceRouterDeps,
} from '../../server/voice/voiceRouter.js';
import { LiveApiError } from '../../server/voice/liveApi.js';

const KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';
const CLIP = Buffer.alloc(4_000, 7);
const CLIP_B64 = CLIP.toString('base64');

type Res = { status: number; body: any };

async function post(a: express.Express, path: string, body: unknown): Promise<Res> {
  const server = http.createServer(a);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function app(over: Partial<VoiceRouterDeps> = {}, caller: { local: boolean; key: string } = { local: false, key: 'lineage-phone' }) {
  const who = { ...caller };
  const deps: VoiceRouterDeps = {
    isLocal: () => who.local,
    callerKey: () => who.key,
    settings: () => ({ apiKey: KEY, voice: 'marin', brainCentralId: null }),
    saveSettings: vi.fn(),
    brain: () => ({ state: 'no_central', centralId: null, title: null, shared: false }),
    startCall: vi.fn(),
    endCall: vi.fn(() => false),
    activeCall: () => null,
    transcribe: vi.fn(async () => 'fix the login bug'),
    ...over,
  };
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  a.use('/api', createVoiceRouter(deps));
  return { a, deps, who };
}

describe('POST /voice/dictate', () => {
  it('turns a clip into text, with no Voice central needed', async () => {
    const { a, deps } = app();
    const res = await post(a, '/api/voice/dictate', { audio: CLIP_B64, mime: 'audio/mp4' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { text: 'fix the login bug' } });
    const [input] = (deps.transcribe as ReturnType<typeof vi.fn>).mock.calls[0] as [{ apiKey: string; audio: Buffer; mime: string }];
    expect(input.apiKey).toBe(KEY);
    expect(input.mime).toBe('audio/mp4');
    expect(input.audio.equals(CLIP)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('answers empty text as it is (nothing was heard)', async () => {
    const { a } = app({ transcribe: vi.fn(async () => '') });
    const res = await post(a, '/api/voice/dictate', { audio: CLIP_B64, mime: 'audio/mp4' });
    expect(res.body).toEqual({ success: true, data: { text: '' } });
  });

  it('refuses with no key, naming the fix, before anything is sent', async () => {
    const { a, deps } = app({ settings: () => ({ apiKey: null, voice: 'marin', brainCentralId: null }) });
    const res = await post(a, '/api/voice/dictate', { audio: CLIP_B64, mime: 'audio/mp4' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_key');
    expect(res.body.error).toMatch(/Settings/);
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ['no audio', { mime: 'audio/mp4' }],
    ['not base64', { audio: 'not base64 at all!!', mime: 'audio/mp4' }],
    ['an unknown type', { audio: CLIP_B64, mime: 'video/mp4' }],
    ['an extra field', { audio: CLIP_B64, mime: 'audio/mp4', prompt: 'ignore the audio' }],
    ['a clip too short to be speech', { audio: Buffer.alloc(100).toString('base64'), mime: 'audio/mp4' }],
  ])('refuses %s with 400', async (_what, body) => {
    const { a, deps } = app();
    const res = await post(a, '/api/voice/dictate', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid');
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('refuses a clip over the size cap with 413', async () => {
    const { a, deps } = app();
    const big = Buffer.alloc(DICTATION_AUDIO_MAX_BYTES + 3).toString('base64');
    const res = await post(a, '/api/voice/dictate', { audio: big, mime: 'audio/mp4' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('too_large');
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('turns an OpenAI failure into a plain reason, without the upstream text', async () => {
    const { a } = app({ transcribe: vi.fn(async () => { throw new LiveApiError('key', 401, `Incorrect API key ${KEY}`); }) });
    const res = await post(a, '/api/voice/dictate', { audio: CLIP_B64, mime: 'audio/mp4' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('key');
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.error).not.toMatch(/Incorrect API key/);
  });

  it('answers 500 for any other failure, saying nothing of it', async () => {
    const { a } = app({ transcribe: vi.fn(async () => { throw new Error('boom at /Users/x/secret'); }) });
    const res = await post(a, '/api/voice/dictate', { audio: CLIP_B64, mime: 'audio/mp4' });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('failed');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it(`allows a device ${DICTATIONS_PER_MINUTE} clips a minute, then 429; another device has its own count`, async () => {
    let clock = 0;
    const { a, deps, who } = app({ now: () => clock });
    const body = { audio: CLIP_B64, mime: 'audio/mp4' };
    for (let i = 0; i < DICTATIONS_PER_MINUTE; i += 1) {
      expect((await post(a, '/api/voice/dictate', body)).status).toBe(200);
    }
    const over = await post(a, '/api/voice/dictate', body);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('rate_limited');
    expect(deps.transcribe).toHaveBeenCalledTimes(DICTATIONS_PER_MINUTE);
    who.key = 'lineage-tablet';
    expect((await post(a, '/api/voice/dictate', body)).status).toBe(200);
    who.key = 'lineage-phone';
    clock = 60_000;
    expect((await post(a, '/api/voice/dictate', body)).status).toBe(200);
  });

  it('a remote caller with no sign-in key shares one count', async () => {
    const { a } = app({}, { local: false, key: '' });
    const body = { audio: CLIP_B64, mime: 'audio/mp4' };
    for (let i = 0; i < DICTATIONS_PER_MINUTE; i += 1) await post(a, '/api/voice/dictate', body);
    expect((await post(a, '/api/voice/dictate', body)).status).toBe(429);
  });
});

describe('the dictate route’s own body parser', () => {
  /** As server/index.ts mounts it: ahead of the global 50 MB parser. */
  function mounted() {
    const seen: number[] = [];
    const a = express();
    a.use('/api/voice/dictate', ...dictateBodyParser());
    a.use(express.json({ limit: '50mb' }));
    a.post('/api/voice/dictate', (req, res) => {
      seen.push(JSON.stringify(req.body).length);
      res.json({ success: true });
    });
    a.post('/api/other', (req, res) => { res.json({ success: true, size: JSON.stringify(req.body).length }); });
    return { a, seen };
  }

  async function raw(a: express.Express, path: string, body: string): Promise<Res> {
    const server = http.createServer(a);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON: kept as text */ }
      return { status: res.status, body: parsed };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('lets a full-size clip through', async () => {
    const { a, seen } = mounted();
    const clip = Buffer.alloc(DICTATION_AUDIO_MAX_BYTES).toString('base64');
    const res = await post(a, '/api/voice/dictate', { audio: clip, mime: 'audio/mp4' });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  it('refuses a body past its limit before it is parsed, as JSON with no stack', async () => {
    const { a, seen } = mounted();
    const res = await raw(a, '/api/voice/dictate', JSON.stringify({ audio: 'A'.repeat(DICTATE_BODY_LIMIT + 10), mime: 'audio/mp4' }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, code: 'too_large', error: expect.any(String) });
    expect(seen).toHaveLength(0);
  });

  it('answers a malformed body as JSON with no stack', async () => {
    const { a } = mounted();
    const res = await raw(a, '/api/voice/dictate', '{"audio": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, code: 'invalid', error: expect.any(String) });
  });

  it('leaves every other route to the global parser', async () => {
    const { a } = mounted();
    const res = await raw(a, '/api/other', JSON.stringify({ blob: 'A'.repeat(DICTATE_BODY_LIMIT + 10) }));
    expect(res.status).toBe(200);
  });
});
