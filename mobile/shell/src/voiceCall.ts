// voiceCall.ts — the shell's side of a voice call to the Mac (Nov 15 2026).
//
// The Mac's phone page sends the WebView here with `?call=1&back=/path` (src/lib/platform.ts nativeShellCallUrl):
// the shell page (capacitor://localhost, https://localhost) is a secure context, so it can use the microphone; the
// Mac's own page, served over plain http, cannot. The shell signs in with the pairing key like a share does, sends
// its WebRTC offer to the Mac (POST /api/voice/call), and talks to OpenAI directly with the answer it gets back. The
// Mac holds the OpenAI key and drives the call; this side only carries the audio and shows the transcript.
import { field, jsonHeaders, type HttpRequester } from './http.js';
import { parseReauthRequest } from './reauth.js';

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

export type CallRole = 'you' | 'aasc';

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
