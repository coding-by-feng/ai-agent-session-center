import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  createLiveSession, attachSideband, LiveApiError, LIVE_MODEL, LIVE_SESSIONS_URL,
  type SidebandSocketLike,
} from '../../server/voice/liveApi.js';

const KEY = 'sk-proj-secret-key-value-1234567890';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('createLiveSession', () => {
  it('posts a WebRTC session with client delegation and answers the session id and SDP answer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { session: { id: 'live_123' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }));
    const out = await createLiveSession({ apiKey: KEY, sdp: 'v=0 offer', instructions: 'Be brief.', voice: 'marin' }, fetchImpl);
    expect(out).toEqual({ sessionId: 'live_123', sdp: 'v=0 answer' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LIVE_SESSIONS_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      session: {
        model: LIVE_MODEL,
        instructions: 'Be brief.',
        delegation: { type: 'client', acknowledgement_delay_ms: 800 },
        audio: { output: { voice: 'marin' } },
      },
      transport: { type: 'webrtc', sdp: 'v=0 offer' },
    });
  });

  it.each([
    [401, 'key'],
    [403, 'access'],
    [429, 'rate'],
    [400, 'bad_request'],
    [500, 'upstream'],
  ] as const)('maps HTTP %i to %s, never echoing the key', async (status, reason) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: { message: `bad ${KEY}` } }));
    const err = await createLiveSession({ apiKey: KEY, sdp: 'x', instructions: 'i', voice: 'marin' }, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveApiError);
    expect((err as LiveApiError).reason).toBe(reason);
    expect((err as LiveApiError).status).toBe(status);
    expect((err as LiveApiError).message).not.toContain(KEY);
  });

  it('maps a network failure to network', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const err = await createLiveSession({ apiKey: KEY, sdp: 'x', instructions: 'i', voice: 'marin' }, fetchImpl).catch((e: unknown) => e);
    expect((err as LiveApiError).reason).toBe('network');
  });

  it('refuses a 201 without a session id or SDP', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { session: {} }));
    const err = await createLiveSession({ apiKey: KEY, sdp: 'x', instructions: 'i', voice: 'marin' }, fetchImpl).catch((e: unknown) => e);
    expect((err as LiveApiError).reason).toBe('upstream');
  });
});

class FakeSocket extends EventEmitter implements SidebandSocketLike {
  sent: string[] = [];
  readyState = 0;
  closed = false;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; this.emit('close', 1000); }
  open(): void { this.readyState = 1; this.emit('open'); }
  message(event: unknown): void { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

describe('attachSideband', () => {
  it('connects to the attach URL with the key, holding sends until the socket opens', async () => {
    const sock = new FakeSocket();
    const connect = vi.fn(() => sock);
    const sb = attachSideband({ apiKey: KEY, sessionId: 'live_123', connect });
    expect(connect).toHaveBeenCalledWith('wss://api.openai.com/v1/live/sessions/live_123/attach', { Authorization: `Bearer ${KEY}` });
    sb.send({ type: 'session.thinking.append', content: 'x' });
    expect(sock.sent).toHaveLength(0);
    sock.open();
    await sb.ready;
    expect(sock.sent.map((s) => JSON.parse(s).type)).toEqual(['session.thinking.append']);
  });

  it('passes each event once, dropping replayed ones by event_id', () => {
    const sock = new FakeSocket();
    const sb = attachSideband({ apiKey: KEY, sessionId: 'live_1', connect: () => sock });
    const seen: string[] = [];
    sb.onEvent((e) => seen.push(String(e.type)));
    sock.open();
    sock.message({ type: 'session.started', event_id: 'e1' });
    sock.message({ type: 'session.started', event_id: 'e1' });
    sock.message({ type: 'session.output_audio.delta' });
    sock.message({ type: 'session.output_audio.delta' });
    expect(seen).toEqual(['session.started', 'session.output_audio.delta', 'session.output_audio.delta']);
  });

  it('ignores a message that is not a JSON object', () => {
    const sock = new FakeSocket();
    const sb = attachSideband({ apiKey: KEY, sessionId: 'live_1', connect: () => sock });
    const seen: unknown[] = [];
    sb.onEvent((e) => seen.push(e));
    sock.open();
    sock.emit('message', Buffer.from('not json'));
    sock.emit('message', Buffer.from('[1]'));
    expect(seen).toEqual([]);
  });

  it('tells close listeners once, and a failed connect rejects ready', async () => {
    const sock = new FakeSocket();
    const sb = attachSideband({ apiKey: KEY, sessionId: 'live_1', connect: () => sock });
    const closes = vi.fn();
    sb.onClose(closes);
    sock.emit('error', new Error('boom'));
    sock.emit('close', 1006);
    sock.emit('close', 1006);
    await expect(sb.ready).rejects.toThrow();
    expect(closes).toHaveBeenCalledTimes(1);
  });

  it('refuses a session id that is not a plain token', () => {
    expect(() => attachSideband({ apiKey: KEY, sessionId: '../x', connect: () => new FakeSocket() })).toThrow(LiveApiError);
  });
});
