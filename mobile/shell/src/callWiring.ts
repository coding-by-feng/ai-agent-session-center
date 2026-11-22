// callWiring.ts — a voice call wired into the shell app (Nov 15 2026): sign in to the Mac, open the mic and the
// WebRTC peer, hand the offer to the Mac, then keep the call screen up to date until it ends. Ending (or leaving)
// returns the WebView to the Mac's page it came from, signed in again.
import { openSession } from './pairingClient.js';
import { forgetMac, reach } from './shellFlows.js';
import type { ShellDeps } from './native.js';
import { readMacCredentials, type SavedMac } from './savedMacs.js';
import type { Actions, Screen } from './ui/screen.js';
import {
  addCentralReplies, addTranscript, callEventEffect, centralOnScreen, CALL_MESSAGES, requestCall, requestEnd, requestProgress, type CallLine,
} from './voiceCall.js';
import { createCallRtc, RtcError, type CallRtc, type RtcEnv } from './voiceRtc.js';

export type CallActions = Pick<Actions, 'endCall' | 'toggleMute' | 'togglePause' | 'toggleMinimize' | 'retryCall'>;

type CallScreen = Extract<Screen, { name: 'call' }>;

export interface CallHost {
  /** The Mac's API requests (native HTTP). */
  requester: ShellDeps['requester'];
  macs(): readonly SavedMac[];
  setMacs(next: SavedMac[]): void;
  /** Sign in to the Mac for this call (openCallLine). */
  openLine(mac: SavedMac): Promise<LineResult>;
  screen(): Screen;
  show(next: Screen): void;
  update(patch: Partial<CallScreen>): void;
  /** Back to `back` on the Mac's page, signed in again. */
  backToMac(mac: SavedMac, back: string): void;
  /** The browser's WebRTC parts, or null when this build has none. */
  rtcEnv(): RtcEnv | null;
  now(): number;
}

export interface CallWiring {
  start(mac: SavedMac, back: string): Promise<void>;
  actions: CallActions;
  dispose(): void;
}

/** How often the call's clock redraws. */
const TICK_MS = 1_000;

/** How often a live call asks the Mac what the Voice central is doing (Nov 22 2026). */
export const PROGRESS_POLL_MS = 2_000;

export type LineResult = { ok: true; line: CallLine } | { ok: false; message: string; macs?: SavedMac[] };

/** Reach the Mac and sign in with this phone's pairing key, as a share does (shareFlow.ts). */
export async function openCallLine(deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac): Promise<LineResult> {
  const reached = await reach(deps, mac);
  if (!reached) return { ok: false, message: CALL_MESSAGES.offline };
  const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
  if (!creds) return { ok: false, message: CALL_MESSAGES.unpaired, macs: await forgetMac(deps, macs, mac) };
  const session = await openSession(deps.http, reached.origin, creds);
  if (session.status === 'ok') return { ok: true, line: { origin: reached.origin, token: session.token } };
  if (session.status === 'pending') return { ok: false, message: CALL_MESSAGES.pending };
  if (session.status === 'revoked') return { ok: false, message: CALL_MESSAGES.unpaired, macs: await forgetMac(deps, macs, mac) };
  return { ok: false, message: CALL_MESSAGES.offline };
}

export function createCallWiring(host: CallHost): CallWiring {
  /** Bumped by each start and end: a late answer for an older call is dropped. */
  let gen = 0;
  let rtc: CallRtc | null = null;
  let live: { line: CallLine; callId: string } | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let poller: ReturnType<typeof setInterval> | null = null;
  /** The replies already shown as Central lines in this call (by the Mac's `at`). */
  let seenReplies: readonly number[] = [];

  const onCall = (my: number): CallScreen | null => {
    const s = host.screen();
    return my === gen && s.name === 'call' ? s : null;
  };

  /** Lets go of the audio and the clock; tells the Mac when a call was live. */
  function hangUp(): void {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    if (poller !== null) clearInterval(poller);
    poller = null;
    rtc?.close();
    rtc = null;
    const ended = live;
    live = null;
    if (ended) void requestEnd(host.requester, ended.line, ended.callId);
  }

  function fail(my: number, message: string): void {
    hangUp();
    if (onCall(my)) host.update({ phase: 'failed', message });
  }

  async function start(mac: SavedMac, back: string): Promise<void> {
    hangUp();
    gen += 1;
    const my = gen;
    seenReplies = [];
    host.show({
      name: 'call', macId: mac.id, back, phase: 'starting', message: null, muted: false, paused: false, minimized: false,
      lines: [], central: null, tasks: [], startedAt: null, now: host.now(),
    });
    const env = host.rtcEnv();
    if (!env) { fail(my, CALL_MESSAGES.failed); return; }

    const opened = await host.openLine(mac);
    if (!opened.ok && opened.macs) host.setMacs(opened.macs);
    if (!onCall(my)) return;
    if (!opened.ok) { fail(my, opened.message); return; }

    const call = createCallRtc(env);
    rtc = call;
    call.onEvent((event) => {
      const effect = callEventEffect(event);
      const s = onCall(my);
      if (!effect || !s) return;
      if (effect.kind === 'transcript') host.update({ lines: addTranscript(s.lines, effect.role, effect.delta) });
      else if (effect.kind === 'closed') {
        hangUp();
        host.update({ phase: 'ended', message: effect.reason === 'expired' ? 'The call reached its time limit.' : null });
      }
    });
    call.onDropped(() => fail(my, CALL_MESSAGES.dropped));

    let offer: string;
    try {
      offer = await call.offer();
    } catch (err) {
      fail(my, err instanceof RtcError && err.code === 'microphone' ? CALL_MESSAGES.microphone : CALL_MESSAGES.failed);
      return;
    }
    if (!onCall(my)) { call.close(); return; }

    const started = await requestCall(host.requester, opened.line, offer);
    if (!onCall(my)) {
      call.close();
      if (started.ok) void requestEnd(host.requester, opened.line, started.callId);
      return;
    }
    if (!started.ok) { fail(my, started.message); return; }
    live = { line: opened.line, callId: started.callId };
    try {
      await call.answer(started.sdp);
    } catch {
      fail(my, CALL_MESSAGES.failed);
      return;
    }
    if (!onCall(my)) return;
    host.update({ phase: 'live', startedAt: host.now(), now: host.now() });
    ticker = setInterval(() => {
      if (onCall(my)) host.update({ now: host.now() });
    }, TICK_MS);
    let reading = false;
    poller = setInterval(() => {
      const on = live;
      if (reading || !on || !onCall(my)) return;
      reading = true;
      void requestProgress(host.requester, on.line, on.callId).then((progress) => {
        reading = false;
        const s = onCall(my);
        // A failed read keeps what the screen shows; the next one tries again.
        if (!progress || !s || live !== on) return;
        const merged = addCentralReplies(s.lines, seenReplies, progress.replies);
        seenReplies = merged.seen;
        host.update({ central: centralOnScreen(progress.central, host.now()), tasks: progress.tasks, lines: [...merged.lines] });
      });
    }, PROGRESS_POLL_MS);
  }

  /** Leave the call screen for the Mac's page. */
  function leave(): void {
    const s = host.screen();
    hangUp();
    gen += 1;
    if (s.name !== 'call') return;
    const mac = host.macs().find((m) => m.id === s.macId);
    if (mac) host.backToMac(mac, s.back);
  }

  return {
    start,
    actions: {
      endCall: leave,
      toggleMute: () => {
        const s = host.screen();
        if (s.name !== 'call' || s.phase !== 'live') return;
        rtc?.setMuted(!s.muted);
        host.update({ muted: !s.muted });
      },
      togglePause: () => {
        const s = host.screen();
        if (s.name !== 'call' || s.phase !== 'live') return;
        rtc?.setPaused(!s.paused);
        host.update({ paused: !s.paused });
      },
      toggleMinimize: () => {
        const s = host.screen();
        if (s.name !== 'call' || (s.phase !== 'live' && s.phase !== 'starting')) return;
        host.update({ minimized: !s.minimized });
      },
      retryCall: () => {
        const s = host.screen();
        const mac = s.name === 'call' ? host.macs().find((m) => m.id === s.macId) : undefined;
        if (s.name === 'call' && mac) void start(mac, s.back);
      },
    },
    dispose: () => {
      hangUp();
      gen += 1;
    },
  };
}
