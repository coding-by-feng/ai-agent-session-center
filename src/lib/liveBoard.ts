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
 *
 * What a card says besides status, title and project: the room the session is
 * in (`roomBySession` / `cardRoom`), a note (`boardNote`: the user's remark, else
 * the last prompt a person typed) and how long a quiet session has been quiet
 * (`quietFor`). That age comes from the newest work hook event (`lastWorkEventAt`):
 * never `lastActivityAt` (the server stamps it on every hook, and a workspace
 * restore stamps it on every session), and never a prompt (a restore reloads
 * prompts with their old timestamps while the events start over, so a restored
 * card shows no age until it does something).
 *
 * The board can also be sorted by room or by project (`boardGroups`): the same
 * cards in the same order, cut into one headed group per room or per project
 * folder, the way the strip's Rooms and Projects views frame them.
 */
import { groupSessionsByProject } from '@/lib/projectGroups';
import { lastWorkEventAt } from '@/lib/recentSessions';
import { roomColor } from '@/lib/roomColor';
import { roomsInListOrder } from '@/lib/roomOrder';
import { isListedSession, numberedSessions } from '@/lib/sessionSort';
import { PROCEED, displayStatus } from '@/lib/sessionStatusStyle';
import type { Room } from '@/stores/roomStore';
import type { LiveBoardSort } from '@/stores/uiStore';
import type { Session } from '@/types';

export type BoardFilter = 'all' | 'working' | 'needs-you';

export const BOARD_FILTERS: ReadonlyArray<{ id: BoardFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'working', label: 'Working' },
  { id: 'needs-you', label: 'Needs you' },
];

/** Busy: a tool is running, or a prompt was just submitted. */
const WORKING = new Set(['working', 'prompting']);
/**
 * Blocked on the user: a tool approval, a question to answer, or (Oct 23 2026) an answer that asks
 * you to reply "proceed" (`displayStatus` → `PROCEED`), so the reminder is counted and filtered
 * where people look for what waits on them.
 */
const NEEDS_YOU = new Set(['approval', 'input', PROCEED]);

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
    const shown = displayStatus(s);
    if (WORKING.has(shown)) counts.working += 1;
    if (NEEDS_YOU.has(shown)) counts['needs-you'] += 1;
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

/** What the rail calls a session that is in no room. */
export const COMMON_AREA = 'Common Area';

/** How often the board re-reads the clock, so "14m" keeps counting while nothing else changes. */
export const BOARD_TICK_MS = 60_000;

/** The most characters of a note a card puts in the DOM; CSS clips it to one line from there. */
export const BOARD_NOTE_MAX_CHARS = 160;

/**
 * The room each session is in. The first room to list a session wins, as in
 * `getRoomForSession`. Rooms are read back from localStorage, so one without a
 * usable `sessionIds` is skipped rather than thrown on mid-render.
 */
export function roomBySession(rooms: readonly Room[]): Map<string, Room> {
  const bySession = new Map<string, Room>();
  for (const room of rooms) {
    if (!Array.isArray(room.sessionIds)) continue;
    for (const id of room.sessionIds) if (!bySession.has(id)) bySession.set(id, room);
  }
  return bySession;
}

export interface CardRoom {
  name: string;
  /** The room's slot colour; null for "Common Area", which has none. */
  color: string | null;
}

/**
 * The room chip on a card. A session in no room is "Common Area", the rail's
 * name for it, but only once some room exists: rooms live in this browser's
 * storage, so a first run (or a device that has none) would otherwise label
 * every card with a place that means nothing to it.
 */
export function cardRoom(room: Room | undefined, anyRooms: boolean): CardRoom | null {
  if (room) {
    const name = typeof room.name === 'string' ? room.name.trim() : '';
    return { name: name || 'Unnamed room', color: roomColor(room) };
  }
  return anyRooms ? { name: COMMON_AREA, color: null } : null;
}

export interface BoardNote {
  kind: 'remark' | 'prompt';
  text: string;
}

/** One line of text: runs of whitespace (line breaks included) become one space, cut at the cap. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > BOARD_NOTE_MAX_CHARS ? `${flat.slice(0, BOARD_NOTE_MAX_CHARS).trimEnd()}…` : flat;
}

/**
 * Was this prompt typed by a person? About one row in ten came through the same
 * hook but is a harness tag (`<task-notification>…`, `<command-name>…`), which
 * says nothing about what the session is for.
 */
function isTyped(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed !== '' && !trimmed.startsWith('<');
}

/**
 * The line under a card's title: the remark the user wrote for the session, else
 * the last prompt a person typed. Null when there is neither.
 */
export function boardNote(session: Session): BoardNote | null {
  const remark = typeof session.remark === 'string' ? session.remark.trim() : '';
  if (remark) return { kind: 'remark', text: oneLine(remark) };
  const history = session.promptHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const text = history[i]?.text;
    if (isTyped(text)) return { kind: 'prompt', text: oneLine(text) };
  }
  const current = session.currentPrompt;
  return isTyped(current) ? { kind: 'prompt', text: oneLine(current) } : null;
}

/** Statuses where "how long has it been quiet" means something: not busy, not connecting, not gone. */
const QUIET_STATUSES = new Set(['idle', 'waiting', 'approval', 'input']);

/**
 * How long a quiet session has been quiet, as `<1m`, `14m`, `3h` or `2d`; null
 * for a busy one, or one with no work event to measure from (a restored session
 * has none until it does something: its prompts are older than the restart).
 */
export function quietFor(session: Session, now: number): string | null {
  if (!QUIET_STATUSES.has(session.status)) return null;
  const at = lastWorkEventAt(session);
  if (!at) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const BOARD_SORTS: ReadonlyArray<{ value: LiveBoardSort; label: string }> = [
  { value: 'status', label: 'Status' },
  { value: 'room', label: 'Room' },
  { value: 'project', label: 'Project' },
];

/** The heading over sessions whose folder is unknown, in the Project sort. */
export const NO_PROJECT = 'No project';

export interface BoardGroup {
  /** Unique among the groups: React's key. */
  key: string;
  /** 'all' is the Status sort's one group; 'room' and 'common' draw the room chips' dot. */
  kind: 'all' | 'room' | 'common' | 'project' | 'no-project';
  /** The heading; null for a group that has none (Status, or Room with no rooms at all). */
  label: string | null;
  /** A room's colour, as on its chips; null for every other kind. */
  color: string | null;
  /** In the order they were given: the board's order holds inside a group. */
  sessions: Session[];
}

/**
 * The cards on show, cut into groups for the board's sort. Status is today's
 * board: one group, no heading. Room gives each room with a session on show a
 * group, in the strip's list order (`roomsInListOrder`, so status changes never
 * move a group), then Common Area; a session in two rooms sits in the first, as
 * its chip says (`roomOf` is `roomBySession`). With no rooms at all there is
 * nothing to group by, and the chips aren't drawn either, so it stays one
 * group. Project is the strip's grouping by folder (`groupSessionsByProject`:
 * A to Z by the folder's name, clashing names told apart), then the sessions
 * with no folder. No group is ever empty.
 */
export function boardGroups(
  shown: readonly Session[],
  sort: LiveBoardSort,
  rooms: readonly Room[],
  roomOf: ReadonlyMap<string, Room>,
): BoardGroup[] {
  if (shown.length === 0) return [];

  if (sort === 'project') {
    const { groups, ungrouped } = groupSessionsByProject(shown);
    const byFolder = groups.map((g): BoardGroup => ({
      key: `project:${g.key}`,
      kind: 'project',
      label: g.label,
      color: null,
      sessions: g.sessions,
    }));
    return ungrouped.length > 0
      ? [...byFolder, { key: 'no-project', kind: 'no-project', label: NO_PROJECT, color: null, sessions: ungrouped }]
      : byFolder;
  }

  if (sort === 'room' && rooms.length > 0) {
    const byRoom = roomsInListOrder(rooms).flatMap((room): BoardGroup[] => {
      const sessions = shown.filter((s) => roomOf.get(s.sessionId)?.id === room.id);
      if (sessions.length === 0) return [];
      const chip = cardRoom(room, true);
      return [{ key: `room:${room.id}`, kind: 'room', label: chip?.name ?? room.name, color: roomColor(room), sessions }];
    });
    const common = shown.filter((s) => !roomOf.has(s.sessionId));
    return common.length > 0
      ? [...byRoom, { key: 'common', kind: 'common', label: COMMON_AREA, color: null, sessions: common }]
      : byRoom;
  }

  return [{ key: 'all', kind: 'all', label: null, color: null, sessions: [...shown] }];
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
