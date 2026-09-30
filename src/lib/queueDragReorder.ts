/**
 * queueDragReorder — where a dragged queue item should land.
 *
 * Pure and DOM-free (it takes plain rectangles, not elements) so the two
 * genuinely error-prone parts — the drop-target rule and the off-by-one when
 * an item moves FORWARD past its own old slot — are unit-testable without a
 * browser.
 *
 * ## Why one rule covers both layouts
 *
 * The queue renders as a vertical List or a wrapping Card grid. The doc for
 * Card mode used to state that a 2D grid "has no unambiguous drop target",
 * and cards therefore shipped with no drag at all. That is really an unmade
 * decision rather than an impossibility: every grid sorter picks a rule. The
 * one here is nearest-item + a midpoint test, with the AXIS chosen from the
 * layout itself:
 *
 *   - an item that shares a row with another  → compare X (grid flows across)
 *   - an item alone on its row                → compare Y (list flows down)
 *
 * So the same function serves both, and List and Card can never drift into
 * disagreeing about what a drop means.
 */

/** One item's on-screen box, in viewport coordinates. */
export interface DragRect {
  id: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** True when another rect overlaps this one vertically — i.e. they're side by
 *  side, so the meaningful axis is horizontal. */
function sharesRow(rects: DragRect[], index: number): boolean {
  const r = rects[index];
  return rects.some((o, j) => j !== index && o.top < r.bottom && o.bottom > r.top);
}

/**
 * The slot index (0..rects.length) the pointer is currently indicating.
 *
 * Returns an index into the CURRENT array — a caret position, where
 * `rects.length` means "after the last item". `applyReorder` converts that
 * into a final ordering.
 */
export function computeInsertIndex(rects: DragRect[], x: number, y: number): number {
  if (rects.length === 0) return 0;

  // Nearest by centre distance rather than strict hit-testing: the pointer is
  // frequently in a gap between cards, or past the last row, and a hit test
  // would return "nothing" exactly when the user is aiming at the end.
  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < best) { best = d; nearest = i; }
  }

  const r = rects[nearest];
  const after = sharesRow(rects, nearest)
    ? x > (r.left + r.right) / 2
    : y > (r.top + r.bottom) / 2;
  return after ? nearest + 1 : nearest;
}

/**
 * Apply a drop: move `draggedId` to `insertIndex`, returning the new id order.
 *
 * The subtlety this exists to contain: `insertIndex` is measured against the
 * array *including* the dragged item, but the item is removed before being
 * re-inserted. Dragging FORWARD therefore shifts every later slot down by one,
 * and inserting at the raw index lands one position too far right. Dragging
 * backward needs no adjustment. Getting this wrong is invisible for a
 * two-item queue and wrong for every longer one.
 *
 * Returns the original array (same contents) when the drop is a no-op, so the
 * caller can skip a pointless store write and re-render.
 */
export function applyReorder(ids: number[], draggedId: number, insertIndex: number): number[] {
  const from = ids.indexOf(draggedId);
  if (from === -1) return ids;

  // Dropping into either slot adjacent to where it already sits changes
  // nothing — treat both as a no-op rather than churning the queue.
  if (insertIndex === from || insertIndex === from + 1) return ids;

  const next = ids.slice();
  next.splice(from, 1);
  const adjusted = insertIndex > from ? insertIndex - 1 : insertIndex;
  next.splice(adjusted, 0, draggedId);
  return next;
}
