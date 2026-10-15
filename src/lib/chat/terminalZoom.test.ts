// terminalZoom.test.ts — the Terminal segment's pinch: a visual zoom with sideways
// pan (AASC-45). It scales the drawn terminal, never its columns.
import { describe, it, expect } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, clampZoom, pinchStep, zoomLabel } from './terminalZoom';

describe('clampZoom', () => {
  it(`keeps the zoom between ${MIN_ZOOM}× and ${MAX_ZOOM}×`, () => {
    expect(clampZoom(0.4)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });

  it('snaps to 1× when nearly there, so a pinch back ends unzoomed', () => {
    expect(clampZoom(1.03)).toBe(1);
  });
});

describe('pinchStep', () => {
  const start = { zoom: 1, dist: 100, cx: 100, cy: 50, scrollLeft: 0, scrollTop: 0 };

  it('zooms by how far the fingers spread', () => {
    expect(pinchStep(start, { dist: 200, cx: 100, cy: 50 }).zoom).toBe(2);
    expect(pinchStep({ ...start, zoom: 2 }, { dist: 50, cx: 100, cy: 50 }).zoom).toBe(1);
  });

  it('keeps the point between the fingers under them', () => {
    // At 2× the content point (100, 50) sits at (200, 100): scroll so it stays at (100, 50).
    expect(pinchStep(start, { dist: 200, cx: 100, cy: 50 })).toEqual({ zoom: 2, scrollLeft: 100, scrollTop: 50 });
  });

  it('follows fingers that move while they pinch (a pan)', () => {
    const zoomed = { zoom: 2, dist: 100, cx: 100, cy: 50, scrollLeft: 100, scrollTop: 50 };
    expect(pinchStep(zoomed, { dist: 100, cx: 60, cy: 50 })).toEqual({ zoom: 2, scrollLeft: 140, scrollTop: 50 });
  });

  it('never scrolls before the start', () => {
    expect(pinchStep(start, { dist: 120, cx: 300, cy: 300 })).toMatchObject({ scrollLeft: 0, scrollTop: 0 });
  });
});

describe('zoomLabel', () => {
  it('says the zoom as a percentage', () => {
    expect(zoomLabel(1.5)).toBe('150%');
    expect(zoomLabel(2.04)).toBe('204%');
  });
});
