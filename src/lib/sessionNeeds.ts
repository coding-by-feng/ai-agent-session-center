/**
 * sessionNeeds — how many of this computer's sessions there are, and how many wait on the person. Two numbers, so a
 * store selector made of either re-renders only when that number changes, not on every session update.
 */
import { isListedSession } from '@/lib/sessionSort';
import type { Session } from '@/types';

/**
 * Waiting for an approval or for an answer. The same two statuses Electron's main process counts for another
 * computer's row (`NEEDS_YOU_STATUSES`, electron/remote/remoteClient.ts), so "needs you" means one thing on every row.
 */
const NEEDS_YOU: ReadonlySet<string> = new Set(['approval', 'input']);

/** The sessions the dashboard lists: not ended, and not an AI popup's own. */
export function countListedSessions(sessions: ReadonlyMap<string, Session>): number {
  let count = 0;
  for (const session of sessions.values()) if (isListedSession(session)) count += 1;
  return count;
}

/** Of those, the sessions that wait on the person. */
export function countSessionsNeedingYou(sessions: ReadonlyMap<string, Session>): number {
  let count = 0;
  for (const session of sessions.values()) if (isListedSession(session) && NEEDS_YOU.has(session.status)) count += 1;
  return count;
}
