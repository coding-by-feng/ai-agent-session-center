/**
 * urgentRepeat — a level that repeats (Urgent by default: `repeatMin` 5, lib/attention.ts) reminds you of a moment you
 * have not handled, every `repeatMin` minutes (Nov 25 2026): a finished turn until you open the session, an approval
 * or a question until it is answered or you open it. Pure rules, driven by useUrgentRepeat:
 *
 *   reminderStep           one look: which moments are owed now, and which are due a reminder
 *   remindsByNotification  whether a reminder also notifies, by the level's notification setting
 *   reminderNotice         the notification: the session's name and "Reminder · <moment>", never the answer
 *
 * A moment is owed only when it arrives, under a level that repeats, while the app watches: a first sighting never
 * counts (like the notifications), so a launch, reconnect or workspace restore brings nothing back. It stops being
 * owed when it no longer stands (done: the session left waiting/idle; approval and input: the status moved on), when
 * its level stops repeating or the session is gone, or when you look at it (the open session in a focused window).
 */
import type { AlertNotify } from './attention';
import { alertKind, alertNotice, type AlertKind, type AlertMoment, type AlertSession } from './alertNotify';

/** How often useUrgentRepeat looks, besides every session update. Repeats are whole minutes, so this is plenty. */
export const REMINDER_TICK_MS = 15_000;

export interface Owed {
  kind: AlertKind;
  /** When it arrived or was last reminded. */
  lastAt: number;
}

export interface ReminderState {
  /** The moment each known session stood on at the last look (null: none), to tell an arrival from a first sighting. */
  seen: ReadonlyMap<string, AlertKind | null>;
  owed: ReadonlyMap<string, Owed>;
}

export interface ReminderLook<S extends AlertSession> {
  sessions: Iterable<S>;
  now: number;
  /** Minutes between reminders at this session's level (0: its level does not repeat). */
  repeatMinOf: (session: S) => number;
  /** The session you are looking at: open in a focused window (null: none). */
  lookingAt: string | null;
}

function stillStands(kind: AlertKind, status: string): boolean {
  if (kind === 'done') return status === 'waiting' || status === 'idle';
  return status === kind;
}

export function reminderStep<S extends AlertSession>(
  state: ReminderState,
  { sessions, now, repeatMinOf, lookingAt }: ReminderLook<S>,
): { state: { seen: Map<string, AlertKind | null>; owed: Map<string, Owed> }; due: AlertMoment[] } {
  const seen = new Map<string, AlertKind | null>();
  const owed = new Map<string, Owed>();
  const due: AlertMoment[] = [];
  for (const s of sessions) {
    const id = s.sessionId;
    const kind = alertKind(s);
    const arrived = kind !== null && state.seen.has(id) && state.seen.get(id) !== kind;
    seen.set(id, kind);
    const repeatMin = repeatMinOf(s);
    if (id === lookingAt || repeatMin <= 0) continue;
    if (arrived) {
      owed.set(id, { kind, lastAt: now });
      continue;
    }
    const prev = state.owed.get(id);
    if (!prev || !stillStands(prev.kind, s.status)) continue;
    if (now - prev.lastAt >= repeatMin * 60_000) {
      due.push({ sessionId: id, kind: prev.kind });
      owed.set(id, { kind: prev.kind, lastAt: now });
    } else {
      owed.set(id, prev);
    }
  }
  return { state: { seen, owed }, due };
}

/**
 * A reminder notifies when the level notifies every moment, or, for a level that notifies proceed asks, when the
 * moment is one (a finished turn waiting for "proceed") and Settings ▸ Sound ▸ Notifications has those on.
 */
export function remindsByNotification(
  session: Pick<AlertSession, 'pendingProceedAt'>,
  kind: AlertKind,
  notify: AlertNotify,
  proceedEnabled: boolean,
): boolean {
  if (notify === 'all') return true;
  return notify === 'proceed' && kind === 'done' && !!session.pendingProceedAt && proceedEnabled;
}

export function reminderNotice(session: AlertSession, kind: AlertKind): { sessionId: string; title: string; body: string } {
  const notice = alertNotice(session, kind);
  return { ...notice, body: `Reminder · ${notice.body}` };
}
