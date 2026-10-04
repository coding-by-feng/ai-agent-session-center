import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  BRACKET_HALF,
  RIB_PITCH,
  getBracketGeometry,
  getDiscGeometry,
  getPinHeadGeometry,
  getPinTipGeometry,
  getRibbedTexture,
  getSoftDiscTexture,
  markingColors,
  ribCount,
} from './sceneDecals';

describe('markingColors', () => {
  const colours = markingColors({ grid1: '#00f0ff', stripSecondary: '#ff00aa' });
  const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l;

  it('paints lanes whiter than the theme grid colour, whatever the palette', () => {
    expect(lightness(colours.lane)).toBeGreaterThan(lightness(new THREE.Color('#00f0ff')));
  });

  it('eases bay paint toward white without losing the theme accent', () => {
    const accent = new THREE.Color('#ff00aa');
    expect(lightness(colours.bay)).toBeGreaterThan(lightness(accent));
    // still pink, not white: red stays dominant over green
    expect(colours.bay.r).toBeGreaterThan(colours.bay.g);
  });

  it('keeps lanes and bays apart so a lane is never mistaken for a seat', () => {
    expect(colours.lane.equals(colours.bay)).toBe(false);
  });
});

describe('ribCount', () => {
  it('gives a wall a whole number of ribs, one per pitch', () => {
    expect(ribCount(8)).toBe(Math.round(8 / RIB_PITCH));
    // lengths that are NOT a multiple of the pitch: a repeat count with a fraction would cut a rib in half
    for (const length of [3.3, 8.05, 3.25 + 0.07, 1.01]) {
      expect(Number.isInteger(ribCount(length))).toBe(true);
    }
    expect(ribCount(3.3)).toBe(13);
  });

  it('never gives a wall fewer than one rib', () => {
    expect(ribCount(0)).toBe(1);
    expect(ribCount(0.01)).toBe(1);
  });

  it('puts more ribs on a longer wall', () => {
    expect(ribCount(8)).toBeGreaterThan(ribCount(3.25));
  });
});

describe('getRibbedTexture', () => {
  const realCreateElement = document.createElement.bind(document);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Make `document.createElement('canvas')` hand back a fake whose 2D context records its drawing. */
  function fakeCanvas(context: unknown) {
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? canvas : realCreateElement(tag),
    );
    return canvas;
  }
  const recordingContext = () => {
    const stops: Array<[number, string]> = [];
    const fillRect = vi.fn();
    return {
      stops,
      fillRect,
      context: {
        createLinearGradient: vi.fn(() => ({ addColorStop: (offset: number, colour: string) => stops.push([offset, colour]) })),
        fillRect,
        fillStyle: '',
      },
    };
  };

  it('is simply absent where nothing can draw it (no 2D context) — the wall stays plain, and nothing is cached', () => {
    fakeCanvas(null);
    expect(getRibbedTexture(5.55)).toBeNull();
    // a later call that CAN draw must not be answered from a poisoned cache
    const { context } = recordingContext();
    fakeCanvas(context);
    expect(getRibbedTexture(5.55)).toBeInstanceOf(THREE.Texture);
  });

  it('draws one rib — lit flank, shaded groove, lit flank — and repeats it once per rib along the wall', () => {
    const { context, stops, fillRect } = recordingContext();
    fakeCanvas(context);
    const texture = getRibbedTexture(9.1)!;
    expect(texture).toBeInstanceOf(THREE.Texture);
    expect(fillRect).toHaveBeenCalledTimes(1);
    // the groove (middle stop) is darker than the flanks (first and last)
    const brightness = ([, colour]: [number, string]) => parseInt(colour.slice(1, 3), 16);
    expect(brightness(stops[2])).toBeLessThan(brightness(stops[0]));
    expect(brightness(stops[2])).toBeLessThan(brightness(stops[4]));
    // it tiles along the wall (U) a whole number of times and not at all across it
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.repeat.x).toBe(ribCount(9.1));
    expect(texture.repeat.y).toBe(1);
  });

  it('shares one texture between walls that carry the same number of ribs', () => {
    const { context } = recordingContext();
    fakeCanvas(context);
    const eight = getRibbedTexture(8.4)!;
    expect(getRibbedTexture(8.4)).toBe(eight);
    expect(getRibbedTexture(8.41)).toBe(eight); // rounds to the same rib count
    expect(getRibbedTexture(3.4)).not.toBe(eight);
  });
});

function vertices(geometry: THREE.BufferGeometry): THREE.Vector3[] {
  const position = geometry.getAttribute('position');
  return Array.from({ length: position.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i));
}

describe('getBracketGeometry', () => {
  const geometry = getBracketGeometry();
  const points = vertices(geometry);

  it('is eight rectangles: an L of two at each of the four corners', () => {
    expect(points).toHaveLength(8 * 4);
    expect(geometry.getIndex()!.count).toBe(8 * 6);
  });

  it('lies flat on the ground', () => {
    expect(points.every((p) => p.y === 0)).toBe(true);
  });

  it('stays inside the bracketed square and reaches every corner of it', () => {
    // Positions live in a Float32Array, so compare to float32 precision, not double.
    const eps = 1e-6;
    for (const p of points) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(BRACKET_HALF + eps);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(BRACKET_HALF + eps);
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        expect(points.some((p) => Math.abs(p.x - sx * BRACKET_HALF) < eps && Math.abs(p.z - sz * BRACKET_HALF) < eps)).toBe(true);
      }
    }
  });

  it('leaves the middle of each side open — brackets, not a frame', () => {
    expect(points.every((p) => Math.abs(p.x) > 0.3 || Math.abs(p.z) > 0.3)).toBe(true);
    // nothing on the middle third of the top edge
    expect(points.some((p) => Math.abs(p.z - BRACKET_HALF) < 0.01 && Math.abs(p.x) < 0.2)).toBe(false);
  });

  it('does not paint any corner twice', () => {
    // Each rectangle is an axis-aligned quad; no two may overlap in area.
    const rects: Array<[number, number, number, number]> = [];
    for (let i = 0; i < points.length; i += 4) {
      const quad = points.slice(i, i + 4);
      rects.push([
        Math.min(...quad.map((p) => p.x)),
        Math.min(...quad.map((p) => p.z)),
        Math.max(...quad.map((p) => p.x)),
        Math.max(...quad.map((p) => p.z)),
      ]);
    }
    for (let a = 0; a < rects.length; a++) {
      for (let b = a + 1; b < rects.length; b++) {
        const overlapX = Math.min(rects[a][2], rects[b][2]) - Math.max(rects[a][0], rects[b][0]);
        const overlapZ = Math.min(rects[a][3], rects[b][3]) - Math.max(rects[a][1], rects[b][1]);
        expect(overlapX > 1e-9 && overlapZ > 1e-9).toBe(false);
      }
    }
  });

  it('is built once', () => {
    expect(getBracketGeometry()).toBe(geometry);
  });
});

describe('shared decal pieces', () => {
  it('the soft disc texture is created once, and does not need a canvas to exist', () => {
    const texture = getSoftDiscTexture();
    expect(texture).toBeInstanceOf(THREE.Texture);
    expect(getSoftDiscTexture()).toBe(texture);
  });

  it('the disc is a radius-1 circle already lying flat', () => {
    const disc = getDiscGeometry();
    expect(getDiscGeometry()).toBe(disc);
    const points = vertices(disc);
    expect(points.every((p) => Math.abs(p.y) < 1e-9)).toBe(true);
    expect(Math.max(...points.map((p) => Math.hypot(p.x, p.z)))).toBeCloseTo(1, 5);
  });

  it('the pin points down: head round on top, tip tapering to y = -0.1', () => {
    const head = getPinHeadGeometry();
    head.computeBoundingBox();
    expect(head.boundingBox!.max.y).toBeCloseTo(0.1, 5);
    const tip = getPinTipGeometry();
    const points = vertices(tip);
    const apex = points.reduce((lowest, p) => (p.y < lowest.y ? p : lowest));
    expect(apex.y).toBeCloseTo(-0.1, 5);
    expect(Math.hypot(apex.x, apex.z)).toBeLessThan(1e-6); // a point, not a flat bottom
  });
});
