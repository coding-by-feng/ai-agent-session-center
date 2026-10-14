/**
 * useLongPress — a touch long-press on some elements, that never gets in the way
 * of a scroll (AASC-20: bookmarking a terminal line on a phone).
 *
 * A press counts when a finger stays within LONG_PRESS_SLOP_PX of where it went
 * down for LONG_PRESS_MS. Any movement past that, a lift, a cancel (the browser
 * took the gesture over to scroll) or a scroll inside the elements ends it. All
 * listeners are passive and nothing calls preventDefault, so a scroll that starts
 * on the same spot scrolls exactly as before. A mouse never long-presses: on a
 * pointer that can drag-select, holding still is how a selection starts.
 */
import { useEffect, useRef, type RefObject } from 'react';

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPressPoint {
  clientX: number;
  clientY: number;
}

export interface UseLongPressOptions {
  enabled: boolean;
  /** Where presses are watched (the terminal: inline and full screen); read when `enabled` turns on. */
  targets: readonly [RefObject<HTMLElement | null>, RefObject<HTMLElement | null>?];
  /** Only a press that starts on an element inside this selector counts. */
  selector?: string;
  onLongPress: (point: LongPressPoint) => void;
}

export function useLongPress({ enabled, targets, selector, onLongPress }: UseLongPressOptions): void {
  const callbackRef = useRef(onLongPress);
  useEffect(() => {
    callbackRef.current = onLongPress;
  }, [onLongPress]);

  // The refs themselves are stable; unpacked so a caller's tuple literal doesn't re-run this.
  const [first, second] = targets;
  useEffect(() => {
    if (!enabled) return undefined;
    const elements = [first, second].map((r) => r?.current).filter((el): el is HTMLElement => !!el);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let start: { x: number; y: number; id: number } | null = null;

    const cancel = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      start = null;
    };
    const onDown = (e: PointerEvent): void => {
      if (e.pointerType === 'mouse' || e.isPrimary === false) return;
      const target = e.target as Element | null;
      if (selector && !target?.closest?.(selector)) return;
      cancel();
      const press = { x: e.clientX, y: e.clientY, id: e.pointerId };
      start = press;
      timer = setTimeout(() => {
        cancel();
        callbackRef.current({ clientX: press.x, clientY: press.y });
      }, LONG_PRESS_MS);
    };
    const onMove = (e: PointerEvent): void => {
      if (!start || e.pointerId !== start.id) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
    };

    for (const el of elements) {
      el.addEventListener('pointerdown', onDown, { passive: true });
      el.addEventListener('pointermove', onMove, { passive: true });
      el.addEventListener('pointerup', cancel, { passive: true });
      el.addEventListener('pointercancel', cancel, { passive: true });
      // A scroll of the viewport inside (it doesn't bubble: capture it).
      el.addEventListener('scroll', cancel, { passive: true, capture: true });
    }
    return () => {
      cancel();
      for (const el of elements) {
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', cancel);
        el.removeEventListener('pointercancel', cancel);
        el.removeEventListener('scroll', cancel, { capture: true });
      }
    };
  }, [enabled, selector, first, second]);
}
