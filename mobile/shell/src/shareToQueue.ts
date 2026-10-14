// shareToQueue.ts — text shared from another app → a session's queue, paused (AASC-21 M5).
//
// The Mac's POST /api/sessions/:id/queue/items (server/apiRouter.ts) appends one
// prompt PAUSED: it never runs on its own, even with Auto-Enter on, so shared
// text can't execute in an agent unseen (plan 08 §5). The UI must say so.
// The phone may append only to sessions shared with it: a hidden session is a
// 404 (the remote-visibility gate), so is one that ended.
//
// The native share extension (iOS) / ACTION_SEND intent (Android) only hands the
// text to the app (README "Native hooks"); everything else happens here.
import type { SessionResult } from './pairingClient.js';
import { jsonHeaders, type HttpRequester } from './http.js';
import { SESSION_REF, type SessionLite, type SessionStatus } from './sessions.js';
import { cleanMultiline } from './text.js';

/** The Mac's limit is 64 * 1024 UTF-16 units; 64 KB of UTF-8 is never more than that. */
export const SHARE_MAX_BYTES = 64 * 1024;

export const SHARE_MESSAGES = {
  added: 'Added paused — turn it on in the queue to send',
  empty: 'There is no text to add.',
  notShared: "That session isn't shared with this phone any more. Nothing was added.",
  queueFull: "That session's queue is full. Remove some items first. Nothing was added.",
  offline: "Can't reach the Mac. Nothing was added.",
  pending: 'Approve this phone on your Mac first. Nothing was added.',
  unpaired: 'This Mac removed this phone. Pair again to share to it.',
} as const;

export type PreparedText =
  | { ok: true; text: string; bytes: number }
  | { ok: false; reason: 'empty' | 'too-large' | 'not-text'; message: string };

function kilobytes(bytes: number): number {
  return Math.ceil(bytes / 1024);
}

/**
 * Clean shared text: line endings normalised, terminal escapes and control and
 * bidi characters removed, trimmed. Too long is refused rather than cut: a
 * prompt cut in the middle could mean something else.
 */
export function prepareSharedText(raw: unknown): PreparedText {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-text', message: 'Only text can be added to a queue.' };
  const text = cleanMultiline(raw).trim();
  if (!text) return { ok: false, reason: 'empty', message: SHARE_MESSAGES.empty };
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > SHARE_MAX_BYTES) {
    return { ok: false, reason: 'too-large', message: `Too long for a queue: ${kilobytes(bytes)} KB (the limit is 64 KB). Nothing was added.` };
  }
  return { ok: true, text, bytes };
}

export interface ShareTarget {
  sessionId: string;
  title: string;
  status: SessionStatus;
}

/**
 * Sessions the text can go to: every listed one (the Mac lists only shared
 * sessions to a phone) except ended ones, most recently active first, the one
 * used last on top.
 */
export function shareTargets(sessions: readonly SessionLite[], preferredId: string | null = null): ShareTarget[] {
  return sessions
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => {
      if (a.sessionId === preferredId) return -1;
      if (b.sessionId === preferredId) return 1;
      return b.lastActivityAt - a.lastActivityAt || a.title.localeCompare(b.title);
    })
    .map(({ sessionId, title, status }) => ({ sessionId, title, status }));
}

export type ShareResult =
  | { status: 'added'; message: string }
  | { status: 'invalid' | 'not-shared' | 'queue-full' | 'offline' | 'signed-out' | 'pending' | 'unpaired' | 'error'; message: string };

/** One POST with a session token from /api/mobile/session. */
export async function postSharedText(http: HttpRequester, origin: string, sessionToken: string, sessionId: string, text: string): Promise<ShareResult> {
  if (!SESSION_REF.test(sessionId)) return { status: 'not-shared', message: SHARE_MESSAGES.notShared };
  let res;
  try {
    res = await http.request({
      method: 'POST',
      url: `${origin}/api/sessions/${encodeURIComponent(sessionId)}/queue/items`,
      headers: jsonHeaders(sessionToken),
      body: { text },
    });
  } catch {
    return { status: 'offline', message: SHARE_MESSAGES.offline };
  }
  switch (res.status) {
    case 200:
      return { status: 'added', message: SHARE_MESSAGES.added };
    case 404:
      return { status: 'not-shared', message: SHARE_MESSAGES.notShared };
    case 413:
      return { status: 'queue-full', message: SHARE_MESSAGES.queueFull };
    case 400:
      return { status: 'invalid', message: 'The Mac refused this text. Nothing was added.' };
    case 401:
      return { status: 'signed-out', message: 'Signed out of the Mac. Try again.' };
    default:
      return { status: 'error', message: `Couldn't add it (${res.status}). Nothing was added.` };
  }
}

export interface ShareDeps {
  http: HttpRequester;
  /** The Mac's reachable origin (connectionPlan.pickReachable), or null when none answered. */
  origin: string | null;
  /** openSession for that origin. */
  signIn(origin: string): Promise<SessionResult>;
}

/** Clean, sign in, append. Every failure says whether anything was added (it never is). */
export async function shareToQueue(raw: unknown, sessionId: string, deps: ShareDeps): Promise<ShareResult> {
  const prepared = prepareSharedText(raw);
  if (!prepared.ok) return { status: 'invalid', message: prepared.message };
  if (!deps.origin) return { status: 'offline', message: SHARE_MESSAGES.offline };
  const session = await deps.signIn(deps.origin);
  switch (session.status) {
    case 'ok':
      return postSharedText(deps.http, deps.origin, session.token, sessionId, prepared.text);
    case 'pending':
      return { status: 'pending', message: SHARE_MESSAGES.pending };
    case 'revoked':
      return { status: 'unpaired', message: SHARE_MESSAGES.unpaired };
    case 'unreachable':
      return { status: 'offline', message: SHARE_MESSAGES.offline };
    case 'error':
      return { status: 'error', message: `${session.message}. Nothing was added.` };
  }
}
