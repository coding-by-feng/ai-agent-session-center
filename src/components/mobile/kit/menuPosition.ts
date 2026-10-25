/**
 * menuPosition — when a long press opens a menu, and where it sits (AASC-38). Pure.
 */
export const LONG_PRESS_MS = 500;
export const VIEWPORT_PAD = 8;
/** Clear space between a finger and a menu a hold opened, so lifting it can't pick an item. */
export const FINGER_GAP = 24;

/**
 * Where a w×h menu opened at (x, y) sits inside a vw×vh viewport: below the point
 * (`gap` px clear of it), or above it when that would run off the bottom. No safe area and
 * no scrolling: `ContextMenu` uses `placeMenuAtPoint`.
 */
export function clampMenuPosition(
  x: number, y: number, w: number, h: number, vw: number, vh: number, pad = VIEWPORT_PAD, gap = 0,
): { left: number; top: number } {
  const left = Math.max(pad, Math.min(x, vw - w - pad));
  const below = y + gap + h + pad <= vh;
  const top = below ? y + gap : y - gap - h;
  return { left, top: Math.max(pad, Math.min(top, vh - h - pad)) };
}

/** The screen's safe-area insets, px (status bar, home indicator, side notches). */
export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: SafeInsets = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

/** Room worth opening a scrolling menu into: three touch-sized rows and the menu's padding. */
export const MENU_MIN_ROOM = 3 * 44 + 8;

/**
 * Where a w×h menu opened at a point (x, y) sits (Oct 24 2026; the desktop's trigger-anchored
 * `placeMenu` is `src/lib/menuPlacement.ts`): inside the safe area (`insets` + `pad`),
 * `gap` px clear of the point — below it when it fits, above it when that fits instead, else on
 * the roomier side with `maxHeight` that room (the list scrolls), so the row that was pressed
 * stays in sight. Only when neither side has MENU_MIN_ROOM does it cover the point, kept inside
 * the safe area. The old clamp slid a tall menu flipped above a low row up to 8px from the top
 * of the screen: under the iPhone's status bar.
 */
export function placeMenuAtPoint(
  x: number, y: number, w: number, h: number, vw: number, vh: number,
  insets: SafeInsets = NO_INSETS, pad = VIEWPORT_PAD, gap = 0,
): { left: number; top: number; maxHeight: number } {
  const left = Math.max(insets.left + pad, Math.min(x, vw - insets.right - pad - w));
  const topEdge = insets.top + pad;
  const bottomEdge = vh - insets.bottom - pad;
  const full = Math.max(0, bottomEdge - topEdge);
  const below = bottomEdge - (y + gap);
  const above = y - gap - topEdge;
  if (h <= below) return { left, top: y + gap, maxHeight: full };
  if (h <= above) return { left, top: y - gap - h, maxHeight: full };
  if (Math.max(below, above) >= MENU_MIN_ROOM) {
    return below >= above ? { left, top: y + gap, maxHeight: below } : { left, top: topEdge, maxHeight: above };
  }
  const height = Math.min(h, full);
  return { left, top: Math.max(topEdge, Math.min(y - gap - height, bottomEdge - height)), maxHeight: full };
}
