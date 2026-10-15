/**
 * useEdgeSwipeBack — the iPhone back swipe, in the page (AASC-39).
 *
 * A touch that starts within EDGE_PX of the left edge and moves sideways drags
 * the top screen with the finger (the one under it shows through). Released
 * past COMPLETE_RATIO of the width, or flicked faster than FLICK_PX_PER_MS, it
 * slides the rest of the way and pops; otherwise it slides back. A touch that
 * moves up or down first is a scroll and is left alone.
 *
 * In-page rather than WKWebView's `allowsBackForwardNavigationGestures`, whose
 * snapshot animation can't see in-page screens and can swipe back into the
 * shell (docs/plans/mobile/11 §4.2). Only on pushed screens (`enabled`). The
 * drag is written to CSS variables on the container (--edge-dx px, --edge-p
 * 0…1) and a `data-swipe` attribute, never state, so a move re-renders nothing.
 * Under Reduce Motion the finger still drives it, but the finish is instant.
 */
import { useEffect, type RefObject } from 'react';

export const EDGE_PX = 16;
export const COMPLETE_RATIO = 0.4;
export const FLICK_PX_PER_MS = 0.5;
const AXIS_LOCK_PX = 10;
const SETTLE_MS = 250;
const GONE_FALLBACK_MS = 600;

export function edgeSwipeOutcome(dx: number, width: number, velocity: number): 'complete' | 'cancel' {
  if (dx <= 0 || width <= 0) return 'cancel';
  if (dx >= width * COMPLETE_RATIO) return 'complete';
  return velocity >= FLICK_PX_PER_MS && dx > AXIS_LOCK_PX * 2 ? 'complete' : 'cancel';
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useEdgeSwipeBack(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return;
    let track: { x: number; y: number; t: number; lastX: number; lastT: number; v: number; axis: 'x' | 'y' | null; width: number } | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;

    const write = (dx: number, width: number) => {
      el.style.setProperty('--edge-dx', `${Math.round(dx)}px`);
      el.style.setProperty('--edge-p', String(Math.min(1, Math.max(0, dx / width))));
    };
    const reset = () => {
      delete el.dataset.swipe;
      el.style.removeProperty('--edge-dx');
      el.style.removeProperty('--edge-p');
    };

    const onStart = (e: TouchEvent) => {
      if (settle || e.touches.length !== 1) return;
      const rect = el.getBoundingClientRect();
      const touch = e.touches[0];
      if (touch.clientX - rect.left > EDGE_PX) return;
      track = { x: touch.clientX, y: touch.clientY, t: e.timeStamp, lastX: touch.clientX, lastT: e.timeStamp, v: 0, axis: null, width: rect.width };
    };

    const onMove = (e: TouchEvent) => {
      if (!track) return;
      const touch = e.touches[0];
      const dx = touch.clientX - track.x;
      const dy = touch.clientY - track.y;
      if (!track.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        track.axis = dx > 0 && Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (track.axis === 'y') {
          track = null;
          return;
        }
        el.dataset.swipe = 'drag';
      }
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - track.lastT);
      track.v = (touch.clientX - track.lastX) / dt;
      track.lastX = touch.clientX;
      track.lastT = e.timeStamp;
      write(Math.max(0, dx), track.width);
    };

    const onEnd = () => {
      const t = track;
      track = null;
      if (!t || t.axis !== 'x') return;
      const dx = Math.max(0, t.lastX - t.x);
      const outcome = edgeSwipeOutcome(dx, t.width, t.v);
      if (prefersReducedMotion()) {
        reset();
        if (outcome === 'complete') onBack();
        return;
      }
      el.dataset.swipe = 'settle';
      write(outcome === 'complete' ? t.width : 0, t.width);
      settle = setTimeout(() => {
        settle = null;
        if (outcome !== 'complete') {
          reset();
          return;
        }
        // Keep the screen off to the side until the pop has removed it, or it
        // flashes back for a frame between history.back() and its popstate.
        const done = () => {
          window.removeEventListener('popstate', done);
          clearTimeout(fallback);
          requestAnimationFrame(reset);
        };
        const fallback = setTimeout(done, GONE_FALLBACK_MS);
        window.addEventListener('popstate', done);
        onBack();
      }, SETTLE_MS);
    };

    el.addEventListener('touchstart', onStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onMove, { passive: false, capture: true });
    el.addEventListener('touchend', onEnd, { capture: true });
    el.addEventListener('touchcancel', onEnd, { capture: true });
    return () => {
      el.removeEventListener('touchstart', onStart, { capture: true });
      el.removeEventListener('touchmove', onMove, { capture: true });
      el.removeEventListener('touchend', onEnd, { capture: true });
      el.removeEventListener('touchcancel', onEnd, { capture: true });
      if (settle) clearTimeout(settle);
      reset();
    };
  }, [containerRef, enabled, onBack]);
}
