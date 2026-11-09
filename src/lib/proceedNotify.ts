/**
 * proceedNotify — the desktop app's system notification for a session whose last answer asks the
 * user to reply "proceed" (`pendingProceedAt`, the amber P; Nov 8 2026). Pure rules, driven by
 * useProceedNotifications:
 *
 *   newProceedAsks   which sessions asked since the last look (a first sighting never counts, so a
 *                    launch or reconnect doesn't bring every standing P back as a notification)
 *   shouldShowProceed after the settle: still the same ask, not muted, setting on, and the user is
 *                    not already looking at that session
 *   proceedNotice    what the notification says: the session's name only, never the answer's text
 *
 * The phone's version of this is the push (server/push/pushNotifier.ts sends such a turn as `input`).
 */
import { sessionDisplayTitle } from './sessionDisplayTitle';

/** How long an ask must stand before it notifies: a queued prompt usually answers it within a second or two. */
export const PROCEED_NOTIFY_SETTLE_MS = 3_000;
export const PROCEED_NOTICE_TITLE_MAX = 80;
export const PROCEED_NOTICE_BODY = 'Waiting for you to proceed';

export interface ProceedSession {
  sessionId: string;
  status: string;
  pendingProceedAt?: number | null;
  muted?: boolean;
  title?: string | null;
  projectName?: string | null;
}

export interface ProceedAsk {
  sessionId: string;
  askedAt: number;
}

/** The ask a session stands on now: = owesProceed() in sessionStatusStyle.ts. */
function askOf(s: ProceedSession): number | null {
  return s.pendingProceedAt && (s.status === 'waiting' || s.status === 'idle') ? s.pendingProceedAt : null;
}

/** `seen` maps each known session to the ask it stood on at the last look (null: none). */
export function newProceedAsks(
  seen: ReadonlyMap<string, number | null>,
  sessions: Iterable<ProceedSession>,
): { asks: ProceedAsk[]; seen: Map<string, number | null> } {
  const next = new Map<string, number | null>();
  const asks: ProceedAsk[] = [];
  for (const s of sessions) {
    const askedAt = askOf(s);
    next.set(s.sessionId, askedAt);
    if (askedAt !== null && seen.has(s.sessionId) && seen.get(s.sessionId) !== askedAt) {
      asks.push({ sessionId: s.sessionId, askedAt });
    }
  }
  return { asks, seen: next };
}

export interface ProceedNotifyContext {
  enabled: boolean;
  /** The app's window has focus. */
  focused: boolean;
  /** The session open in the detail panel, if any. */
  openSessionId: string | null;
}

export function shouldShowProceed(session: ProceedSession | undefined, askedAt: number, ctx: ProceedNotifyContext): boolean {
  if (!session || !ctx.enabled || session.muted) return false;
  if (askOf(session) !== askedAt) return false; // answered, or a newer ask took its place
  return !(ctx.focused && ctx.openSessionId === session.sessionId);
}

export interface ProceedNotice {
  sessionId: string;
  title: string;
  body: string;
}

export function proceedNotice(session: ProceedSession): ProceedNotice {
  // eslint-disable-next-line no-control-regex -- flattening control characters is the point
  const flat = sessionDisplayTitle(session).replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = flat.length > PROCEED_NOTICE_TITLE_MAX ? `${flat.slice(0, PROCEED_NOTICE_TITLE_MAX - 1)}…` : flat;
  return { sessionId: session.sessionId, title: title || 'Session', body: PROCEED_NOTICE_BODY };
}
