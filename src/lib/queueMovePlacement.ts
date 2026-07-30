/**
 * Placement maths for the queue MOVE dropdown (`QueueMovePicker`).
 *
 * Split out of the component so the rules can be unit-tested without a DOM, and
 * so the component file only exports components (react-refresh/only-export-components).
 */

/** Gap between the MOVE trigger and the menu. */
export const ANCHOR_GAP = 2;
/** Minimum gap kept between the menu and a viewport edge. */
export const VIEWPORT_PAD = 8;

export interface Size {
  width: number;
  height: number;
}

/** Only the trigger edges placement actually reads. */
export interface AnchorBox {
  top: number;
  bottom: number;
  right: number;
  /** Required only for `align: 'left'`. Omitted callers get right-alignment,
   *  which is what every edge-anchored row action wants. */
  left?: number;
}

/**
 * Which trigger edge the menu lines up with.
 *
 * `'right'` (the default) is correct for a trigger sitting at its row's right
 * edge — the menu grows leftward, away from the edge. `'left'` is for a trigger
 * on the left of a wide container (the chain sections' "From saved…" button):
 * right-aligning there would push the menu off the left of the screen and leave
 * it pinned to the viewport pad, visually detached from its own button.
 */
export type HorizontalAlign = 'left' | 'right';

/**
 * Place the menu against its trigger, kept inside the viewport.
 *
 * Vertically it prefers opening downward, flips above when the menu would run
 * past the bottom edge and there is genuinely room up there, and otherwise
 * clamps — so a menu taller than the space on either side still renders fully
 * on screen instead of hanging off an edge. Horizontally it aligns to the edge
 * named by `align` (right by default — MOVE sits at the row's right edge, so the
 * list grows leftward) and then clamps the same way.
 *
 * Everything is measured from the trigger's **viewport** rect. The old version
 * lived inside `.queueBody` — a 250px `overflow-y: auto` box — and compared
 * against `window.innerHeight`, a boundary hundreds of px past the real clip
 * edge, so the flip never fired and the menu always rendered cropped.
 */
export function computeMovePickerPosition(
  anchor: AnchorBox,
  menu: Size,
  viewport: Size,
  align: HorizontalAlign = 'right',
): { top: number; left: number } {
  const below = anchor.bottom + ANCHOR_GAP;
  const above = anchor.top - ANCHOR_GAP - menu.height;
  const fitsBelow = below + menu.height <= viewport.height - VIEWPORT_PAD;
  const fitsAbove = above >= VIEWPORT_PAD;

  // `Math.max` last so a menu too tall for the viewport pins to the top edge
  // rather than being pushed off the bottom by the clamp.
  const wanted = fitsBelow || !fitsAbove ? below : above;
  const top = Math.max(
    VIEWPORT_PAD,
    Math.min(wanted, viewport.height - VIEWPORT_PAD - menu.height),
  );

  // `left` on the anchor is optional, so an 'left'-aligned call from a caller
  // that didn't measure it degrades to right-alignment rather than to 0 (which
  // would slam every such menu against the window's left edge).
  const wantedLeft =
    align === 'left' && anchor.left != null ? anchor.left : anchor.right - menu.width;
  const left = Math.max(
    VIEWPORT_PAD,
    Math.min(wantedLeft, viewport.width - VIEWPORT_PAD - menu.width),
  );

  return { top, left };
}
