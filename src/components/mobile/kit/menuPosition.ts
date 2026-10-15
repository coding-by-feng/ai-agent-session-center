/**
 * menuPosition — when a long press opens a menu, and where it sits (AASC-38). Pure.
 */
export const LONG_PRESS_MS = 500;
export const VIEWPORT_PAD = 8;

/** Where a w×h menu opened at (x, y) sits inside a vw×vh viewport. */
export function clampMenuPosition(
  x: number, y: number, w: number, h: number, vw: number, vh: number, pad = VIEWPORT_PAD,
): { left: number; top: number } {
  const left = Math.max(pad, Math.min(x, vw - w - pad));
  const below = y + h + pad <= vh;
  const top = below ? y : y - h;
  return { left, top: Math.max(pad, Math.min(top, vh - h - pad)) };
}
