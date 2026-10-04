/**
 * @module liveBoard
 * What the LIVE page shows on a desktop with the 3D scene off (the default):
 * nothing until the session list has loaded, a "how to start" card when there
 * are no sessions, otherwise a board of session cards. Pure; the components
 * that draw it live in components/live/.
 *
 * The board lists what the LIVE tab can open (`isListedSession`) in the order
 * the panel's rail numbers its cards (`numberedSessions`: pinned, then status,
 * then title), so a card's place matches the rail's `#n`; while the user is on
 * the cards that order is held (`holdOrder`) so nothing moves under a click.
 */
import { isListedSession, numberedSessions } from '@/lib/sessionSort';
import type { Session } from '@/types';

export type BoardFilter = 'all' | 'working' | 'needs-you';

export const BOARD_FILTERS: ReadonlyArray<{ id: BoardFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working' },
  { id: 'needs-you', label: 'Needs you' },
];

/** Busy: a tool is running, or a prompt was just submitted. */
const WORKING = new Set(['working', 'prompting']);
/** Blocked on the user: a tool approval, or a question to answer. */
const NEEDS_YOU = new Set(['approval', 'input']);

export function matchesBoardFilter(status: string, filter: BoardFilter): boolean {
  if (filter === 'working') return WORKING.has(status);
  if (filter === 'needs-you') return NEEDS_YOU.has(status);
  return true;
}

export function needsYou(status: string): boolean {
  return NEEDS_YOU.has(status);
}

/** The sessions on the board, in the rail's order. */
export function boardSessions(sessions: Iterable<Session>): Session[] {
  return numberedSessions([...sessions].filter(isListedSession));
}

export function boardCounts(list: readonly Session[]): Record<BoardFilter, number> {
  const counts: Record<BoardFilter, number> = { all: 0, working: 0, 'needs-you': 0 };
  for (const s of list) {
    counts.all += 1;
    if (WORKING.has(s.status)) counts.working += 1;
    if (NEEDS_YOU.has(s.status)) counts['needs-you'] += 1;
  }
  return counts;
}

/**
 * The board's order while the user is on it. `numberedSessions` puts status
 * first, so a session that finishes or starts working jumps places — fine at a
 * glance, wrong under a pointer about to click (the click lands on the card that
 * slid into its place). While the pointer or keyboard focus is on the cards the
 * board keeps the order it had (`heldIds`): sessions still listed keep their
 * places with fresh data, gone ones drop out, new ones join at the end. Null
 * means "not held": the live order.
 */
export function holdOrder(list: Session[], heldIds: readonly string[] | null): Session[] {
  if (!heldIds) return list;
  const byId = new Map(list.map((s) => [s.sessionId, s]));
  const held = heldIds.flatMap((id) => {
    const s = byId.get(id);
    return s ? [s] : [];
  });
  const kept = new Set(heldIds);
  return [...held, ...list.filter((s) => !kept.has(s.sessionId))];
}

export type FlatState = 'loading' | 'empty' | 'board';

/**
 * Before the first snapshot an empty session map means "not loaded yet", and
 * during a workspace restore it means "being re-created"; saying "No agent
 * sessions yet" in either case would flash at a user whose sessions are
 * moments away. A listed session always shows the board.
 */
export function liveFlatState(input: {
  snapshotReceived: boolean;
  restoring: boolean;
  listedCount: number;
}): FlatState {
  if (!input.snapshotReceived) return 'loading';
  if (input.listedCount > 0) return 'board';
  return input.restoring ? 'loading' : 'empty';
}
