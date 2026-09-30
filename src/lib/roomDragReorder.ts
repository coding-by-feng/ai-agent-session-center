/**
 * roomDragReorder — where a dragged room frame should land, in a purely
 * vertical list.
 *
 * Sibling to `queueDragReorder.ts`, deliberately NOT shared with it: rooms in
 * the left-rail session switcher are always a single stacked column (never a
 * wrapping grid), so there is no axis to pick — every drop compares Y only.
 * Keeping this separate also keeps the queue's tested axis-picking logic
 * untouched by a change that has nothing to do with it.
 *
 * Pure and DOM-free (plain rectangles, not elements), same reasoning as
 * `queueDragReorder.ts`: the drop-target rule and the forward-move off-by-one
 * are unit-testable without a browser.
 */

/** One room frame's on-screen box, in viewport coordinates. Only the
 *  vertical edges matter — there is no horizontal axis to compare. */
export interface RoomDragRect {
  id: string;
  top: number;
  bottom: number;
}

/**
 * The slot index (0..rects.length) the pointer is currently indicating.
 *
 * Nearest-center by Y distance, then a midpoint test to decide before/after —
 * same shape as `queueDragReorder.ts`'s rule, minus the axis choice.
 */
export function computeRoomInsertIndex(rects: RoomDragRect[], y: number): number {
  if (rects.length === 0) return 0;

  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cy = (r.top + r.bottom) / 2;
    const d = Math.abs(y - cy);
    if (d < best) { best = d; nearest = i; }
  }

  const r = rects[nearest];
  const after = y > (r.top + r.bottom) / 2;
  return after ? nearest + 1 : nearest;
}

/**
 * Apply a drop: move `draggedId` to `insertIndex`, returning the new id order.
 *
 * Identical off-by-one handling to `queueDragReorder.ts`'s `applyReorder` —
 * `insertIndex` is measured against the array INCLUDING the dragged item, so
 * a forward move must shift the target left by one after the item is
 * removed. Returns the original array (same reference) for a no-op drop.
 */
export function applyRoomReorder(
  ids: string[],
  draggedId: string,
  insertIndex: number,
): string[] {
  const from = ids.indexOf(draggedId);
  if (from === -1) return ids;

  if (insertIndex === from || insertIndex === from + 1) return ids;

  const next = ids.slice();
  next.splice(from, 1);
  const adjusted = insertIndex > from ? insertIndex - 1 : insertIndex;
  next.splice(adjusted, 0, draggedId);
  return next;
}

/**
 * How far each OTHER room frame slides to preview a drop at `insertIndex`.
 *
 * The rooms between the dragged one's old slot and the indicated one move by
 * the dragged room's pitch (its own height plus the gap after it) — up when it
 * is carried down past them, down when it is carried up past them — which
 * opens a hole exactly where it will land. Every other room, the dragged one
 * included, is absent from the map: the dragged room follows the pointer
 * instead (see `clampRoomDragOffset`).
 *
 * Each passed room ends up exactly where `applyRoomReorder` will put it, so
 * committing the drop moves nothing that the preview had not already moved.
 * The two no-op slots (its own, and just after itself) slide nothing, which is
 * the preview saying "releasing here changes nothing".
 */
export function computeRoomShifts(
  rects: RoomDragRect[],
  draggedId: string,
  insertIndex: number | null,
): Map<string, number> {
  const shifts = new Map<string, number>();
  const from = rects.findIndex((r) => r.id === draggedId);
  if (from === -1 || insertIndex === null) return shifts;
  if (insertIndex === from || insertIndex === from + 1) return shifts;

  if (insertIndex > from + 1) {
    // Carried down: what it passes closes the gap it left, moving up by the
    // distance between its top and the next room's top.
    const pitch = rects[from + 1].top - rects[from].top;
    for (let i = from + 1; i < insertIndex; i++) shifts.set(rects[i].id, -pitch);
  } else {
    // Carried up: what it passes makes room for it, moving down by the
    // distance between its bottom and the previous room's bottom.
    const pitch = rects[from].bottom - rects[from - 1].bottom;
    for (let i = insertIndex; i < from; i++) shifts.set(rects[i].id, pitch);
  }
  return shifts;
}

/**
 * Limit the carried room's pointer offset to the span the room frames occupy:
 * its top may rise to the first room's top and its bottom may sink to the last
 * room's bottom, no further — past those edges it would slide over the
 * switcher controls above or the loose session cards below.
 */
export function clampRoomDragOffset(
  rects: RoomDragRect[],
  draggedId: string,
  dy: number,
): number {
  const dragged = rects.find((r) => r.id === draggedId);
  if (!dragged) return 0;
  const min = rects[0].top - dragged.top;
  const max = rects[rects.length - 1].bottom - dragged.bottom;
  return Math.min(max, Math.max(min, dy));
}

/**
 * The y the drop hit test (`computeRoomInsertIndex`) reads while a room is
 * carried `dy` px from where it was lifted: the carried room's LEADING edge —
 * its bottom when carried down, its top when carried up.
 *
 * Not the pointer: the grip sits near the frame's top, so the pointer tracks
 * the top edge, and carrying an expanded room down past a collapsed one took
 * the whole height of the carried room — the collapsed one hidden beneath it
 * the entire way — before the slot moved. Not the centre either: `dy` is
 * clamped to the rooms' span, which stops a tall room's centre short of a
 * short end room's centre, so the first and last slots would be unreachable.
 * The leading edge reaches every slot within the clamp, and at rest (dy = 0)
 * it always resolves to a no-op slot.
 */
export function roomDragHitY(
  rects: RoomDragRect[],
  draggedId: string,
  dy: number,
): number | null {
  const dragged = rects.find((r) => r.id === draggedId);
  if (!dragged) return null;
  return dy >= 0 ? dragged.bottom + dy : dragged.top + dy;
}
