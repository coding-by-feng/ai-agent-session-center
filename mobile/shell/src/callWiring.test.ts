import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCallWiring, PROGRESS_POLL_MS, type CallHost, type LineResult } from './callWiring.js';
import type { HttpRequest } from './http.js';
import type { CallBubble, CallLayer } from './native.js';
import type { SavedMac } from './savedMacs.js';
import type { Screen } from './ui/screen.js';
import type { ChannelLike, PeerLike, RtcEnv } from './voiceRtc.js';
import type { CallAddHandlers } from './ui/callAddSheet.js';
import { CALL_FILE_MAX_BYTES } from './callAdd.js';

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

/** The app's call layer, as the native plugins behave: one page, shown or hidden, its URL kept. */
class FakeLayer implements CallLayer {
  url: string | null = null;
  visible = false;
  canShow = true;
  shown: string[] = [];
  bubbles: CallBubble[] = [];
  private listener: ((url: string | null) => void) | null = null;
  async show(url: string, bubble: CallBubble): Promise<boolean> {
    if (!this.canShow) return false;
    this.shown.push(url);
    if (!this.url || new URL(this.url).origin !== new URL(url).origin) this.url = url;
    this.visible = true;
    this.bubbles.push(bubble);
    return true;
  }
  async hide(): Promise<string | null> { this.visible = false; return this.url; }
  async close(): Promise<string | null> { const was = this.url; this.visible = false; this.url = null; return was; }
  bubble(b: CallBubble): void { this.bubbles.push(b); }
  onExpand(l: (url: string | null) => void): void { this.listener = l; }
  /** The person browses the Mac's page. */
  go(path: string): void { this.url = new URL(path, this.url ?? 'http://mac:3334').toString(); }
  /** The bubble is tapped (the native side hides itself first). */
  tap(): void { this.visible = false; this.listener?.(this.url); }
}

function setup(over: {
  openLine?: () => Promise<LineResult>; callStatus?: number; callData?: unknown; mic?: boolean; progress?: () => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>; layer?: FakeLayer;
  respond?: (req: HttpRequest) => { status: number; data: unknown } | undefined;
} = {}) {
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
        return over.respond?.(req) ?? { status: 200, data: {} };
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
    layer: over.layer ?? null,
    setCookie: vi.fn(async () => undefined),
    openAddSheet: vi.fn((handlers: CallAddHandlers) => { sheets.push(handlers); return { close: () => sheetClosed.push(handlers) }; }),
    readFile: vi.fn(async (f: Blob) => `b64:${(f as File).name}`),
  };
  const sheets: CallAddHandlers[] = [];
  const sheetClosed: CallAddHandlers[] = [];
  const wiring = createCallWiring(host);
  return { wiring, host, peer, requests, track, sheets, sheetClosed, screen: () => screen as Extract<Screen, { name: 'call' }> };
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
  describe('floating call (Nov 22 2026)', () => {
    it('Minimize signs the Mac page in and shows it over the call, which keeps running', async () => {
      const layer = new FakeLayer();
      const t = setup({ layer });
      await t.wiring.start(mac, '/more');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.host.setCookie).toHaveBeenCalledWith('http://mac:3334', 't');
      expect(layer.shown).toEqual(['http://mac:3334/more']);
      expect(layer.visible).toBe(true);
      expect(t.screen()).toMatchObject({ minimized: true, phase: 'live' });
      expect(t.peer.closed).toBe(false);
      expect(t.track.stop).not.toHaveBeenCalled();
    });

    it('the bubble follows the clock, Pause and a central that needs the person', async () => {
      let clock = 1_000;
      const layer = new FakeLayer();
      const t = setup({
        layer,
        progress: () => ({ status: 200, data: { success: true, data: { central: { title: 'Voice', state: 'needs_you', step: null, elapsedMs: null }, tasks: [], replies: [] } } }),
      });
      t.host.now = () => clock;
      await t.wiring.start(mac, '/');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      clock = 66_000;
      await vi.advanceTimersByTimeAsync(PROGRESS_POLL_MS);
      expect(layer.bubbles.at(-1)).toEqual({ label: '1:05', state: 'live', alert: true });
      t.wiring.actions.togglePause();
      expect(layer.bubbles.at(-1)).toMatchObject({ label: 'Paused', state: 'paused' });
    });

    it('tapping the bubble brings the call back; Minimize again shows the page where the person left it', async () => {
      const layer = new FakeLayer();
      const t = setup({ layer });
      await t.wiring.start(mac, '/more');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      layer.go('/?session=abc');
      layer.tap();
      expect(t.screen().minimized).toBe(false);
      const before = layer.bubbles.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(layer.bubbles.length).toBe(before); // no bubble updates while the call is on screen
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      expect(layer.shown.at(-1)).toBe('http://mac:3334/?session=abc');
    });

    it('End call drops the page and returns to where the person was on the Mac', async () => {
      const layer = new FakeLayer();
      const t = setup({ layer });
      await t.wiring.start(mac, '/more');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      layer.go('/queue');
      layer.tap();
      t.wiring.actions.endCall();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.host.backToMac).toHaveBeenCalledWith(mac, '/queue');
      expect(t.requests.some((r) => r.url.endsWith('/end'))).toBe(true);
    });

    it('a call that drops while floating comes back on screen with Back to the page the person was on', async () => {
      const layer = new FakeLayer();
      const t = setup({ layer });
      await t.wiring.start(mac, '/more');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      layer.go('/?session=x');
      t.peer.drop();
      await vi.advanceTimersByTimeAsync(0);
      expect(layer.visible).toBe(false);
      expect(layer.url).toBeNull();
      expect(t.screen()).toMatchObject({ phase: 'failed', minimized: false, back: '/?session=x' });
    });

    it('keeps the compact bar when the page can’t be shown, or the call isn’t live yet', async () => {
      const layer = new FakeLayer();
      layer.canShow = false;
      const t = setup({ layer });
      await t.wiring.start(mac, '/');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.screen().minimized).toBe(true);
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.screen().minimized).toBe(false);
    });

    it('never returns to a page off the Mac', async () => {
      const layer = new FakeLayer();
      const t = setup({ layer });
      await t.wiring.start(mac, '/more');
      t.wiring.actions.toggleMinimize();
      await vi.advanceTimersByTimeAsync(0);
      layer.url = 'http://elsewhere:80/x';
      layer.tap();
      t.wiring.actions.endCall();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.host.backToMac).toHaveBeenCalledWith(mac, '/more');
    });
  });
});

describe('＋ Add on a live call (Nov 24 2026)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const held = (id: string, kind: string, name: string) => ({ status: 201, data: { success: true, data: { item: { id, kind, name } } } });

  it('starts a call with nothing added', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    expect(t.screen()).toMatchObject({ pending: [], adding: 0, addNotice: null });
  });

  it('opens the sheet only while live', async () => {
    const t = setup();
    t.wiring.actions.openCallAdd();
    expect(t.sheets).toHaveLength(0);
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    expect(t.sheets).toHaveLength(1);
  });

  it('sends picked files to the call one after another, raw, and lists what the Mac holds', async () => {
    let n = 0;
    const t = setup({ respond: (req) => (req.url.endsWith('/attach') ? held(`att${(n += 1)}`, 'photo', `p${n}.jpg`) : undefined) });
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    t.sheets[0].addFiles([new File(['a'], 'p1.jpg', { type: 'image/jpeg' }), new File(['b'], 'p2.jpg', { type: 'image/jpeg' })]);
    expect(t.screen().adding).toBe(2);
    await vi.advanceTimersByTimeAsync(0);
    const uploads = t.requests.filter((r) => r.url === 'http://mac:3334/api/voice/call/call_1/attach');
    expect(uploads.map((r) => r.bytes)).toEqual(['b64:p1.jpg', 'b64:p2.jpg']);
    expect(uploads[0].headers).toMatchObject({ 'X-File-Name': 'p1.jpg', 'X-File-Type': 'image/jpeg' });
    expect(t.screen()).toMatchObject({ adding: 0, addNotice: null, pending: [{ id: 'att1', kind: 'photo', name: 'p1.jpg' }, { id: 'att2', kind: 'photo', name: 'p2.jpg' }] });
  });

  it('says why a file did not make it', async () => {
    const t = setup({ respond: (req) => (req.url.endsWith('/attach') ? { status: 409, data: { code: 'full', error: 'Your next question already carries 10 things' } } : undefined) });
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    t.sheets[0].addFiles([new File(['a'], 'a.txt')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.screen()).toMatchObject({ adding: 0, pending: [], addNotice: 'Your next question already carries 10 things' });
  });

  it('refuses a file over the Mac\'s cap before reading it (a huge video would crash the call)', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    const big = new File(['x'], 'big.mov', { type: 'video/quicktime' });
    Object.defineProperty(big, 'size', { value: CALL_FILE_MAX_BYTES + 1 });
    t.sheets[0].addFiles([big]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.host.readFile).not.toHaveBeenCalled();
    expect(t.requests.some((r) => r.url.endsWith('/attach'))).toBe(false);
    expect(t.screen()).toMatchObject({ adding: 0, addNotice: 'big.mov is over 100 MB.' });
  });

  it('keeps a just-added item when a read that started before it answers with the older list', async () => {
    let answerRead: (pending: unknown[]) => void = () => undefined;
    const t = setup({
      progress: () => new Promise((r) => { answerRead = (pending) => r({ status: 200, data: { success: true, data: { central: null, tasks: [], replies: [], pending } } }); }),
      respond: (req) => (req.url.endsWith('/attach') ? held('att1', 'photo', 'p.jpg') : undefined),
    });
    await t.wiring.start(mac, '/');
    await vi.advanceTimersByTimeAsync(2_000); // a read is out
    t.wiring.actions.openCallAdd();
    t.sheets[0].addFiles([new File(['a'], 'p.jpg', { type: 'image/jpeg' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.screen().pending.map((p) => p.id)).toEqual(['att1']);
    answerRead([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.screen().pending.map((p) => p.id)).toEqual(['att1']);
  });

  it('adds a picked command, reading the Voice central\'s own CLI for the list', async () => {
    const t = setup({
      progress: () => ({ status: 200, data: { success: true, data: { central: { title: 'Voice', state: 'idle', step: null, elapsedMs: null, cli: 'codex' }, tasks: [], replies: [], pending: [] } } }),
      respond: (req) => (req.url.endsWith('/skill') ? held('att1', 'skill', '$review')
        : req.url.includes('/api/commands') ? { status: 200, data: { entries: [{ name: 'review', cli: 'codex', kind: 'skill', source: 'user', description: '' }], usage: {} } }
          : undefined),
    });
    await t.wiring.start(mac, '/');
    await vi.advanceTimersByTimeAsync(2_000);
    t.wiring.actions.openCallAdd();
    expect(await t.sheets[0].loadCommands()).toEqual([{ token: '$review', description: '' }]);
    expect(t.requests.some((r) => r.url === 'http://mac:3334/api/commands?cli=codex')).toBe(true);
    t.sheets[0].pickCommand('$review');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.requests.find((r) => r.url.endsWith('/skill'))?.body).toEqual({ name: '$review' });
    expect(t.screen().pending).toEqual([{ id: 'att1', kind: 'skill', name: '$review' }]);
  });

  it('takes one back at once, and follows the Mac\'s list on each read (the next question took them)', async () => {
    let pending: unknown[] = [{ id: 'att1', kind: 'photo', name: 'a.jpg' }, { id: 'att2', kind: 'file', name: 'b.pdf' }];
    const t = setup({ progress: () => ({ status: 200, data: { success: true, data: { central: null, tasks: [], replies: [], pending } } }) });
    await t.wiring.start(mac, '/');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.screen().pending.map((p) => p.id)).toEqual(['att1', 'att2']);
    t.wiring.actions.removeCallItem('att1');
    expect(t.screen().pending.map((p) => p.id)).toEqual(['att2']);
    expect(t.requests.find((r) => r.method === 'DELETE')?.url).toBe('http://mac:3334/api/voice/call/call_1/attach/att1');
    pending = [];
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.screen().pending).toEqual([]);
  });

  it('reads and decides the call memory through the call\'s sign-in', async () => {
    const t = setup({ respond: (req) => (req.url.endsWith('/api/voice/memory')
      ? { status: 200, data: { success: true, data: { items: [{ id: 'm1', kind: 'correction', meant: 'AASC', heard: 'ASC', status: 'proposed' }] } } }
      : undefined) });
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    expect((await t.sheets[0].loadMemory())?.map((r) => r.id)).toEqual(['m1']);
    expect(await t.sheets[0].decideMemory('m1', 'keep')).toBe(true);
    expect(t.requests.find((r) => r.url.endsWith('/api/voice/memory/m1'))?.body).toEqual({ action: 'keep' });
  });

  it('closes the sheet when the call ends', async () => {
    const t = setup();
    await t.wiring.start(mac, '/');
    t.wiring.actions.openCallAdd();
    t.wiring.actions.endCall();
    expect(t.sheetClosed).toHaveLength(1);
  });
});
