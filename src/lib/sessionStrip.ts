/**
 * @module sessionStrip
 * What the session strip lists and in what order: the frames (PINNED, RECENT,
 * rooms, projects) and the loose cards between them, for each of the three views
 * (Rooms / Projects / Recent activity). Pure; the store-reading half is
 * hooks/useSessionStrip.ts.
 *
 * One function for the desktop strip (SessionSwitcher) and the phone's session
 * drawer (AASC-18), so a session sits in the same frame, in the same place, on
 * both, and the phone's swipe walks the list the drawer shows.
 */
import { groupSessionsByProject, type ProjectGroup } from '@/lib/projectGroups';
import { ROOM_COLOR_PALETTE, roomColor } from '@/lib/roomColor';
import { roomsInListOrder } from '@/lib/roomOrder';
import type { Room } from '@/stores/roomStore';
import type { SessionSortMode } from '@/stores/uiStore';
import type { Session } from '@/types';

export type StripItem =
  | { type: 'session'; session: Session }
  | { type: 'room'; room: Room; sessions: Session[]; color: string }
  // The built-in RECENT frame. Not a Room: nothing stores it, and it is not
  // part of room reordering (only type 'room' is).
  | { type: 'recent'; sessions: Session[] }
  // The built-in PINNED frame: every pinned session, worked out from the pin
  // flag. Not a Room either, for the same reasons as RECENT.
  | { type: 'pinned'; sessions: Session[] }
  // The built-in CENTRAL frame: every central session (server/mcp), worked out
  // from the card's `central` marker. Not a Room either, for RECENT's reasons.
  | { type: 'central'; sessions: Session[] }
  // One project's frame (Projects view). Worked out from the sessions' paths,
  // so, like RECENT, it is not a Room and takes no part in room reordering.
  | { type: 'project'; group: ProjectGroup; color: string };

/**
 * The room filter: only sessions in one of the selected rooms. An empty
 * selection shows everything.
 */
export function filterByRooms(
  sorted: Session[],
  selectedRoomIds: ReadonlySet<string>,
  rooms: readonly Room[],
): Session[] {
  if (selectedRoomIds.size === 0) return sorted;
  const allowedIds = new Set<string>();
  for (const roomId of selectedRoomIds) {
    const room = rooms.find((r) => r.id === roomId);
    if (room) room.sessionIds.forEach((id) => allowedIds.add(id));
  }
  return sorted.filter((s) => allowedIds.has(s.sessionId));
}

export interface StripItemsInput {
  /** What the room filter lets through, in strip order. */
  filtered: Session[];
  /** Every listed session in strip order: project colours are handed out among all of them. */
  all: Session[];
  rooms: readonly Room[];
  mode: SessionSortMode;
  /** The RECENT frame's ids in order (Rooms view only; empty for none). */
  recentIds: readonly string[];
  /** Draw the PINNED frame (Rooms view only). The desktop strip's toggle; the
   *  phone's list leaves it out. */
  showPinned?: boolean;
  /** Draw the CENTRAL frame (Rooms view only). The desktop strip draws it; the
   *  phone's list leaves it out. */
  showCentral?: boolean;
}

/**
 * Group same-room sessions into a room-coloured frame. Room frames appear in
 * their list order (`listOrder`, falling back to `roomIndex`) so they don't
 * shuffle when statuses change; room-less sessions follow the frames.
 *
 * Recent activity skips grouping entirely: room frames would fight the
 * ordering, since a room can only sit in one place while its sessions belong
 * all over a recency-ranked list.
 *
 * The Projects view swaps the room frames for one frame per project directory.
 * Rooms play no part in it (no room frames, no PINNED or RECENT), though the room filter
 * still narrows `filtered` first. A session with no project path follows the
 * frames as a plain card, like a room-less one does.
 */
export function buildStripItems({
  filtered, all, rooms, mode, recentIds, showPinned = false, showCentral = false,
}: StripItemsInput): StripItem[] {
  if (mode === 'activity') {
    return filtered.map((session) => ({ type: 'session', session }));
  }

  if (mode === 'project') {
    // Colours are resolved among ALL the strip's projects, not only the ones the
    // room filter lets through: otherwise filtering recolours projects that did not change.
    const { groups, ungrouped } = groupSessionsByProject(filtered, ROOM_COLOR_PALETTE.length, all);
    return [
      ...groups.map((group): StripItem => ({ type: 'project', group, color: ROOM_COLOR_PALETTE[group.colorIndex] })),
      ...ungrouped.map((session): StripItem => ({ type: 'session', session })),
    ];
  }

  const sessionToRoom = new Map<string, Room>();
  for (const room of rooms) {
    for (const sid of room.sessionIds) sessionToRoom.set(sid, room);
  }

  const items: StripItem[] = [];

  // CENTRAL goes first: the sessions that steer the others. Like PINNED and
  // RECENT, its sessions stay in their own rooms below and the room filter narrows it.
  if (showCentral) {
    const centrals = filtered.filter((s) => s.central);
    if (centrals.length > 0) items.push({ type: 'central', sessions: centrals });
  }

  // PINNED goes next, in strip order (the cards' numbers). Like RECENT, its
  // sessions stay in their own rooms below and the room filter narrows it.
  if (showPinned) {
    const pinned = filtered.filter((s) => s.pinned);
    if (pinned.length > 0) items.push({ type: 'pinned', sessions: pinned });
  }

  // RECENT goes next. Its sessions also stay in their own rooms below, and it
  // takes them from `filtered`, so the room filter narrows it too.
  if (recentIds.length > 0) {
    const shown = new Map(filtered.map((s) => [s.sessionId, s]));
    const recent = recentIds.flatMap((id) => {
      const s = shown.get(id);
      return s ? [s] : [];
    });
    if (recent.length > 0) items.push({ type: 'recent', sessions: recent });
  }

  // listOrder is the LIST's own order, independent of roomIndex (the 3D scene's
  // world-space room slot; see Room.roomIndex). Falling back to roomIndex, then
  // array order, keeps existing rooms in their visible order until the user
  // first reorders one.
  const orderedRooms = roomsInListOrder(rooms);

  for (const room of orderedRooms) {
    const roomSessions = filtered.filter((s) => room.sessionIds.includes(s.sessionId));
    if (roomSessions.length === 0) continue;
    items.push({ type: 'room', room, sessions: roomSessions, color: roomColor(room) });
  }

  for (const session of filtered) {
    if (sessionToRoom.has(session.sessionId)) continue;
    items.push({ type: 'session', session });
  }

  return items;
}

/**
 * The sessions in the order the list shows them, each once: the order the
 * phone's swipe walks. CENTRAL, PINNED and RECENT are skipped (their sessions are listed
 * again in their own rooms, which is where they stay put); a folded frame still counts, since
 * folding hides cards, not sessions.
 */
export function stripSessionOrder(items: readonly StripItem[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const add = (s: Session) => {
    if (seen.has(s.sessionId)) return;
    seen.add(s.sessionId);
    order.push(s.sessionId);
  };
  for (const item of items) {
    if (item.type === 'recent' || item.type === 'pinned' || item.type === 'central') continue;
    if (item.type === 'session') add(item.session);
    else if (item.type === 'room') item.sessions.forEach(add);
    else item.group.sessions.forEach(add);
  }
  return order;
}

/**
 * The session one step from `currentId` in `order` (+1 next, -1 previous), or
 * null at either end: the list does not wrap, so a swipe past the last session
 * stops rather than jumping back to the first. A current session that is not in
 * the list (filtered out) steps onto the list's first or last.
 */
export function neighbourSession(order: readonly string[], currentId: string, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = order.indexOf(currentId);
  if (at === -1) return step === 1 ? order[0] : order[order.length - 1];
  return order[at + step] ?? null;
}
