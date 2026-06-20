import { useLayoutEffect, type RefObject } from 'react';

/** Minimum gap (px) to keep between a dropdown and the viewport edge. */
const VIEWPORT_PAD = 8;

/**
 * Keep an absolutely-positioned dropdown inside the horizontal viewport.
 *
 * Several toolbar dropdowns anchor with `right: 0` and extend leftward. When
 * their trigger button sits near the left edge of the window the menu overflows
 * past the edge and its content gets clipped. This hook measures the rendered
 * menu the moment `open` flips true and writes a `translateX(...)` directly onto
 * the element that nudges it back inside the left/right viewport edges.
 *
 * The correction is applied imperatively (rather than via React state) so it
 * does not trigger an extra render and does not fight the element's `style`
 * prop. Vertical placement is left to CSS; this only corrects horizontal
 * overflow.
 *
 * @param open  Whether the dropdown is currently rendered/visible.
 * @param ref   Ref to the dropdown menu element itself (not its wrapper).
 */
export function useDropdownFlipX(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!open) {
      el.style.transform = '';
      return;
    }

    // Measure the menu's natural position with any prior nudge removed, so the
    // correction is computed from the CSS-anchored layout, not a stale offset.
    el.style.transform = '';
    const rect = el.getBoundingClientRect();

    const viewportWidth = window.innerWidth;
    let dx = 0;
    if (rect.left < VIEWPORT_PAD) {
      // Overflows the left edge → push the menu right.
      dx = VIEWPORT_PAD - rect.left;
    } else if (rect.right > viewportWidth - VIEWPORT_PAD) {
      // Overflows the right edge → pull the menu left.
      dx = viewportWidth - VIEWPORT_PAD - rect.right;
    }
    if (dx !== 0) el.style.transform = `translateX(${dx}px)`;
  }, [open, ref]);
}
