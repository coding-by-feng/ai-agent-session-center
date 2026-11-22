import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCallWiring, PROGRESS_POLL_MS, type CallHost, type LineResult } from './callWiring.js';
import type { HttpRequest } from './http.js';
import type { SavedMac } from './savedMacs.js';
import type { Screen } from './ui/screen.js';
import type { ChannelLike, PeerLike, RtcEnv } from './voiceRtc.js';

const mac = { id: 'm1', name: 'Mac mini' } as SavedMac;

class FakePeer implements PeerLike {
  localDescription: { sdp: string } | null = null;
  iceGatheringState = 'complete';
  connectionState = 'new';
  closed = false;
  remote: unknown = null;
  private messageListener: ((e: { data?: unknown }) => void) | null = null;
  private stateListener: (() => void) | null = null;
  addTrack(): unknown { return {}; }
  createDataChannel(): ChannelLike {
    return { addEventListener: (_t, l) => { this.messageListener = l; }, close: () => {} };
  }
  async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
  async setLocalDescription(d: { sdp?: string }) { this.localDescription = { sdp: d.sdp ?? '' }; }
  async setRemoteDescription(d: unknown) { this.remote = d; }
  addEventListener(type: string, l: (e: never) => void): void {
    if (type === 'connectionstatechange') this.stateListener = l as () => void;
  }
  close(): void { this.closed = true; }
  event(e: unknown): void { this.messageListener?.({ data: JSON.stringify(e) }); }
  drop(): void { this.connectionState = 'failed'; this.stateListener?.(); }
}

function setup(over: { openLine?: () => Promise<LineResult>; callStatus?: number; callData?: unknown; mic?: boolean; progress?: () => { status: number; data: unknown } } = {}) {
  let screen: Screen = { name: 'macs', notice: null };
  const peer = new FakePeer();
  const requests: HttpRequest[] = [];
  const track = { enabled: true, stop: vi.fn() };
  const env: RtcEnv = {
    getMicrophone: vi.fn(async () => {
      if (over.mic === false) throw new Error('denied');
      return { getAudioTracks: () => [track], getTracks: () => [track] };
    }),
    createPeer: () => peer,
    playRemote: () => () => {},
  };
  const host: CallHost = {
    requester: {
      request: vi.fn(async (req: HttpRequest) => {
        requests.push(req);
        if (req.url.endsWith('/api/voice/call')) {
          return { status: over.callStatus ?? 201, data: over.callData ?? { success: true, data: { callId: 'call_1', sdp: 'v=0 answer' } } };
        }
        if (req.url.endsWith('/progress')) return over.progress?.() ?? { status: 404, data: {} };
        return { status: 200, data: {} };
      }),
    },
    macs: () => [mac],
    setMacs: vi.fn(),
    openLine: over.openLine ?? (async () => ({ ok: true, line: { origin: 'http://mac:3334', token: 't' } })),
    screen: () => screen,
    show: (next) => { screen = next; },
    update: (patch) => { screen = { ...screen, ...patch } as Screen; },
    backToMac: vi.fn(),
    rtcEnv: () => env,
    now: () => 1_000,
  };
  const wiring = createCallWiring(host);
  return { wiring, host, peer, requests, track, screen: () => screen as Extract<Screen, { name: 'call' }> };
}

describe('createCallWiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('signs in, sends the offer to the Mac, applies the answer and goes live', async () => {
    const t = setup();
    await t.wiring.start(mac, '/?session=a');
    expect(t.requests[0]).toMatchObject({ url: 'http://mac:3334/api/voice/call', body: { sdp: 'v=0 offer' } });
    expect(t.peer.remote).toEqual({ type: 'answer', sdp: 'v=0 answer' });
    expect(t.screen()).toMatchObject({ name: 'call', macId: 'm1', back: '/?session=a', phase: 'live', startedAt: 1_000 });
  });

  it('shows the transcript as it arrives', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.peer.event({ type: 'session.input_transcript.delta', delta: 'What is running?' });
    t.peer.event({ type: 'session.output_transcript.delta', delta: 'Two sessions.' });
    expect(t.screen().lines).toEqual([{ role: 'you', text: 'What is running?' }, { role: 'aasc', text: 'Two sessions.' }]);
  });

  it('fails with the sign-in reason, and drops a forgotten Mac from the list', async () => {
    const t = setup({ openLine: async () => ({ ok: false, message: 'This phone is no longer paired with the Mac.', macs: [] }) });
    await t.wiring.start(mac, '/');
    expect(t.screen()).toMatchObject({ phase: 'failed', message: 'This phone is no longer paired with the Mac.' });
    expect(t.host.setMacs).toHaveBeenCalledWith([]);
  });

  it('fails with a microphone message when the mic is refused', async () => {
    const t = setup({ mic: false });
    await t.wiring.start(mac, '/');
    expect(t.screen().phase).toBe('failed');
    expect(t.screen().message).toMatch(/microphone/);
    expect(t.requests).toHaveLength(0);
  });

  it("fails with the Mac's refusal and closes the peer", async () => {
    const t = setup({ callStatus: 409, callData: { success: false, error: 'Add an OpenAI API key in Settings → Voice on this Mac.' } });
    await t.wiring.start(mac, '/');
    expect(t.screen()).toMatchObject({ phase: 'failed', message: 'Add an OpenAI API key in Settings → Voice on this Mac.' });
    expect(t.peer.closed).toBe(true);
  });

  it('End call tells the Mac, stops the audio and returns to the Mac page', async () => {
    const t = setup();
    await t.wiring.start(mac, '/back');
    t.wiring.actions.endCall();
    expect(t.track.stop).toHaveBeenCalled();
    expect(t.peer.closed).toBe(true);
    expect(t.requests.some((r) => r.url === 'http://mac:3334/api/voice/call/call_1/end')).toBe(true);
    expect(t.host.backToMac).toHaveBeenCalledWith(mac, '/back');
  });

  it('mutes the mic track while live', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.toggleMute();
    expect(t.track.enabled).toBe(false);
    expect(t.screen().muted).toBe(true);
  });

  it('Pause silences the mic and AASC, and Resume puts Mute back as it was', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.toggleMute();
    t.wiring.actions.togglePause();
    expect(t.screen().paused).toBe(true);
    expect(t.track.enabled).toBe(false);
    t.wiring.actions.togglePause();
    expect(t.screen().paused).toBe(false);
    expect(t.track.enabled).toBe(false); // still muted
    t.wiring.actions.toggleMute();
    expect(t.track.enabled).toBe(true);
  });

  it('Minimize collapses and expands without touching the call', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.toggleMinimize();
    expect(t.screen()).toMatchObject({ minimized: true, phase: 'live' });
    expect(t.peer.closed).toBe(false);
    t.wiring.actions.toggleMinimize();
    expect(t.screen().minimized).toBe(false);
  });

  it('a new call starts expanded and not paused', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.togglePause();
    t.wiring.actions.toggleMinimize();
    await t.wiring.start(mac, '/');
    expect(t.screen()).toMatchObject({ paused: false, minimized: false });
  });

  it('a dropped connection fails the call and tells the Mac', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.peer.drop();
    expect(t.screen()).toMatchObject({ phase: 'failed', message: 'The call dropped.' });
    expect(t.requests.some((r) => r.url.endsWith('/call_1/end'))).toBe(true);
  });

  it('OpenAI closing the session ends the call', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.peer.event({ type: 'session.closed', reason: 'expired' });
    expect(t.screen()).toMatchObject({ phase: 'ended', message: 'The call reached its time limit.' });
  });

  it('the clock ticks while live and stops after the call', async () => {
    const t = setup();
    let clock = 1_000;
    t.host.now = () => clock;
    await t.wiring.start(mac, '/');
    clock = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.screen().now).toBe(5_000);
    t.wiring.dispose();
    clock = 9_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.screen().now).toBe(5_000);
  });

  it('reads the Voice central’s progress while live, adds each reply once, and stops after the call (Nov 22 2026)', async () => {
    let answer: { status: number; data: unknown } = {
      status: 200,
      data: { success: true, data: { central: { title: 'Voice', state: 'working', step: 'Checking your sessions', elapsedMs: 900 }, tasks: [{ title: 'AASC docs', state: 'working' }], replies: [] } },
    };
    const t = setup({ progress: () => answer });
    await t.wiring.start(mac, '/');
    expect(t.screen().central).toBeNull();
    t.peer.event({ type: 'session.output_transcript.delta', delta: 'Let me check.' });
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
    expect(t.screen().central).toEqual({ title: 'Voice', state: 'working', step: 'Checking your sessions', since: 100 });
    expect(t.screen().tasks).toEqual([{ title: 'AASC docs', state: 'working' }]);
    answer = {
      status: 200,
      data: { success: true, data: { central: { title: 'Voice', state: 'idle', step: null, elapsedMs: null }, tasks: [], replies: [{ at: 1_500, text: 'v2.10.80 adds dictation.' }] } },
    };
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
    expect(t.screen().lines).toEqual([{ role: 'aasc', text: 'Let me check.' }, { role: 'central', text: 'v2.10.80 adds dictation.' }]);
    const polls = t.requests.filter((r) => r.url === 'http://mac:3334/api/voice/call/call_1/progress').length;
    t.wiring.dispose();
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 3);
    expect(t.requests.filter((r) => r.url.endsWith('/progress'))).toHaveLength(polls);
  });

  it('keeps the last progress when a read fails', async () => {
    let ok = true;
    const t = setup({
      progress: () => (ok
        ? { status: 200, data: { success: true, data: { central: { title: 'Voice', state: 'working', step: 'Thinking', elapsedMs: 1 }, tasks: [], replies: [] } } }
        : { status: 503, data: {} }),
    });
    await t.wiring.start(mac, '/');
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
    ok = false;
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
    expect(t.screen().central?.step).toBe('Thinking');
  });

  it('a new call starts with no progress and shows the same reply again', async () => {
    const reply = { status: 200, data: { success: true, data: { central: null, tasks: [], replies: [{ at: 7, text: 'Hello.' }] } } };
    const t = setup({ progress: () => reply });
    await t.wiring.start(mac, '/');
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
    await t.wiring.start(mac, '/');
    expect(t.screen()).toMatchObject({ central: null, tasks: [], lines: [] });
    await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
    expect(t.screen().lines).toEqual([{ role: 'central', text: 'Hello.' }]);
  });

  it('fails at once when this build has no WebRTC', async () => {
    const t = setup();
    t.host.rtcEnv = () => null;
    await t.wiring.start(mac, '/');
    expect(t.screen().phase).toBe('failed');
  });
});
