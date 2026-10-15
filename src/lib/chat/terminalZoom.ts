/**
 * terminalZoom.ts — the Terminal segment's pinch (AASC-45): a visual zoom with
 * sideways pan, a CSS scale on the drawn terminal. It never changes the
 * terminal's columns (Termius and Blink re-fit on pinch; a phone here must not,
 * it never resizes the shared PTY). Pure.
 */

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
/** Within this of 1×, a pinch lands on 1× exactly. */
const SNAP = 0.05;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return Math.abs(z - 1) < SNAP ? 1 : z;
}

export interface PinchStart {
  zoom: number;
  /** Distance between the two fingers. */
  dist: number;
  /** Their midpoint, in the viewport's own coordinates. */
  cx: number;
  cy: number;
  scrollLeft: number;
  scrollTop: number;
}

/**
 * The zoom and scroll for a pinch now: scaled by how far the fingers spread,
 * with the content point that was under their midpoint kept under it (which
 * also pans when both fingers move together).
 */
export function pinchStep(
  start: PinchStart,
  now: { dist: number; cx: number; cy: number },
): { zoom: number; scrollLeft: number; scrollTop: number } {
  const zoom = clampZoom(start.zoom * (now.dist / Math.max(1, start.dist)));
  const contentX = (start.scrollLeft + start.cx) / start.zoom;
  const contentY = (start.scrollTop + start.cy) / start.zoom;
  return {
    zoom,
    scrollLeft: Math.max(0, Math.round(contentX * zoom - now.cx)),
    scrollTop: Math.max(0, Math.round(contentY * zoom - now.cy)),
  };
}

export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
