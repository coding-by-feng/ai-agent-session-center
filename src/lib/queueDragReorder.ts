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
 * The slot to apply to `currentIds` for a drop shown at `insertIndex` among the
 * lift-time rows (`rects`, in display order): before the same row it was shown
 * before. The queue can change under a drag — the scheduler sends the first prompt —
 * and the old slot number applied to the shorter list lands a place off (Oct 21 2026).
 * A row that left is skipped for the next one still there; -1 when the dragged item
 * itself is gone. With nothing changed this is `insertIndex` itself.
 */
export function rebaseInsertIndex(
  rects: readonly { id: number }[],
  draggedId: number,
  insertIndex: number,
  currentIds: readonly number[],
): number {
  if (!currentIds.includes(draggedId)) return -1;
  for (let i = insertIndex; i < rects.length; i++) {
    const at = currentIds.indexOf(rects[i].id);
    if (at !== -1) return at;
  }
  return currentIds.length;
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

// ---- The Card grid's carry (Oct 22 2026) ----------------------------------
//
// A carried card follows the pointer both ways, so the drop is aimed by the
// card itself, not by the pointer's side of a card (`computeInsertIndex`,
// which a lift without a carry still uses): the carried card takes the place
// of the card whose centre is nearest its own. That changes place at about
// half a card's travel, as the List's leading edge does. The cards between
// its old and new place each step one cell toward its old one, so the last
// card of a row wraps to the start of the next (or the reverse); a card's
// height cannot say where that is, so every shift is cell to cell.

/** How far a passed card is moved, in px. */
export interface GridShift {
  x: number;
  y: number;
}

const centreX = (r: DragRect) => (r.left + r.right) / 2;
const centreY = (r: DragRect) => (r.top + r.bottom) / 2;

/** Each column's left edge: every column starts at the left of some card. */
function columnLefts(rects: DragRect[]): number[] {
  return [...new Set(rects.map((r) => Math.round(r.left)))];
}

/** How many columns the cards are in. One column stacks like List rows, so it is
 *  carried by the List's rules: cells are only exact in rows of equal height, and
 *  each card of a column is a row of its own height. */
export function gridColumnCount(rects: DragRect[]): number {
  return columnLefts(rects).length;
}

/**
 * The slot (0..rects.length) a card carried in the grid lands in: the place of
 * the card whose lift-time centre is nearest the carried card's centre (`cx`,
 * `cy`). Its own nearest is its own slot, a no-op. The empty cells after the
 * last card, in a last row that is not full, are the end of the queue: there
 * is no card there to be nearest to, and the one above would win.
 */
export function computeGridInsertIndex(
  rects: DragRect[],
  draggedId: number,
  cx: number,
  cy: number,
): number {
  if (rects.length === 0) return 0;
  const distance = (x: number, y: number) => (cx - x) ** 2 + (cy - y) ** 2;

  let nearest = 0;
  let best = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const d = distance(centreX(rects[i]), centreY(rects[i]));
    if (d < best) { best = d; nearest = i; }
  }

  // The cells right of the last card are the empty ones.
  const last = rects[rects.length - 1];
  const width = last.right - last.left;
  for (const left of columnLefts(rects)) {
    if (left <= Math.round(last.left)) continue;
    if (distance(left + width / 2, centreY(last)) < best) return rects.length;
  }

  const from = rects.findIndex((r) => r.id === draggedId);
  if (from === -1 || nearest === from) return from === -1 ? nearest : from;
  // Forward, it lands after the card it takes the place of (`applyReorder`
  // removes it first); back, before it.
  return nearest > from ? nearest + 1 : nearest;
}

/**
 * Where each card a carried one has passed is drawn to preview a drop at
 * `insertIndex`: one cell toward the carried card's old place, measured
 * between the lift-time boxes (to the top-left corner of that cell). Carried
 * forward, the passed cards step back a cell; carried back, they step forward.
 * The carried card and the cards it has not passed are absent; so is everything
 * for the two no-op slots. Each passed card lands where `applyReorder` puts it.
 */
export function computeGridShifts(
  rects: DragRect[],
  draggedId: number,
  insertIndex: number | null,
): Map<number, GridShift> {
  const shifts = new Map<number, GridShift>();
  const from = rects.findIndex((r) => r.id === draggedId);
  if (from === -1 || insertIndex === null) return shifts;
  if (insertIndex === from || insertIndex === from + 1) return shifts;

  const step = (i: number, to: number) =>
    shifts.set(rects[i].id, { x: rects[to].left - rects[i].left, y: rects[to].top - rects[i].top });
  if (insertIndex > from + 1) {
    for (let i = from + 1; i < insertIndex; i++) step(i, i - 1);
  } else {
    for (let i = insertIndex; i < from; i++) step(i, i + 1);
  }
  return shifts;
}

/**
 * Limit a carried card's offset to the box all the cards cover, so it never
 * floats over the compose box above the grid or out of the scroller. Only the
 * drawing is clamped: the aim (`computeGridInsertIndex`) reads the unclamped
 * offset, or an expanded card, many times taller than the rest, could never
 * reach the last row.
 */
export function clampGridDragOffset(
  rects: DragRect[],
  draggedId: number,
  dx: number,
  dy: number,
): GridShift {
  const own = rects.find((r) => r.id === draggedId);
  if (!own) return { x: 0, y: 0 };
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return {
    x: Math.min(right - own.right, Math.max(left - own.left, dx)),
    y: Math.min(bottom - own.bottom, Math.max(top - own.top, dy)),
  };
}
