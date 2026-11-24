// voiceCall.ts — one voice call, driven from the Mac over GPT-Live's sideband.
//
//   attached            → session.thinking.append(status digest)       silent context for instant answers
//   transcript deltas   → the call's own transcript (transcriptLog.ts)
//   delegation.created  → brain.ask(what the person said since the last one)
//                       → session.commentary.append(answer, that delegation's id)   the voice says it
//                       → replies(): the answer word for word, and busySince() while it is asked (callProgress.ts)
//   sessions change     → a fresh digest if it changed (silent), and "X finished" / "X needs you" said aloud
//   every spoken update → through turnGate.ts (Nov 22 2026): held while the person is talking, said after QUIET_MS
//   session.closed, end(), or IDLE_MS of silence → the call ends
//   sideband lost       → re-attached (REATTACH_DELAYS_MS); OpenAI replays the last 3 s, de-duplicated here
//
// Delegations run one after another (the brain answers one question at a time). Interrupting the voice does not
// cancel anything: work already handed to the Voice central keeps running. Ending the call drops the questions
// still waiting (their AbortSignal), so a new call never waits behind an old one's.

import { rmSync } from 'fs';
import log from '../logger.js';
import { buildDigest, statusChanges, type DigestSession } from './digest.js';
import type { AskOptions } from './brain.js';
import type { LiveEvent, Sideband } from './liveApi.js';
import type { CallReply } from './callProgress.js';
import { createPendingList, type CallAttachment } from './callAttach.js';
import { createTranscriptLog, type TranscriptLine } from './transcriptLog.js';
import { createTurnGate, type TurnUpdate } from './turnGate.js';
import { BRAIN_CONTEXT_MAX, brainPrompt, finishPrompt, splitScreen, toSpeakable } from './voiceText.js';

/** A call with no speech for this long hangs up: GPT-Live bills every minute, silence included. */
export const IDLE_MS = 10 * 60_000;

/** After a delegation, wait this long for the transcript of what was just said to arrive. */
const TRANSCRIPT_SETTLE_MS = 600;

/** Session changes are gathered this long before a digest or an announcement is sent. */
const CHANGES_DEBOUNCE_MS = 2_000;

/** …but never longer than this: busy agents send updates several times a second, which would starve a pure debounce. */
const CHANGES_MAX_WAIT_MS = 5_000;

/** Waits before each try at re-attaching a lost sideband; after the last one fails the call is given up. */
export const REATTACH_DELAYS_MS = [1_000, 2_000, 4_000];

/** Event ids remembered across re-attaches (OpenAI replays the last 3 s on each attach). */
const SEEN_EVENTS_MAX = 500;

/** After `session.close`, the socket is dropped this long later if OpenAI has not closed it. */
const CLOSE_GRACE_MS = 3_000;

export interface VoiceCallDeps {
  sideband: Sideband;
  /** A new sideband on the same OpenAI session, for when the first one drops. */
  reattach?: () => Sideband;
  brain: { ask(compose: (tag: string) => string, opts: AskOptions): Promise<string> };
  /** A call from this Mac; a remote call may only ask a shared central (re-checked per question). */
  isLocal: boolean;
  /** Questions this call may hand the Voice central per minute (a phone's prompt budget); unlimited by default. */
  asksPerMinute?: number;
  /** The sessions this call may hear about (already filtered for the calling device). */
  sessions(): DigestSession[];
  /** voiceContext.ts: what the Voice central is told with these words (sessions, skills, how to act); '' for nothing. */
  briefing?(request: string): string;
  onSessionsChanged(listener: () => void): () => void;
  /**
   * The sessions this call gave work to (the Voice central's tasks since the call began), session id → its task id.
   * When one of them finishes, the Voice central is asked what it did and found, and the call says that (Nov 23 2026);
   * any other session that finishes is only named.
   */
  touched?(): ReadonlyMap<string, string | null>;
  /** Lines AASC tells the call without being asked (a model or effort change the CLI confirmed). */
  onNote?(listener: (text: string) => void): () => void;
  now?: () => number;
  idleMs?: number;
  /** Test seam for REATTACH_DELAYS_MS. */
  reattachDelaysMs?: readonly number[];
}

export interface VoiceCall {
  isActive(): boolean;
  end(): void;
  onEnded(listener: (reason: string) => void): () => void;
  transcript(): readonly TranscriptLine[];
  /** Each answer of the Voice central, word for word, oldest first (callProgress.ts shows them on the phone). */
  replies(): readonly CallReply[];
  /** When the question now with the Voice central was handed over; null when none is. */
  busySince(): number | null;
  /**
   * Holds a photo, video, file or skill the person added on the call screen until their next question takes it
   * to the Voice central (Nov 24 2026); null once the call ended or the list is full (callAttach.ts).
   */
  attach(item: Omit<CallAttachment, 'id'>): CallAttachment | null;
  /** Takes one back before it was asked about; false when it is not held. */
  detach(id: string): boolean;
  /** What the next question will carry. */
  pending(): readonly CallAttachment[];
}

/** Replies kept per call; older ones are dropped. */
export const REPLIES_KEPT = 20;

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** The words a failed brain call is answered with. */
function spokenFailure(err: unknown): string {
  const spoken = (err as { spoken?: unknown } | null)?.spoken;
  return typeof spoken === 'string' ? spoken : 'Something went wrong in AASC, so I could not do that.';
}

export function startVoiceCall(deps: VoiceCallDeps): VoiceCall {
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const reattachDelays = deps.reattachDelaysMs ?? REATTACH_DELAYS_MS;
  let sb = deps.sideband;
  const log_ = createTranscriptLog();
  const aborter = new AbortController();
  const seenEvents = new Set<string>();
  const askTimes: number[] = [];
  const endedListeners = new Set<(reason: string) => void>();

  let active = true;
  let seq = 0;
  let lastDigest = '';
  let lastDelegationOffset = 0;
  let replies: CallReply[] = [];
  let busySince: number | null = null;
  let statuses = new Map(deps.sessions().map((s) => [s.sessionId, s.status]));
  let work: Promise<void> = Promise.resolve();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let changesSince: number | null = null;
  let reattachTimer: ReturnType<typeof setTimeout> | undefined;
  let sidebandUnsubs: Array<() => void> = [];
  let reattachTries = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const gate = createTurnGate();
  const added = createPendingList();
  let gateTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (event: LiveEvent): void => {
    if (active) sb.send({ ...event, event_id: `aasc_${(seq += 1)}` });
  };

  /** Say an update now, or once the person has finished their turn (turnGate.ts). */
  function say(update: TurnUpdate): void {
    sayAll(gate.push(update, now()));
  }

  function sayAll(updates: ReturnType<typeof gate.due>): void {
    for (const u of updates) send({ type: 'session.commentary.append', delegation_id: u.delegationId, content: u.content });
    clearTimeout(gateTimer);
    const at = gate.nextCheckAt();
    if (at !== null && active) gateTimer = setTimeout(() => sayAll(gate.due(now())), Math.max(0, at - now()));
  }

  function sendDigest(): void {
    const digest = buildDigest(deps.sessions(), now());
    if (digest === lastDigest) return;
    lastDigest = digest;
    send({ type: 'session.thinking.append', delegation_id: null, content: digest });
  }

  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log.info('voice', 'Hanging up a call that has been silent too long');
      end();
    }, idleMs);
  }

  function announceChanges(): void {
    changesSince = null;
    if (!active) return;
    const next = deps.sessions();
    const { finished, finishedIds, needsUser } = statusChanges(statuses, next);
    statuses = new Map(next.map((s) => [s.sessionId, s.status]));
    sendDigest();
    if (finished.length > 0 || needsUser.length > 0) say({ kind: 'status', finished, needsUser });
    const touched = touchedNow();
    finishedIds.forEach((id, i) => {
      if (touched.has(id)) summarize(finished[i], touched.get(id) ?? null);
    });
  }

  function touchedNow(): ReadonlyMap<string, string | null> {
    try {
      return deps.touched?.() ?? new Map();
    } catch (err) {
      log.warn('voice', `Reading the call's sessions failed: ${err instanceof Error ? err.message : String(err)}`);
      return new Map();
    }
  }

  /** Asks the Voice central what a session this call gave work to did and found, and says it (held while the person talks). */
  function summarize(title: string, taskId: string | null): void {
    work = work.then(async () => {
      if (!active) return;
      try {
        busySince = now();
        const answer = await deps.brain.ask((tag) => finishPrompt({ title, taskId, tag }), { isLocal: deps.isLocal, signal: aborter.signal });
        const { speech, screen } = splitScreen(answer);
        replies = [...replies, { at: now(), text: speech, ...(screen ? { screen } : {}) }].slice(-REPLIES_KEPT);
        if (active) say({ kind: 'note', content: toSpeakable(speech) });
      } catch (err) {
        log.warn('voice', `A finished session's summary failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busySince = null;
      }
    });
  }

  function onSessionsChanged(): void {
    const at = now();
    changesSince ??= at;
    clearTimeout(changeTimer);
    const wait = Math.max(0, Math.min(CHANGES_DEBOUNCE_MS, changesSince + CHANGES_MAX_WAIT_MS - at));
    changeTimer = setTimeout(announceChanges, wait);
  }

  /** Whether a remote call still has room in its per-minute question budget (and counts this one). */
  function takeAsk(): boolean {
    const limit = deps.asksPerMinute ?? Infinity;
    if (!Number.isFinite(limit)) return true;
    const at = now();
    while (askTimes.length > 0 && at - askTimes[0] >= 60_000) askTimes.shift();
    if (askTimes.length >= limit) return false;
    askTimes.push(at);
    return true;
  }

  /** The briefing for these words; a failure costs only the briefing, never the question. */
  function briefingFor(request: string): string {
    try {
      return deps.briefing?.(request) ?? '';
    } catch (err) {
      log.warn('voice', `The briefing failed: ${err instanceof Error ? err.message : String(err)}`);
      return '';
    }
  }

  function onDelegation(delegationId: string, offsetMs: number): void {
    const since = lastDelegationOffset;
    lastDelegationOffset = offsetMs;
    work = work.then(async () => {
      await new Promise((r) => setTimeout(r, TRANSCRIPT_SETTLE_MS));
      if (!active) return;
      const request = log_.userSince(since);
      const context = log_.recent(BRAIN_CONTEXT_MAX);
      let content: string;
      let withIt: readonly CallAttachment[] = [];
      try {
        if (!takeAsk()) {
          content = 'That is a lot of requests in one minute. Wait a moment and ask me again.';
        } else {
          const brief = briefingFor(request);
          // What was added on the call screen goes with this question, once (Nov 24 2026).
          withIt = added.take();
          busySince = now();
          const answer = await deps.brain.ask((tag) => brainPrompt({ request, context, tag, briefing: brief, added: withIt }), { isLocal: deps.isLocal, signal: aborter.signal });
          // Only the spoken part is said; the on-screen part (a table, code) goes to the call screen (Nov 23 2026).
          const { speech, screen } = splitScreen(answer);
          replies = [...replies, { at: now(), text: speech, ...(screen ? { screen } : {}) }].slice(-REPLIES_KEPT);
          content = toSpeakable(speech);
        }
      } catch (err) {
        log.warn('voice', `A delegation failed: ${err instanceof Error ? err.message : String(err)}`);
        content = spokenFailure(err);
        // The central never answered: what was added waits for the next question instead of being lost.
        // (A call that ended meanwhile deletes them: nothing will take them now.)
        removeFiles(active ? added.putBack(withIt) : withIt);
      } finally {
        busySince = null;
      }
      if (active) say({ kind: 'answer', delegationId, content });
    });
  }

  function onEvent(event: LiveEvent): void {
    // A re-attach replays the last 3 s: each event is handled once across sidebands.
    if (typeof event.event_id === 'string') {
      if (seenEvents.has(event.event_id)) return;
      seenEvents.add(event.event_id);
      if (seenEvents.size > SEEN_EVENTS_MAX) seenEvents.delete(seenEvents.values().next().value as string);
    }
    switch (event.type) {
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (typeof event.delta !== 'string') return;
        const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
        log_.add(role, event.delta, num(event.start_ms), num(event.end_ms, num(event.start_ms)));
        if (role === 'user') {
          armIdle();
          gate.heard(now());
        }
        return;
      }
      case 'session.delegation.created': {
        const d = event.delegation as { id?: unknown; target?: unknown } | undefined;
        if (typeof d?.id === 'string' && d.target === 'client') onDelegation(d.id, num(event.offset_ms));
        return;
      }
      case 'session.closed':
        finish(typeof event.reason === 'string' ? event.reason : 'closed');
        return;
      case 'error': {
        const e = event.error as { code?: unknown; message?: unknown } | undefined;
        log.warn('voice', `GPT-Live error ${String(e?.code ?? '')}: ${String(e?.message ?? '').slice(0, 200)}`);
        return;
      }
      default:
    }
  }

  function bindSideband(next: Sideband): void {
    sb = next;
    sidebandUnsubs = [next.onEvent(onEvent), next.onClose(() => onSidebandLost(next))];
    next.ready.then(() => {
      if (!active || sb !== next) return;
      reattachTries = 0;
      sendDigest();
    }, () => {});
  }

  /** The Mac lost its line to the call while OpenAI and the phone may still be talking: attach again. */
  function onSidebandLost(lost: Sideband): void {
    if (!active || sb !== lost) return;
    for (const u of sidebandUnsubs) u();
    sidebandUnsubs = [];
    if (!deps.reattach || reattachTries >= reattachDelays.length) { finish('connection_lost'); return; }
    const delay = reattachDelays[reattachTries];
    reattachTries += 1;
    log.warn('voice', `Lost the call's sideband; attaching again (try ${reattachTries})`);
    reattachTimer = setTimeout(() => {
      if (!active || sb !== lost) return;
      try {
        lastDigest = '';
        bindSideband((deps.reattach as () => Sideband)());
      } catch {
        onSidebandLost(lost);
      }
    }, delay);
  }

  const unsubscribers = [
    deps.onSessionsChanged(onSessionsChanged),
    ...(deps.onNote ? [deps.onNote((text) => { if (active && text.trim()) say({ kind: 'note', content: text }); })] : []),
  ];

  /** Deletes the saved files of attachments that will never reach the central. */
  function removeFiles(items: readonly CallAttachment[]): void {
    for (const a of items) if (a.path) rmSync(a.path, { force: true });
  }

  function finish(reason: string): void {
    if (!active) return;
    active = false;
    removeFiles(added.take());
    aborter.abort();
    clearTimeout(changeTimer);
    clearTimeout(idleTimer);
    clearTimeout(closeTimer);
    clearTimeout(reattachTimer);
    clearTimeout(gateTimer);
    gate.clear();
    for (const u of [...unsubscribers, ...sidebandUnsubs]) u();
    sb.close();
    for (const l of [...endedListeners]) l(reason);
  }

  function end(): void {
    if (!active) return;
    send({ type: 'session.close' });
    closeTimer = setTimeout(() => finish('close_requested'), CLOSE_GRACE_MS);
  }

  bindSideband(sb);
  armIdle();

  return {
    isActive: () => active,
    end,
    onEnded(listener) {
      endedListeners.add(listener);
      return () => endedListeners.delete(listener);
    },
    transcript: () => log_.lines(),
    replies: () => replies,
    busySince: () => busySince,
    attach(item) {
      if (!active) return null;
      const held = added.add(item);
      // The voice can't see it; it should hand it to AASC with the next request rather than say it can't.
      if (held) {
        const what = held.kind === 'skill' ? `the command ${held.name}` : `a ${held.kind} (${held.name})`;
        send({
          type: 'session.thinking.append',
          delegation_id: null,
          content: `The user just added ${what} on the call screen. You cannot see it; AASC gets it with their next request, so delegate that request as usual.`,
        });
      }
      return held;
    },
    detach: (id) => active && added.remove(id),
    pending: () => added.items(),
  };
}
