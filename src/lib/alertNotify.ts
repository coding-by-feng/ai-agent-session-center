/**
 * alertNotify — what a loud session shows besides its sounds (Nov 23 2026): a desktop notification when it finishes a
 * turn or needs you, and the pulsing ring on its card. Which sessions do is their alert level's (Nov 25 2026,
 * src/lib/attention.ts): notification "every moment" (Loud and Urgent by default) and the glowing card. Pure rules,
 * driven by useAlertNotifications:
 *
 *   alertKind        the moment a session stands on: 'done' (waiting), 'approval', 'input', or null
 *   newAlertMoments  which notifying sessions reached a moment since the last look (a first sighting never counts,
 *                    so a launch or reconnect doesn't bring every standing state back as a notification)
 *   shouldShowAlert  after the settle: still notifying, still that moment, and the user is not already looking at it
 *   alertNotice      the session's name and the moment, never the answer's text
 *   isAlerting       the card ring: its level glows, not the open card, and it finished or needs you
 *
 * Like the sounds, a loud level overrides the notification setting: it is the session's own ask to be loud.
 */
import type { AlertNotify } from './attention';
import { sessionDisplayTitle } from './sessionDisplayTitle';

/** How long a moment must stand before it notifies: a timer-guessed approval can clear within a second. */
export const ALERT_NOTIFY_SETTLE_MS = 1_500;
export const ALERT_NOTICE_TITLE_MAX = 80;

export type AlertKind = 'done' | 'approval' | 'input';

export const ALERT_NOTICE_BODY: Record<AlertKind, string> = {
  done: 'Finished — ready for review',
  approval: 'Needs your approval',
  input: 'Needs your answer',
};
export const ALERT_PROCEED_BODY = 'Finished — waiting for you to proceed';

export interface AlertSession {
  sessionId: string;
  status: string;
  pendingProceedAt?: number | null;
  title?: string | null;
  projectName?: string | null;
}

export interface AlertMoment {
  sessionId: string;
  kind: AlertKind;
}

export function alertKind(s: Pick<AlertSession, 'status'>): AlertKind | null {
  if (s.status === 'approval') return 'approval';
  if (s.status === 'input') return 'input';
  if (s.status === 'waiting') return 'done';
  return null;
}

/**
 * `seen` maps each known session to the moment it stood on at the last look (null: none). `notifies` says whether a
 * session's level notifies every moment (its outputs' `notify === 'all'`).
 */
export function newAlertMoments<S extends AlertSession>(
  seen: ReadonlyMap<string, AlertKind | null>,
  sessions: Iterable<S>,
  notifies: (session: S) => boolean,
): { moments: AlertMoment[]; seen: Map<string, AlertKind | null> } {
  const next = new Map<string, AlertKind | null>();
  const moments: AlertMoment[] = [];
  for (const s of sessions) {
    const kind = alertKind(s);
    next.set(s.sessionId, kind);
    if (kind !== null && seen.has(s.sessionId) && seen.get(s.sessionId) !== kind && notifies(s)) {
      moments.push({ sessionId: s.sessionId, kind });
    }
  }
  return { moments, seen: next };
}

export interface AlertNotifyContext {
  /** The app's window has focus. */
  focused: boolean;
  /** The session open in the detail panel, if any. */
  openSessionId: string | null;
  /** What the session's alert level notifies now (it may have changed during the settle). */
  notify: AlertNotify;
}

export function shouldShowAlert(session: AlertSession | undefined, kind: AlertKind, ctx: AlertNotifyContext): boolean {
  if (!session || ctx.notify !== 'all') return false;
  if (alertKind(session) !== kind) return false; // answered, or moved on
  return !(ctx.focused && ctx.openSessionId === session.sessionId);
}

export function alertNotice(session: AlertSession, kind: AlertKind): { sessionId: string; title: string; body: string } {
  // eslint-disable-next-line no-control-regex -- flattening control characters is the point
  const flat = sessionDisplayTitle(session).replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const title = flat.length > ALERT_NOTICE_TITLE_MAX ? `${flat.slice(0, ALERT_NOTICE_TITLE_MAX - 1)}…` : flat;
  const body = kind === 'done' && session.pendingProceedAt ? ALERT_PROCEED_BODY : ALERT_NOTICE_BODY[kind];
  return { sessionId: session.sessionId, title: title || 'Session', body };
}

/** The card ring: a session whose level glows, not the open one, that finished unseen or needs you now. */
export function isAlerting(
  session: Pick<AlertSession, 'status'>,
  { isCurrent, finishedUnseen, glow }: { isCurrent: boolean; finishedUnseen: boolean; glow: boolean },
): boolean {
  if (!glow || isCurrent) return false;
  return finishedUnseen || session.status === 'approval' || session.status === 'input';
}
