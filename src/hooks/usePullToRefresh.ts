/**
 * usePullToRefresh — drag the top of a scrolling list down to refresh it (the
 * phone's LIVE page, AASC-18).
 *
 * Touch events, not pointer events: once the browser decides a touch is a
 * scroll it cancels the pointer stream, which is exactly the gesture this is.
 * The drag distance is written to the scroller as `--pull` (a CSS variable, no
 * re-render per finger move); React state changes only at the phase changes
 * (pulling → armed → refreshing), which is what the indicator's words follow.
 *
 * A gesture must not be the only way: `refresh()` runs the same refresh for a
 * button. A refresh in flight ignores a second one.
 */
import { useCallback, useRef, useState, type TouchEvent } from 'react';

/** How far (px of indicator) a pull must go before letting go refreshes. */
export const PULL_THRESHOLD = 64;
/** The indicator never grows past this, however far the finger goes. */
export const PULL_MAX = 96;
/** The finger moves this much for each px the indicator grows: a little resistance. */
const PULL_RESISTANCE = 0.5;
/** The indicator's height while refreshing. */
export const PULL_REST = 48;
/** A refresh shows its spinner at least this long, so a fast one still reads as "done". */
const MIN_SPIN_MS = 600;

export type PullPhase = 'idle' | 'pulling' | 'armed' | 'refreshing';

export interface PullToRefresh<T extends HTMLElement> {
  scrollerRef: React.RefObject<T | null>;
  phase: PullPhase;
  handlers: {
    onTouchStart: (e: TouchEvent<T>) => void;
    onTouchMove: (e: TouchEvent<T>) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  refresh: () => Promise<void>;
}

export function usePullToRefresh<T extends HTMLElement>(onRefresh: () => Promise<unknown>): PullToRefresh<T> {
  const scrollerRef = useRef<T | null>(null);
  const [phase, setPhase] = useState<PullPhase>('idle');
  const startY = useRef<number | null>(null);
  const distance = useRef(0);
  const busy = useRef(false);

  const setPull = (px: number) => {
    scrollerRef.current?.style.setProperty('--pull', `${px}px`);
  };

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setPhase('refreshing');
    setPull(PULL_REST);
    const started = Date.now();
    try {
      await onRefresh();
    } finally {
      const left = MIN_SPIN_MS - (Date.now() - started);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
      busy.current = false;
      setPull(0);
      setPhase('idle');
    }
  }, [onRefresh]);

  const onTouchStart = useCallback((e: TouchEvent<T>) => {
    const scroller = scrollerRef.current;
    // Only from the very top: anywhere else the same drag is an ordinary scroll up.
    // And only on the list itself: a touch in a sheet opened from it (a portal)
    // bubbles here through React, but is that sheet's own drag.
    const inside = scroller && e.target instanceof Node && scroller.contains(e.target);
    if (busy.current || !scroller || !inside || scroller.scrollTop > 0 || e.touches.length !== 1) {
      startY.current = null;
      return;
    }
    startY.current = e.touches[0].clientY;
    distance.current = 0;
  }, []);

  const onTouchMove = useCallback((e: TouchEvent<T>) => {
    if (startY.current === null || busy.current) return;
    const scroller = scrollerRef.current;
    const dy = e.touches[0].clientY - startY.current;
    if (dy <= 0 || (scroller && scroller.scrollTop > 0)) {
      if (distance.current > 0) {
        distance.current = 0;
        setPull(0);
        setPhase('idle');
      }
      return;
    }
    const pull = Math.min(PULL_MAX, dy * PULL_RESISTANCE);
    distance.current = pull;
    setPull(pull);
    setPhase(pull >= PULL_THRESHOLD ? 'armed' : 'pulling');
  }, []);

  const onTouchEnd = useCallback(() => {
    if (startY.current === null) return;
    startY.current = null;
    const pulled = distance.current;
    distance.current = 0;
    if (pulled >= PULL_THRESHOLD) {
      void refresh();
    } else if (pulled > 0) {
      setPull(0);
      setPhase('idle');
    }
  }, [refresh]);

  const onTouchCancel = useCallback(() => {
    startY.current = null;
    distance.current = 0;
    if (!busy.current) {
      setPull(0);
      setPhase('idle');
    }
  }, []);

  return { scrollerRef, phase, handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }, refresh };
}
