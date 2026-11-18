/**
 * @module pinMove
 * One step up or down in the PINNED frame, for the phone's row menu and actions sheet (Nov 18 2026):
 * the phone has no drag there. The order is the one PINNED lists (`numberedSessions`: `pinOrder`,
 * ended sessions left out), and the result goes to `setPinnedOrder`. On a phone the list holds only
 * the shared sessions; the server keeps the others in their places (`placeVisiblePins`).
 */
import type { Session } from '@/types';
import { numberedSessions } from './sessionSort';

function pinnedIds(sessions: Iterable<Session>): string[] {
  return numberedSessions(sessions).filter((s) => s.pinned).map((s) => s.sessionId);
}

/** Where the session sits in PINNED (0 = top), or null when it isn't listed there. */
export function pinnedPlace(sessions: Iterable<Session>, sessionId: string): { index: number; count: number } | null {
  const ids = pinnedIds(sessions);
  const index = ids.indexOf(sessionId);
  return index < 0 ? null : { index, count: ids.length };
}

/** PINNED top to bottom after moving the session one place (-1 up, +1 down); null when it can't move. */
export function pinnedMoveOrder(sessions: Iterable<Session>, sessionId: string, step: -1 | 1): string[] | null {
  const ids = pinnedIds(sessions);
  const from = ids.indexOf(sessionId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
