/**
 * PhoneImageViewer — an image on a phone (AASC-20, feature 49): fitted to the
 * screen, pinch to zoom, drag to pan once zoomed, double-tap to zoom in or back
 * to fit. The − / Fit / + buttons do the same for anyone who can't pinch.
 *
 * The stage takes every touch itself (`touch-action: none`), so a pinch zooms
 * the picture, never the page. The math is in lib/phoneProject (pinchView,
 * dragView), shared with the desktop viewer's clamps.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_VIEW, zoomAroundCursor, type ImageView } from '@/components/session/imageViewport';
import {
  clampPhoneZoom,
  distance,
  dragView,
  midpoint,
  pinchView,
  type Point,
} from '@/lib/phoneProject';
import { ZoomInIcon, ZoomOutIcon } from './projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2.5;
const BUTTON_STEP = 1.5;

interface Gesture {
  pointers: Map<number, Point>;
  pinch: { view: ImageView; distance: number; mid: Point } | null;
  drag: { view: ImageView; from: Point } | null;
  lastTap: { at: number; point: Point } | null;
  moved: boolean;
}

export default function PhoneImageViewer({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ImageView>(DEFAULT_VIEW);
  const gesture = useRef<Gesture>({ pointers: new Map(), pinch: null, drag: null, lastTap: null, moved: false });

  const stageBox = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };
  const local = (e: ReactPointerEvent, box = stageBox()): Point => ({ x: e.clientX - box.left, y: e.clientY - box.top });

  const begin = (current: ImageView) => {
    const g = gesture.current;
    const pts = [...g.pointers.values()];
    if (pts.length >= 2) {
      g.pinch = { view: current, distance: distance(pts[0], pts[1]), mid: midpoint(pts[0], pts[1]) };
      g.drag = null;
    } else if (pts.length === 1) {
      g.pinch = null;
      g.drag = { view: current, from: pts[0] };
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const g = gesture.current;
    g.pointers.set(e.pointerId, local(e));
    g.moved = g.pointers.size > 1;
    begin(view);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId)) return;
    const box = stageBox();
    const point = local(e, box);
    const prev = g.pointers.get(e.pointerId)!;
    if (Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y) > 2) g.moved = true;
    g.pointers.set(e.pointerId, point);
    const pts = [...g.pointers.values()];
    if (g.pinch && pts.length >= 2) {
      setView(pinchView(g.pinch, { distance: distance(pts[0], pts[1]), mid: midpoint(pts[0], pts[1]) }, box));
    } else if (g.drag && pts.length === 1 && g.drag.view.zoom > 1) {
      setView(dragView(g.drag.view, point.x - g.drag.from.x, point.y - g.drag.from.y, box));
    }
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.pointers.has(e.pointerId)) return;
    const point = g.pointers.get(e.pointerId)!;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size > 0) {
      // A finger lifted mid-pinch: carry on as a drag from where the picture is now.
      begin(view);
      return;
    }
    g.pinch = null;
    g.drag = null;
    if (g.moved || e.type === 'pointercancel') {
      g.lastTap = null;
      return;
    }
    const now = Date.now();
    if (g.lastTap && now - g.lastTap.at < DOUBLE_TAP_MS && distance(g.lastTap.point, point) < 24) {
      g.lastTap = null;
      const box = stageBox();
      setView((v) => (v.zoom > 1 ? DEFAULT_VIEW : zoomAroundCursor(v, DOUBLE_TAP_ZOOM, point.x, point.y, box.width, box.height)));
    } else {
      g.lastTap = { at: now, point };
    }
  };

  const zoomBy = (factor: number) => {
    const box = stageBox();
    setView((v) => {
      const zoom = clampPhoneZoom(v.zoom * factor);
      return zoom <= 1 ? DEFAULT_VIEW : zoomAroundCursor(v, zoom, box.width / 2, box.height / 2, box.width, box.height);
    });
  };

  return (
    <div className={styles.imageViewer}>
      <div
        ref={stageRef}
        className={styles.imageStage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        data-zoom={view.zoom.toFixed(2)}
      >
        <img
          className={styles.image}
          src={src}
          alt={alt}
          draggable={false}
          onError={onError}
          style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }}
        />
      </div>
      <div className={styles.imageBar} role="toolbar" aria-label="Zoom">
        <button type="button" className={styles.iconBtn} onClick={() => zoomBy(1 / BUTTON_STEP)} disabled={view.zoom <= 1} aria-label="Zoom out">
          <ZoomOutIcon />
        </button>
        <button type="button" className={styles.textBtn} onClick={() => setView(DEFAULT_VIEW)} disabled={view.zoom <= 1} aria-label="Fit to screen">
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" className={styles.iconBtn} onClick={() => zoomBy(BUTTON_STEP)} disabled={view.zoom >= 8} aria-label="Zoom in">
          <ZoomInIcon />
        </button>
      </div>
    </div>
  );
}
