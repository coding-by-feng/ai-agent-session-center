/**
 * menuPosition — when a long press opens a menu, and where it sits (AASC-38). Pure.
 */
export const LONG_PRESS_MS = 500;
export const VIEWPORT_PAD = 8;
/** Clear space between a finger and a menu a hold opened, so lifting it can't pick an item. */
export const FINGER_GAP = 24;

/**
 * Where a w×h menu opened at (x, y) sits inside a vw×vh viewport: below the point
 * (`gap` px clear of it), or above it when that would run off the bottom.
 */
export function clampMenuPosition(
  x: number, y: number, w: number, h: number, vw: number, vh: number, pad = VIEWPORT_PAD, gap = 0,
): { left: number; top: number } {
  const left = Math.max(pad, Math.min(x, vw - w - pad));
  const below = y + gap + h + pad <= vh;
  const top = below ? y + gap : y - gap - h;
  return { left, top: Math.max(pad, Math.min(top, vh - h - pad)) };
}
