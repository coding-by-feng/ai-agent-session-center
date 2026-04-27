/**
 * Pure helpers for the image viewer: zoom clamping, pan clamping, fit-to-screen
 * ratio, and persistence key. Factored out for direct unit testing.
 */

export interface ImageView {
  zoom: number;
  panX: number;
  panY: number;
}

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 0.25;
/** Multiplicative factor per wheel tick (deltaY ~100 ⇒ ~10% zoom change). */
export const ZOOM_WHEEL_FACTOR = 0.001;
export const PAN_STEP = 30;
export const PERSIST_VERSION = 1;
export const PERSIST_DEBOUNCE_MS = 200;

/** Persistence key for per-file view state. */
export function imageViewKey(filePath: string): string {
  return `agent-manager:image-view:${filePath}`;
}

/** Default reset state. */
export const DEFAULT_VIEW: ImageView = Object.freeze({ zoom: 1, panX: 0, panY: 0 });

/** Clamp a zoom level to the allowed range. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX);
}

/**
 * Clamp a pan offset so the image can't be dragged entirely off-screen.
 * We allow the image to travel up to container * (zoom - 1) / 2 in either
 * direction — this keeps at least half the container filled at all times.
 *
 * When zoom <= 1 the pan is always clamped to 0 (no room to pan inside the
 * visible area at/under 100% zoom).
 */
export function clampPan(
  panX: number,
  panY: number,
  zoom: number,
  containerW: number,
  containerH: number,
): { panX: number; panY: number } {
  if (zoom <= 1 || containerW <= 0 || containerH <= 0) {
    return { panX: 0, panY: 0 };
  }
  const maxX = (containerW * (zoom - 1)) / 2;
  const maxY = (containerH * (zoom - 1)) / 2;
  return {
    panX: Math.min(Math.max(panX, -maxX), maxX),
    panY: Math.min(Math.max(panY, -maxY), maxY),
  };
}

/**
 * Compute the fit-to-screen ratio. Returns the clamped zoom level that fits
 * the natural image inside the container while preserving aspect ratio.
 */
export function fitToScreenRatio(
  containerW: number,
  containerH: number,
  naturalW: number,
  naturalH: number,
): number {
  if (
    !Number.isFinite(containerW) ||
    !Number.isFinite(containerH) ||
    !Number.isFinite(naturalW) ||
    !Number.isFinite(naturalH) ||
    containerW <= 0 ||
    containerH <= 0 ||
    naturalW <= 0 ||
    naturalH <= 0
  ) {
    return 1;
  }
  const ratio = Math.min(containerW / naturalW, containerH / naturalH);
  return clampZoom(ratio);
}

/**
 * Zoom centered on the mouse cursor. Given the old zoom and the cursor
 * position relative to the container (with container center as origin),
 * returns the new pan offsets that keep the point under the cursor stable.
 *
 * The image is rendered with transform-origin: center center, so the screen
 * position of a point at logical coordinate (x, y) relative to the container
 * center is: screen = pan + zoom * (x, y). Keeping the screen point fixed
 * under the cursor means newPan = cursor - (cursor - oldPan) * (newZoom / oldZoom).
 */
export function zoomAroundCursor(
  view: ImageView,
  newZoom: number,
  cursorX: number,
  cursorY: number,
  containerW: number,
  containerH: number,
): ImageView {
  const clampedZoom = clampZoom(newZoom);
  if (clampedZoom === view.zoom) return view;
  // cursor relative to container center
  const cx = cursorX - containerW / 2;
  const cy = cursorY - containerH / 2;
  const scale = clampedZoom / view.zoom;
  const rawPanX = cx - (cx - view.panX) * scale;
  const rawPanY = cy - (cy - view.panY) * scale;
  const { panX, panY } = clampPan(rawPanX, rawPanY, clampedZoom, containerW, containerH);
  return { zoom: clampedZoom, panX, panY };
}

/** Serialize an ImageView with version for persistence. */
export function serializeView(view: ImageView): string {
  return JSON.stringify({ ...view, v: PERSIST_VERSION });
}

/** Parse a persisted ImageView. Returns null if the payload is invalid. */
export function parseView(raw: string | null | undefined): ImageView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImageView> & { v?: number };
    if (
      typeof parsed.zoom !== 'number' ||
      typeof parsed.panX !== 'number' ||
      typeof parsed.panY !== 'number'
    ) {
      return null;
    }
    return {
      zoom: clampZoom(parsed.zoom),
      panX: parsed.panX,
      panY: parsed.panY,
    };
  } catch {
    return null;
  }
}

/** Step zoom up by ZOOM_STEP, clamped to ZOOM_MAX. */
export function zoomInStep(z: number): number {
  return clampZoom(z + ZOOM_STEP);
}

/** Step zoom down by ZOOM_STEP, clamped to ZOOM_MIN. */
export function zoomOutStep(z: number): number {
  return clampZoom(z - ZOOM_STEP);
}
