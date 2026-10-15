/**
 * inboxModel.ts — which sessions wait for the user (AASC-39).
 *
 * "Needs you" = an approval, a question, or a turn an interruption stopped
 * (`session.interruption`, the auto-resume data). A finished turn doesn't count:
 * it is worth a look, not a wait. Drives the Inbox tab's badge, the Inbox list and
 * the session screen's "N more need you ›" jump. Pure; built only from what the
 * phone already receives, so a session hidden from this device is simply absent.
 */
import type { Session } from '@/types';

type WaitingFields = Pick<Session, 'sessionId' | 'status' | 'lastActivityAt' | 'interruption'>;
type AskFields = Pick<Session, 'status' | 'pendingTool' | 'pendingToolDetail' | 'waitingDetail' | 'interruption'>;

export function needsYou(session: WaitingFields): boolean {
  if (session.status === 'ended') return false;
  return session.status === 'approval' || session.status === 'input' || !!session.interruption;
}

/** The waiting sessions, the one waiting longest first (the triage order). */
export function waitingSessions<S extends WaitingFields>(sessions: ReadonlyMap<string, S>): S[] {
  return [...sessions.values()]
    .filter(needsYou)
    .sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
}

export function inboxCount(sessions: ReadonlyMap<string, WaitingFields>): number {
  let count = 0;
  for (const s of sessions.values()) if (needsYou(s)) count += 1;
  return count;
}

/** The waiting session after `currentId` in triage order (wrapping), or null when no other waits. */
export function nextWaitingSession(sessions: ReadonlyMap<string, WaitingFields>, currentId: string): string | null {
  const order = waitingSessions(sessions).map((s) => s.sessionId);
  const others = order.filter((id) => id !== currentId);
  if (others.length === 0) return null;
  const at = order.indexOf(currentId);
  if (at < 0) return order[0];
  return order[(at + 1) % order.length];
}

/** What a waiting session waits for, in words ("Wants to run: npm test"). */
export function waitingLine(session: AskFields): string {
  if (session.status === 'approval') {
    const what = session.pendingToolDetail || session.pendingTool;
    return what ? `Wants to run: ${what}` : 'Wants your approval';
  }
  if (session.status === 'input') return session.waitingDetail ? `Asks: ${session.waitingDetail}` : 'Has a question for you';
  if (session.interruption) return `Stopped: ${session.interruption.line}`;
  return 'Waiting for you';
}
