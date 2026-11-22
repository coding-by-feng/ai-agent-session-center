import { describe, it, expect, vi } from 'vitest';
import { CallBusyError, createCallManager, type CallManagerDeps } from '../../server/voice/callManager.js';

const MAC = { isLocal: true, key: '' };
const PHONE = { isLocal: false, key: 'lineage-phone' };
const OTHER_PHONE = { isLocal: false, key: 'lineage-other' };
import { LiveApiError } from '../../server/voice/liveApi.js';
import type { VoiceCall } from '../../server/voice/voiceCall.js';

function fakeCall(): VoiceCall & { fireEnded: (r: string) => void; ended: boolean } {
  const listeners = new Set<(r: string) => void>();
  const call = {
    ended: false,
    isActive: () => !call.ended,
    end: vi.fn(() => { call.ended = true; for (const l of [...listeners]) l('close_requested'); }),
    onEnded: (l: (r: string) => void) => { listeners.add(l); return () => listeners.delete(l); },
    transcript: () => [],
    replies: () => [],
    busySince: () => null,
    fireEnded: (r: string) => { call.ended = true; for (const l of [...listeners]) l(r); },
  };
  return call;
}

function deps(over: Partial<CallManagerDeps> = {}) {
  const calls: ReturnType<typeof fakeCall>[] = [];
  const d: CallManagerDeps = {
    apiKey: () => 'sk-key-1234567890abcdefghij',
    voice: () => 'marin',
    createSession: vi.fn(async () => ({ sessionId: 'live_1', sdp: 'answer' })),
    attach: vi.fn(() => ({}) as never),
    startCall: vi.fn(() => { const c = fakeCall(); calls.push(c); return c; }),
    newId: (() => { let n = 0; return () => `call-${(n += 1)}`; })(),
    now: () => 42,
    ...over,
  };
  return { d, calls };
}

describe('createCallManager', () => {
  it('creates the OpenAI session, attaches, starts the call and answers its id and SDP', async () => {
    const { d } = deps();
    const m = createCallManager(d);
    await expect(m.start({ sdp: 'offer', owner: MAC })).resolves.toEqual({ callId: 'call-1', sdp: 'answer' });
    expect(d.createSession).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-key-1234567890abcdefghij', sdp: 'offer', voice: 'marin' }));
    expect(d.attach).toHaveBeenCalledWith('sk-key-1234567890abcdefghij', 'live_1');
    expect(d.startCall).toHaveBeenCalledWith(expect.objectContaining({ owner: MAC, reattach: expect.any(Function) }));
    expect(m.active()).toEqual({ callId: 'call-1', startedAt: 42, owner: MAC });
  });

  it('ends the call in progress before starting another', async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    await m.start({ sdp: 'a', owner: MAC });
    await m.start({ sdp: 'b', owner: PHONE });
    expect(calls[0].end).toHaveBeenCalled();
    expect(m.active()?.callId).toBe('call-2');
  });

  it('forgets a call once it ends by itself', async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    await m.start({ sdp: 'a', owner: MAC });
    calls[0].fireEnded('remote_hangup');
    expect(m.active()).toBeNull();
  });

  it('end(id) ends only the current call', async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    await m.start({ sdp: 'a', owner: MAC });
    expect(m.end('nope', MAC)).toBe(false);
    expect(m.end('call-1', MAC)).toBe(true);
    expect(calls[0].end).toHaveBeenCalled();
  });

  it("a phone may end only its own call; this Mac may end any", async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    await m.start({ sdp: 'a', owner: PHONE });
    expect(m.end('call-1', OTHER_PHONE)).toBe(false);
    expect(m.end('call-1', { isLocal: false, key: '' })).toBe(false);
    expect(calls[0].end).not.toHaveBeenCalled();
    expect(m.end('call-1', PHONE)).toBe(true);
    await m.start({ sdp: 'b', owner: PHONE });
    expect(m.end('call-2', MAC)).toBe(true);
  });

  it('callFor gives the call and its start only to whoever may control it (Nov 22 2026)', async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    expect(m.callFor('call-1', PHONE)).toBeNull();
    await m.start({ sdp: 'a', owner: PHONE });
    expect(m.callFor('call-1', PHONE)).toEqual({ call: calls[0], startedAt: 42 });
    expect(m.callFor('call-1', MAC)).toEqual({ call: calls[0], startedAt: 42 });
    expect(m.callFor('call-1', OTHER_PHONE)).toBeNull();
    expect(m.callFor('call-9', PHONE)).toBeNull();
    calls[0].fireEnded('remote_hangup');
    expect(m.callFor('call-1', PHONE)).toBeNull();
  });

  it('refuses a second start while one is still being set up, so no call is left unowned', async () => {
    let release: (v: { sessionId: string; sdp: string }) => void = () => {};
    const { d, calls } = deps({ createSession: vi.fn(() => new Promise((r) => { release = r; })) });
    const m = createCallManager(d);
    const first = m.start({ sdp: 'a', owner: PHONE });
    await expect(m.start({ sdp: 'b', owner: MAC })).rejects.toBeInstanceOf(CallBusyError);
    release({ sessionId: 'live_1', sdp: 'answer' });
    await first;
    expect(calls).toHaveLength(1);
    expect(m.active()?.callId).toBe('call-1');
  });

  it('a refused setup leaves the call in progress alone', async () => {
    const { d, calls } = deps();
    const m = createCallManager(d);
    await m.start({ sdp: 'a', owner: MAC });
    (d.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new LiveApiError('bad_request', 400, 'bad sdp'));
    await expect(m.start({ sdp: 'junk', owner: PHONE })).rejects.toBeInstanceOf(LiveApiError);
    expect(calls[0].end).not.toHaveBeenCalled();
    expect(m.active()?.callId).toBe('call-1');
  });

  it('a call whose setup finishes after close() is ended at once', async () => {
    let release: (v: { sessionId: string; sdp: string }) => void = () => {};
    const { d, calls } = deps({ createSession: vi.fn(() => new Promise((r) => { release = r; })) });
    const m = createCallManager(d);
    const first = m.start({ sdp: 'a', owner: MAC });
    m.close();
    release({ sessionId: 'live_1', sdp: 'answer' });
    await expect(first).rejects.toThrow(/shutting down/);
    expect(calls[0].end).toHaveBeenCalled();
    expect(m.active()).toBeNull();
  });

  it('passes an OpenAI failure through and starts nothing', async () => {
    const { d } = deps({ createSession: vi.fn(async () => { throw new LiveApiError('access', 403, 'x'); }) });
    const m = createCallManager(d);
    await expect(m.start({ sdp: 'a', owner: MAC })).rejects.toBeInstanceOf(LiveApiError);
    expect(d.startCall).not.toHaveBeenCalled();
    expect(m.active()).toBeNull();
  });

  it('refuses to start without a key', async () => {
    const { d } = deps({ apiKey: () => null });
    await expect(createCallManager(d).start({ sdp: 'a', owner: MAC })).rejects.toThrow(/key/);
  });
});
