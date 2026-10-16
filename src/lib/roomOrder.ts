/**
 * @module roomOrder
 * The order rooms are LISTED in (`Room.listOrder`), and how a reorder asked for
 * by a device that sees only some of the rooms lands in the whole list
 * (AASC-55). Pure and import-free apart from the type.
 *
 * Never reads or writes `roomIndex` except as the old fallback rank: that field
 * is the room's 3D world slot (see `Room.roomIndex`), and reordering a list must
 * never move a room in the scene.
 */
import type { Room } from '@/types';

/** A room's rank in the list: `listOrder`, else its 3D slot (until it is first reordered), else last. */
function listRank(room: Pick<Room, 'listOrder' | 'roomIndex'>): number {
  return room.listOrder ?? room.roomIndex ?? Number.MAX_SAFE_INTEGER;
}

/** The rooms in list order (stable: equal ranks keep array order). Never changes `rooms`. */
export function roomsInListOrder<T extends Pick<Room, 'listOrder' | 'roomIndex'>>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => listRank(a) - listRank(b));
}

/**
 * Put `wanted` (some of the ids in `orderedIds`, in their new order) into the
 * slots those same ids hold now; every other id keeps its slot.
 *
 * This is how a device that sees only some rooms reorders them: a phone's list
 * leaves out rooms whose sessions are all hidden from it, so it can only say
 * how ITS rooms go. The rooms it can't see stay exactly where they were. Ids in
 * `wanted` that are not in `orderedIds` are ignored, and so is a repeat.
 * Returns `orderedIds` itself when nothing moves.
 */
export function mergeRoomOrder(orderedIds: readonly string[], wanted: readonly string[]): readonly string[] {
  const known = new Set(orderedIds);
  const seen = new Set<string>();
  const picked = wanted.filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  let next = 0;
  const merged = orderedIds.map((id) => (seen.has(id) ? picked[next++] : id));
  return merged.every((id, i) => id === orderedIds[i]) ? orderedIds : merged;
}

/**
 * The `listOrder` every room gets after a reorder: a dense 0..N-1 over ALL
 * rooms, so no room keeps a rank borrowed from its 3D slot that could tie with
 * a stamped one. Null when nothing moves (a repeated or stale request writes
 * nothing).
 */
export function listOrdersAfterReorder(
  rooms: readonly Pick<Room, 'id' | 'listOrder' | 'roomIndex'>[],
  wanted: readonly string[],
): Map<string, number> | null {
  const ordered = roomsInListOrder(rooms).map((r) => r.id);
  const merged = mergeRoomOrder(ordered, wanted);
  if (merged === ordered) return null;
  return new Map(merged.map((id, i) => [id, i]));
}

/**
 * The visible order after moving one room a step up (-1) or down (+1), or null
 * at either end: the one-handed path (a menu's Move up / Move down) next to the
 * drag.
 */
export function stepRoom(visibleIds: readonly string[], roomId: string, step: -1 | 1): string[] | null {
  const from = visibleIds.indexOf(roomId);
  const to = from + step;
  if (from === -1 || to < 0 || to >= visibleIds.length) return null;
  const next = [...visibleIds];
  next[from] = visibleIds[to];
  next[to] = roomId;
  return next;
}
