/**
 * useHorizontalSwipe — a quick sideways swipe over an area (the phone's session
 * header, AASC-18: left = next session, right = previous).
 *
 * Touch events: a swipe the browser takes for a scroll cancels the pointer
 * stream. It is a swipe only when it is mostly sideways, long enough and quick;
 * anything else (a tap, a vertical scroll, a slow drag) is left alone. A touch
 * that starts in a text field, in something that scrolls sideways itself (a
 * chip row), or in an element marked `data-no-swipe` is never a swipe, so it
 * cannot steal that control's own gesture.
 *
 * A swipe must not be the only way to do anything: callers keep buttons for it.
 */
import { useCallback, useRef, type TouchEvent } from 'react';

/** The finger must travel at least this far sideways. */
export const SWIPE_MIN_X = 64;
/** ...and at least this many times further sideways than up or down. */
const SWIPE_RATIO = 1.5;
/** ...within this long: a slow drag is someone reading, or selecting. */
const SWIPE_MAX_MS = 800;

export type SwipeDirection = 'left' | 'right';

/**
 * Is `target` somewhere a swipe must not start? Outside `boundary` counts: a
 * React touch event bubbles out of a portal (a sheet opened from the area) into
 * the area's handlers, and a swipe in that sheet is not a swipe on the area.
 */
export function ignoresSwipe(target: EventTarget | null, boundary: Element | null): boolean {
  let el = target instanceof Element ? target : null;
  if (!el || !boundary || !boundary.contains(el)) return true;
  while (el && el !== boundary) {
    if (el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-no-swipe]')) return true;
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    el = el.parentElement;
  }
  return false;
}

export function useHorizontalSwipe<T extends Element>(onSwipe: (direction: SwipeDirection) => void) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);

  const onTouchStart = useCallback((e: TouchEvent<T>) => {
    if (e.touches.length !== 1 || ignoresSwipe(e.target, e.currentTarget)) {
      start.current = null;
      return;
    }
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, []);

  const onTouchEnd = useCallback((e: TouchEvent<T>) => {
    const from = start.current;
    start.current = null;
    const t = e.changedTouches[0];
    if (!from || !t) return;
    const dx = t.clientX - from.x;
    const dy = t.clientY - from.y;
    if (Date.now() - from.t > SWIPE_MAX_MS) return;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return;
    onSwipe(dx < 0 ? 'left' : 'right');
  }, [onSwipe]);

  const onTouchCancel = useCallback(() => {
    start.current = null;
  }, []);

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
