// voiceCall.ts — the shell's side of a voice call to the Mac (Nov 15 2026).
//
// The Mac's phone page sends the WebView here with `?call=1&back=/path` (src/lib/platform.ts nativeShellCallUrl):
// the shell page (capacitor://localhost, https://localhost) is a secure context, so it can use the microphone; the
// Mac's own page, served over plain http, cannot. The shell signs in with the pairing key like a share does, sends
// its WebRTC offer to the Mac (POST /api/voice/call), and talks to OpenAI directly with the answer it gets back. The
// Mac holds the OpenAI key and drives the call; this side only carries the audio and shows the transcript.
import { bearer, field, jsonHeaders, type HttpRequester } from './http.js';
import { parseReauthRequest } from './reauth.js';
import type { CallBubble } from './native.js';

export const CALL_MESSAGES = {
  offline: 'Can’t reach the Mac right now.',
  unpaired: 'This phone is no longer paired with the Mac.',
  pending: 'The Mac hasn’t allowed this phone yet.',
  oldMac: 'This Mac’s AASC has no voice calls yet. Update AASC on the Mac.',
  failed: 'The call couldn’t start.',
  microphone: 'AASC can’t use the microphone. Allow it in Settings, then try again.',
  dropped: 'The call dropped.',
} as const;

/** The Mac's page asking for a call: `?call=1&back=/path`; `back` goes through the re-auth rule (a path, nothing else). */
export function parseCallRequest(search: string): { back: string } | null {
  const p = new URLSearchParams(search);
  if (p.get('call') !== '1') return null;
  return parseReauthRequest(`?reauth=1&back=${encodeURIComponent(p.get('back') ?? '/')}`);
}

/** Where the call's requests go, signed in. */
export interface CallLine {
  origin: string;
  token: string;
}

export type CallStart = { ok: true; callId: string; sdp: string } | { ok: false; message: string };

export async function requestCall(http: HttpRequester, line: CallLine, sdp: string): Promise<CallStart> {
  let res;
  try {
    res = await http.request({
      method: 'POST', url: `${line.origin}/api/voice/call`, headers: jsonHeaders(line.token), body: { sdp }, timeoutMs: 20_000,
    });
  } catch {
    return { ok: false, message: CALL_MESSAGES.offline };
  }
  if (res.status === 404) return { ok: false, message: CALL_MESSAGES.oldMac };
  if (res.status !== 201) {
    const reason = field(res.data, ['error']);
    return { ok: false, message: typeof reason === 'string' && reason ? reason.slice(0, 200) : CALL_MESSAGES.failed };
  }
  const callId = field(res.data, ['data', 'callId']);
  const answer = field(res.data, ['data', 'sdp']);
  if (typeof callId !== 'string' || typeof answer !== 'string' || !answer) return { ok: false, message: CALL_MESSAGES.failed };
  return { ok: true, callId, sdp: answer };
}

/** Tells the Mac the call is over. Best effort: the Mac also ends a call whose audio stopped. */
export async function requestEnd(http: HttpRequester, line: CallLine, callId: string): Promise<void> {
  await http.request({
    method: 'POST', url: `${line.origin}/api/voice/call/${encodeURIComponent(callId)}/end`, headers: jsonHeaders(line.token), body: {}, timeoutMs: 5_000,
  }).catch(() => undefined);
}

/** `central`: the Voice central's own reply, word for word (Nov 22 2026); the voice says it in its own words. */
export type CallRole = 'you' | 'aasc' | 'central';

export type CallEffect =
  | { kind: 'transcript'; role: CallRole; delta: string }
  | { kind: 'started' }
  | { kind: 'closed'; reason: string };

/** What a GPT-Live event on the data channel means for the screen, or null. */
export function callEventEffect(event: unknown): CallEffect | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: unknown; delta?: unknown; reason?: unknown };
  switch (e.type) {
    case 'session.input_transcript.delta':
      return typeof e.delta === 'string' ? { kind: 'transcript', role: 'you', delta: e.delta } : null;
    case 'session.output_transcript.delta':
      return typeof e.delta === 'string' ? { kind: 'transcript', role: 'aasc', delta: e.delta } : null;
    case 'session.started':
      return { kind: 'started' };
    case 'session.closed':
      return { kind: 'closed', reason: typeof e.reason === 'string' ? e.reason : 'closed' };
    default:
      return null;
  }
}

export interface CallTranscriptLine {
  role: CallRole;
  text: string;
}

/** The screen keeps this many lines. */
export const TRANSCRIPT_LINES = 40;

export function addTranscript(lines: readonly CallTranscriptLine[], role: CallRole, delta: string, max = TRANSCRIPT_LINES): CallTranscriptLine[] {
  const last = lines[lines.length - 1];
  if (last && last.role === role) return [...lines.slice(0, -1), { role, text: last.text + delta }];
  return [...lines, { role, text: delta }].slice(-max);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** What the floating call bubble shows for a call screen (Nov 22 2026). */
export function callBubble(s: {
  paused: boolean; muted: boolean; startedAt: number | null; now: number;
  central: { state: CentralState } | null; tasks: ReadonlyArray<{ state: TaskState }>;
}): CallBubble {
  return {
    label: s.paused ? 'Paused' : formatDuration(s.now - (s.startedAt ?? s.now)),
    state: s.paused ? 'paused' : s.muted ? 'muted' : 'live',
    alert: s.central?.state === 'needs_you' || s.tasks.some((t) => t.state === 'needs_you'),
  };
}

/** The path (with query and hash) of `url` when it is on `origin` and a path the shell may return to; else null. */
export function pageOn(url: string | null, origin: string): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== new URL(origin).origin) return null;
  const path = `${u.pathname}${u.search}${u.hash}`;
  return parseReauthRequest(`?reauth=1&back=${encodeURIComponent(path)}`)?.back === path ? path : null;
}

// ── The Voice central's progress (Nov 22 2026) ──────────────────────────────────────────────────────────────────
// The phone hears only OpenAI's transcript, so it asks the Mac what the Voice central is doing
// (GET /api/voice/call/:id/progress, server/voice/callProgress.ts) every few seconds while the call is live.

export type CentralState = 'working' | 'needs_you' | 'idle' | 'offline';
export type TaskState = 'working' | 'needs_you' | 'stalled' | 'finished' | 'failed' | 'cancelled';

export interface CentralProgress {
  title: string;
  state: CentralState;
  /** The step it is on, in plain words; null when it is not working on this call's question. */
  step: string | null;
  /** How long it has been on this call's question; null when it is not on one. A duration, not the Mac's clock. */
  elapsedMs: number | null;
}

/** The central as the screen keeps it: `since` on this phone's clock (read time − elapsedMs). */
export interface CentralOnScreen {
  title: string;
  state: CentralState;
  step: string | null;
  since: number | null;
}

/** Puts a read's `elapsedMs` on this phone's clock, so the screen's ticking clock can count on from it. */
export function centralOnScreen(c: CentralProgress | null, readAt: number): CentralOnScreen | null {
  if (!c) return null;
  return { title: c.title, state: c.state, step: c.step, since: c.elapsedMs === null ? null : readAt - c.elapsedMs };
}

export interface CallProgress {
  central: CentralProgress | null;
  tasks: Array<{ title: string; state: TaskState }>;
  replies: Array<{ at: number; text: string }>;
}

const CENTRAL_STATES: readonly string[] = ['working', 'needs_you', 'idle', 'offline'];
const TASK_STATES: readonly string[] = ['working', 'needs_you', 'stalled', 'finished', 'failed', 'cancelled'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The Mac's progress answer, keeping only well-formed parts; null when it isn't one. */
export function parseProgress(data: unknown): CallProgress | null {
  if (!isObj(data)) return null;
  const c = data.central;
  const central: CentralProgress | null = isObj(c) && typeof c.title === 'string'
    ? {
        title: c.title,
        state: CENTRAL_STATES.includes(String(c.state)) ? (c.state as CentralState) : 'working',
        step: typeof c.step === 'string' ? c.step : null,
        elapsedMs: isFiniteNum(c.elapsedMs) && c.elapsedMs >= 0 ? c.elapsedMs : null,
      }
    : null;
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.filter((t): t is { title: string; state: TaskState } => isObj(t) && typeof t.title === 'string' && TASK_STATES.includes(String(t.state)))
      .map((t) => ({ title: t.title, state: t.state }))
    : [];
  const replies = Array.isArray(data.replies)
    ? data.replies.filter((r): r is { at: number; text: string } => isObj(r) && isFiniteNum(r.at) && typeof r.text === 'string')
      .map((r) => ({ at: r.at, text: r.text }))
    : [];
  return { central, tasks, replies };
}

/** What the Voice central is doing for this call, or null (an older Mac, a refusal, no network). Never throws. */
export async function requestProgress(http: HttpRequester, line: CallLine, callId: string): Promise<CallProgress | null> {
  try {
    const res = await http.request({
      method: 'GET', url: `${line.origin}/api/voice/call/${encodeURIComponent(callId)}/progress`, headers: bearer(line.token), timeoutMs: 5_000,
    });
    return res.status === 200 ? parseProgress(field(res.data, ['data'])) : null;
  } catch {
    return null;
  }
}

/** Adds each reply not yet shown as a Central line (by its `at`); the same lines back when there is nothing new. */
export function addCentralReplies(
  lines: readonly CallTranscriptLine[], seen: readonly number[], replies: CallProgress['replies'], max = TRANSCRIPT_LINES,
): { lines: readonly CallTranscriptLine[]; seen: readonly number[] } {
  const fresh = replies.filter((r) => !seen.includes(r.at) && r.text.trim() !== '');
  if (fresh.length === 0) return { lines, seen };
  return {
    lines: [...lines, ...fresh.map((r) => ({ role: 'central' as const, text: r.text }))].slice(-max),
    seen: [...seen, ...fresh.map((r) => r.at)],
  };
}
