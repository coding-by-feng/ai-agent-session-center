/**
 * ZoomViewport — pinch to zoom the drawn terminal, with sideways pan (AASC-45).
 *
 * The terminal inside keeps its layout size: the zoom is a CSS scale on it, and
 * a sizer as big as the scaled terminal gives the viewport something to scroll.
 * So xterm never sees a resize, never re-fits, and the PTY's columns stay what
 * they are (a phone never resizes the shared PTY). One-finger drags scroll as
 * usual; two fingers pinch. The page itself doesn't zoom here (touch-action).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { pinchStep, type PinchStart } from '@/lib/chat/terminalZoom';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

export interface ZoomViewportProps {
  zoom: number;
  onZoom: (zoom: number) => void;
  children: ReactNode;
  testId?: string;
}

type Base = { w: number; h: number };

function fingers(el: HTMLElement, touches: TouchList): { dist: number; cx: number; cy: number } {
  const rect = el.getBoundingClientRect();
  const [a, b] = [touches[0], touches[1]];
  return {
    dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
    cx: (a.clientX + b.clientX) / 2 - rect.left,
    cy: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

export default function ZoomViewport({ zoom, onZoom, children, testId }: ZoomViewportProps) {
  const outer = useRef<HTMLDivElement>(null);
  const [base, setBase] = useState<Base | null>(null);
  const zoomRef = useRef(zoom);
  const onZoomRef = useRef(onZoom);
  useEffect(() => {
    zoomRef.current = zoom;
    onZoomRef.current = onZoom;
  }, [zoom, onZoom]);

  // The unzoomed size: what the terminal lays out at, whatever the zoom.
  useEffect(() => {
    const el = outer.current;
    // No observer (an old WebView, a test page): the terminal just fills the viewport unzoomed.
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setBase((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = outer.current;
    if (!el) return undefined;
    let start: PinchStart | null = null;
    let frame = 0;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const f = fingers(el, e.touches);
      start = { zoom: zoomRef.current, dist: f.dist, cx: f.cx, cy: f.cy, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      const step = pinchStep(start, fingers(el, e.touches));
      onZoomRef.current(step.zoom);
      cancelAnimationFrame(frame);
      // After React has drawn the new size, so the scroll has room to land.
      frame = requestAnimationFrame(() => {
        el.scrollLeft = step.scrollLeft;
        el.scrollTop = step.scrollTop;
      });
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) start = null;
    };
    // iOS Safari's own page zoom.
    const noGesture = (e: Event) => e.preventDefault();
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    el.addEventListener('gesturestart', noGesture);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      el.removeEventListener('gesturestart', noGesture);
    };
  }, []);

  const vars = base
    ? ({ '--zoom': String(zoom), '--base-w': `${base.w}px`, '--base-h': `${base.h}px` } as CSSProperties)
    : undefined;
  return (
    <div ref={outer} className={styles.zoomViewport} data-zoomed={zoom > 1 ? '' : undefined} style={vars} data-testid={testId}>
      <div className={styles.zoomSizer}>
        <div className={styles.zoomContent}>{children}</div>
      </div>
    </div>
  );
}
