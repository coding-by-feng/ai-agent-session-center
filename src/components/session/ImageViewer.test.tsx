/**
 * ImageViewer tests — covers the pure viewport math helpers and the
 * per-path persistence round-trip exposed by imageViewport.ts.
 *
 * The math helpers are factored into imageViewport.ts precisely so they can
 * be asserted without needing to spin up the full ProjectTab + DOM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_VIEW,
  ZOOM_MAX,
  ZOOM_MIN,
  clampPan,
  clampZoom,
  fitToScreenRatio,
  imageViewKey,
  parseView,
  serializeView,
  zoomAroundCursor,
  zoomInStep,
  zoomOutStep,
  type ImageView,
} from './imageViewport';

describe('clampZoom', () => {
  it('keeps zoom inside [ZOOM_MIN, ZOOM_MAX]', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(100)).toBe(ZOOM_MAX);
    expect(clampZoom(ZOOM_MIN)).toBe(ZOOM_MIN);
    expect(clampZoom(ZOOM_MAX)).toBe(ZOOM_MAX);
  });

  it('falls back to 1 for non-finite input', () => {
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(1);
  });
});

describe('zoomInStep / zoomOutStep', () => {
  it('steps by 0.25 and clamps to bounds', () => {
    expect(zoomInStep(1)).toBeCloseTo(1.25);
    expect(zoomOutStep(1)).toBeCloseTo(0.75);
    expect(zoomInStep(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOutStep(ZOOM_MIN)).toBe(ZOOM_MIN);
    // Stepping out from 0.3 floors at ZOOM_MIN
    expect(zoomOutStep(0.3)).toBe(ZOOM_MIN);
  });
});

describe('clampPan', () => {
  it('forces pan to 0 when zoom <= 1', () => {
    expect(clampPan(50, 100, 1, 800, 600)).toEqual({ panX: 0, panY: 0 });
    expect(clampPan(50, 100, 0.5, 800, 600)).toEqual({ panX: 0, panY: 0 });
  });

  it('clamps pan to +/- container * (zoom - 1) / 2', () => {
    // container 800x600, zoom 2 -> max pan 400x300
    expect(clampPan(500, 400, 2, 800, 600)).toEqual({ panX: 400, panY: 300 });
    expect(clampPan(-500, -400, 2, 800, 600)).toEqual({ panX: -400, panY: -300 });
    // Inside the bound -> unchanged
    expect(clampPan(100, 50, 2, 800, 600)).toEqual({ panX: 100, panY: 50 });
  });

  it('handles zero-sized container defensively', () => {
    expect(clampPan(50, 50, 2, 0, 600)).toEqual({ panX: 0, panY: 0 });
    expect(clampPan(50, 50, 2, 800, 0)).toEqual({ panX: 0, panY: 0 });
  });
});

describe('fitToScreenRatio', () => {
  it('fits a wide image into a narrow container using the min ratio', () => {
    // container 800x600, image 1600x800 -> ratios 0.5, 0.75 -> 0.5
    expect(fitToScreenRatio(800, 600, 1600, 800)).toBeCloseTo(0.5);
  });

  it('fits a tall image by its height', () => {
    // container 800x600, image 800x1200 -> ratios 1.0, 0.5 -> 0.5
    expect(fitToScreenRatio(800, 600, 800, 1200)).toBeCloseTo(0.5);
  });

  it('caps fit ratio at ZOOM_MAX for tiny images', () => {
    // container 1000x1000, image 10x10 -> ratio 100 -> clamped to ZOOM_MAX
    expect(fitToScreenRatio(1000, 1000, 10, 10)).toBe(ZOOM_MAX);
  });

  it('returns 1 for invalid inputs', () => {
    expect(fitToScreenRatio(0, 600, 100, 100)).toBe(1);
    expect(fitToScreenRatio(800, 0, 100, 100)).toBe(1);
    expect(fitToScreenRatio(800, 600, 0, 100)).toBe(1);
    expect(fitToScreenRatio(800, 600, 100, 0)).toBe(1);
    expect(fitToScreenRatio(Number.NaN, 600, 100, 100)).toBe(1);
  });
});

describe('zoomAroundCursor', () => {
  it('keeps the point under the cursor stable when zooming', () => {
    // Container 800x600, cursor at the center (400, 300), old zoom 1.
    // Zooming the center by any factor should result in zero pan.
    const view: ImageView = { zoom: 1, panX: 0, panY: 0 };
    const next = zoomAroundCursor(view, 2, 400, 300, 800, 600);
    expect(next.zoom).toBe(2);
    expect(next.panX).toBe(0);
    expect(next.panY).toBe(0);
  });

  it('pans away from the cursor when zooming from an off-center point', () => {
    // Container 800x600, cursor 600,300 (200 right of center). zoom 1 -> 2.
    // cx = 200, cy = 0, old pan 0,0. scale = 2.
    // rawPanX = 200 - (200 - 0) * 2 = 200 - 400 = -200
    // clamp at zoom 2: max = 800 * 1 / 2 = 400, so -200 is within bounds.
    const view: ImageView = { zoom: 1, panX: 0, panY: 0 };
    const next = zoomAroundCursor(view, 2, 600, 300, 800, 600);
    expect(next.zoom).toBe(2);
    expect(next.panX).toBe(-200);
    expect(next.panY).toBe(0);
  });

  it('is a no-op when the clamped new zoom equals the old zoom', () => {
    const view: ImageView = { zoom: ZOOM_MAX, panX: 100, panY: 50 };
    // Request 100x (way above max) -> clamps to ZOOM_MAX -> unchanged
    const next = zoomAroundCursor(view, 100, 200, 150, 800, 600);
    expect(next).toBe(view);
  });

  it('applies the pan clamp after computing the new offset', () => {
    // Off-center cursor at zoom 3 -> would pan past the bounds; expect clamp.
    const view: ImageView = { zoom: 1, panX: 0, panY: 0 };
    const next = zoomAroundCursor(view, 3, 800, 600, 800, 600);
    // At zoom 3, container 800x600 -> max pan 800, 600.
    // Raw: cx=400, cy=300, rawPanX = 400 - (400-0)*3 = -800 (at the bound).
    expect(next.panX).toBe(-800);
    expect(next.panY).toBe(-600);
  });
});

describe('serializeView / parseView', () => {
  it('round-trips an ImageView through JSON', () => {
    const view: ImageView = { zoom: 2.5, panX: 120, panY: -40 };
    const parsed = parseView(serializeView(view));
    expect(parsed).not.toBeNull();
    expect(parsed!.zoom).toBeCloseTo(2.5);
    expect(parsed!.panX).toBe(120);
    expect(parsed!.panY).toBe(-40);
  });

  it('clamps zoom when parsing out-of-range data', () => {
    const bad = JSON.stringify({ zoom: 999, panX: 0, panY: 0, v: 1 });
    const parsed = parseView(bad);
    expect(parsed!.zoom).toBe(ZOOM_MAX);
  });

  it('returns null for invalid inputs', () => {
    expect(parseView(null)).toBeNull();
    expect(parseView(undefined)).toBeNull();
    expect(parseView('')).toBeNull();
    expect(parseView('not json')).toBeNull();
    expect(parseView(JSON.stringify({ zoom: 'a', panX: 0, panY: 0 }))).toBeNull();
    expect(parseView(JSON.stringify({ zoom: 1, panY: 0 }))).toBeNull();
  });
});

describe('imageViewKey', () => {
  it('builds a stable namespaced key from a file path', () => {
    expect(imageViewKey('/a/b/c.png')).toBe('agent-manager:image-view:/a/b/c.png');
  });
});

describe('persistence round-trip via localStorage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('saves a view and restores it on next read', () => {
    const path = '/some/image.png';
    const view: ImageView = { zoom: 1.75, panX: 40, panY: -20 };
    window.localStorage.setItem(imageViewKey(path), serializeView(view));
    const raw = window.localStorage.getItem(imageViewKey(path));
    const restored = parseView(raw);
    expect(restored).not.toBeNull();
    expect(restored!.zoom).toBeCloseTo(1.75);
    expect(restored!.panX).toBe(40);
    expect(restored!.panY).toBe(-20);
  });

  it('returns the default view for a file that has never been saved', () => {
    const raw = window.localStorage.getItem(imageViewKey('/never/saved.png'));
    expect(parseView(raw)).toBeNull();
    // Consumer should fall back to DEFAULT_VIEW
    expect(DEFAULT_VIEW).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it('isolates state per file path', () => {
    const a: ImageView = { zoom: 2, panX: 10, panY: 20 };
    const b: ImageView = { zoom: 0.5, panX: -5, panY: -10 };
    window.localStorage.setItem(imageViewKey('/a.png'), serializeView(a));
    window.localStorage.setItem(imageViewKey('/b.png'), serializeView(b));
    expect(parseView(window.localStorage.getItem(imageViewKey('/a.png')))!.zoom).toBeCloseTo(2);
    expect(parseView(window.localStorage.getItem(imageViewKey('/b.png')))!.zoom).toBeCloseTo(0.5);
  });
});
