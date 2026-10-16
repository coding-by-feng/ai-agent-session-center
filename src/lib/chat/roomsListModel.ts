/**
 * roomsListModel.ts — the phone's Sessions list grouped by room (AASC-55):
 * which rooms are folded on this phone, where a dragged session lands, and the
 * room op a drag turns into. Pure: no store, no DOM.
 *
 * Folding is this phone's view, never the Mac's: it lives in its own
 * localStorage key, not in `Room.collapsed` (that flag is the desktop strip's).
 */
import type { Room, RoomOp } from '@/types';
import { mergeRoomOrder, roomsInListOrder } from '@/lib/roomOrder';

/** Which rooms this phone shows folded (ids, JSON array). */
export const COLLAPSED_ROOMS_KEY = 'aasc.phoneCollapsedRooms';

/** Never more ids than a room list may hold (ROOM_LIMITS.rooms): a corrupt value can't grow forever. */
const MAX_COLLAPSED = 200;

/** The folded room ids from what localStorage held; anything malformed reads as none folded. */
export function parseCollapsedRooms(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, MAX_COLLAPSED));
  } catch {
    return new Set();
  }
}

/** A new set with `roomId` folded or unfolded. Never changes `collapsed`. */
export function toggleRoomCollapsed(collapsed: ReadonlySet<string>, roomId: string): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(roomId)) next.delete(roomId);
  else next.add(roomId);
  return next;
}

/** Only the ids of rooms that still exist: a deleted room's fold is forgotten. */
export function pruneCollapsedRooms(collapsed: ReadonlySet<string>, rooms: readonly Pick<Room, 'id'>[]): ReadonlySet<string> {
  const ids = new Set(rooms.map((r) => r.id));
  const kept = [...collapsed].filter((id) => ids.has(id));
  return kept.length === collapsed.size ? collapsed : new Set(kept);
}

/** One group's box on screen while a session is dragged: a room, or "No room" (`roomId: null`). */
export interface RoomGroupRect {
  roomId: string | null;
  top: number;
  bottom: number;
}

/** The group a session dropped at `y` lands in, or null when it is over none of them. */
export function roomDropTarget(rects: readonly RoomGroupRect[], y: number): RoomGroupRect | null {
  return rects.find((r) => y >= r.top && y <= r.bottom) ?? null;
}

/** What dropping a session on a group asks for, or null when it is already there (or over nothing). */
export function sessionDropOp(sessionId: string, fromRoomId: string | null, target: RoomGroupRect | null): RoomOp | null {
  if (!target || target.roomId === fromRoomId) return null;
  return { type: 'move', sessionId, roomId: target.roomId };
}

/**
 * The reorder a drag of the visible room groups asks for: every room this phone
 * has, in list order, with the visible ones in their new order (a search or a
 * filter can leave a room without a group; it keeps its slot). Null when
 * nothing moves. A phone's room list is the Mac's cut for it, so this names
 * only rooms it can see; the Mac keeps the others where they are.
 */
export function reorderOpFor(rooms: readonly Room[], visibleNext: readonly string[]): RoomOp | null {
  const ordered = roomsInListOrder(rooms).map((r) => r.id);
  const merged = mergeRoomOrder(ordered, visibleNext);
  return merged === ordered ? null : { type: 'reorder', roomIds: [...merged] };
}
