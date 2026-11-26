/**
 * roomAlert — the room frame header's Alert (Nov 25 2026): one click sets the per-session Alert (`session.alerted`:
 * loud sound, glowing card, desktop notification) for every live session in a room. It acts on the room's sessions
 * as they are now; it is not a stored room setting, so a session filed into the room later starts unalerted.
 * Pure: the button (RoomAlertToggle.tsx) does the writes.
 */

/** What the room Alert shows: every live session alerted, some of them, or none. */
export type RoomAlertState = 'all' | 'some' | 'none';

interface AlertableSession {
  status: string;
  alerted?: boolean;
}

/** The room's member ids that name a live session (ended cards and dropped ids left out), in the room's order. */
export function liveRoomIds(sessionIds: readonly string[], sessions: ReadonlyMap<string, AlertableSession>): string[] {
  return sessionIds.filter((id) => {
    const s = sessions.get(id);
    return s !== undefined && s.status !== 'ended';
  });
}

/** All, some or none of the live ids alerted; `none` when there are no live ids. */
export function roomAlertState(liveIds: readonly string[], sessions: ReadonlyMap<string, AlertableSession>): RoomAlertState {
  const on = liveIds.filter((id) => sessions.get(id)?.alerted === true).length;
  if (on === 0) return 'none';
  return on === liveIds.length ? 'all' : 'some';
}

/**
 * What a click does: turns Alert off for all when every live session is alerted, on for all otherwise. `changes` are
 * only the ids whose state differs from `next`, so a session already in that state is not written again.
 */
export function roomAlertClick(
  liveIds: readonly string[],
  sessions: ReadonlyMap<string, AlertableSession>,
): { next: boolean; changes: string[] } {
  const next = roomAlertState(liveIds, sessions) !== 'all';
  const changes = liveIds.filter((id) => (sessions.get(id)?.alerted === true) !== next);
  return { next, changes };
}
