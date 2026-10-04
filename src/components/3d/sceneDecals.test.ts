import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { THEMES, type ThemeName } from '@/stores/settingsStore';
import { deltaE } from '@/lib/colorMath';
import { clayToneFor } from '@/lib/dioramaLighting';
import { getScene3DTheme } from '@/lib/sceneThemes';
import {
  BRACKET_HALF,
  RIB_PITCH,
  getBracketGeometry,
  getDiscGeometry,
  getPinHeadGeometry,
  getPinTipGeometry,
  SLAB,
  getRibbedTexture,
  getSlabTexture,
  getSoftDiscTexture,
  markingColors,
  ribCount,
  slabCount,
  stripColorFor,
} from './sceneDecals';

describe('markingColors', () => {
  const hex = (c: THREE.Color) => `#${c.getHexString()}`;

  describe('on a dark palette (the standard tone)', () => {
    const colours = markingColors({ grid1: '#00f0ff', stripPrimary: '#00f0ff', stripSecondary: '#ff00aa' }, 'standard');
    const lightness = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).l;

    it('paints lanes whiter than the theme grid colour: road paint on dark asphalt', () => {
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

    it('takes each room accent from ITS own theme field, not from the lane colour', () => {
      // grid1, stripPrimary and stripSecondary all different (they are, on windows-xp)
      const theme = { grid1: '#111111', stripPrimary: '#00aa00', stripSecondary: '#aa0000' };
      const [first, second] = markingColors(theme, 'standard').accents;
      expect(first.g).toBeGreaterThan(first.r); // green-ish: from stripPrimary
      expect(second.r).toBeGreaterThan(second.g); // red-ish: from stripSecondary
    });

    it('eases the two room accents toward white too, like the bays: paint, not neon tubes', () => {
      const withAccents = markingColors({ grid1: '#00f0ff', stripPrimary: '#00f0ff', stripSecondary: '#ff00aa' }, 'standard');
      expect(lightness(withAccents.accents[0])).toBeGreaterThan(lightness(new THREE.Color('#00f0ff')));
      expect(lightness(withAccents.accents[1])).toBeGreaterThan(lightness(new THREE.Color('#ff00aa')));
    });
  });

  // Whitening is right on dark asphalt and exactly wrong on a bright floor: white paint on a white floor.
  // Measured in a render on light, warm and blonde, the lanes sat 5-12 CIELAB units from the floor.
  describe('on a bright palette (the deep tone)', () => {
    const palettes = THEMES.map((theme) => theme.name).filter(
      (name: ThemeName) => clayToneFor(getScene3DTheme(name)) === 'deep',
    );

    it('has bright palettes to test', () => {
      expect(palettes.length).toBeGreaterThanOrEqual(4);
    });

    it('paints with the theme’s own colours, not eased toward white', () => {
      const colours = markingColors({ grid1: '#3b82f6', stripPrimary: '#3b82f6', stripSecondary: '#0ea5e9' }, 'deep');
      expect(hex(colours.lane)).toBe('#3b82f6');
      expect(hex(colours.bay)).toBe('#0ea5e9');
      expect(colours.accents.map(hex)).toEqual(['#3b82f6', '#0ea5e9']);
    });

    // 40 CIELAB units at paint level; the lit floor and the 0.62 paint opacity roughly halve it on screen,
    // which the render audit measured at 25 or better on every bright palette.
    it.each(palettes)('reads against the %s floor and room floor', (name) => {
      const theme = getScene3DTheme(name);
      const colours = markingColors(theme, 'deep');
      for (const [what, paint] of [['lane', colours.lane], ['bay', colours.bay]] as const) {
        for (const floor of [theme.floor, theme.roomFloor]) {
          expect(deltaE(hex(paint), floor), `${name} ${what} on ${floor}`).toBeGreaterThanOrEqual(40);
        }
      }
    });

    it('would not have: the standard (whitened) lane paint is under 40 from the floor on warm, light and blonde', () => {
      for (const name of ['warm', 'light', 'blonde'] as const) {
        const theme = getScene3DTheme(name);
        const whitened = markingColors(theme, 'standard');
        expect(deltaE(hex(whitened.lane), theme.floor), name).toBeLessThan(40);
      }
    });

    it('takes each room accent from ITS own theme field, not from the lane colour', () => {
      const colours = markingColors({ grid1: '#111111', stripPrimary: '#00aa00', stripSecondary: '#aa0000' }, 'deep');
      expect(colours.accents.map(hex)).toEqual(['#00aa00', '#aa0000']);
      expect(hex(colours.lane)).toBe('#111111');
    });

    it('keeps lanes and bays apart', () => {
      for (const name of palettes) {
        const colours = markingColors(getScene3DTheme(name), 'deep');
        expect(colours.lane.equals(colours.bay), name).toBe(false);
      }
    });
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

describe('slabCount', () => {
  it('gives a floor a whole number of slabs, one per SLAB units', () => {
    expect(slabCount(8)).toBe(Math.round(8 / SLAB));
    expect(slabCount(60)).toBe(Math.round(60 / SLAB));
    // sizes that are NOT a multiple of the slab: a fractional repeat would cut a slab in half at the edge
    for (const size of [7.3, 22.9, 61.4]) expect(Number.isInteger(slabCount(size))).toBe(true);
  });

  it('never gives a floor fewer than one slab', () => {
    expect(slabCount(0)).toBe(1);
    expect(slabCount(0.5)).toBe(1);
  });
});

describe('getSlabTexture', () => {
  const realCreateElement = document.createElement.bind(document);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fake canvas whose 2D context records every fill, with the colour it was painted in. */
  function fakeCanvas() {
    const fills: Array<{ style: string; x: number; y: number; w: number; h: number }> = [];
    const context = {
      fillStyle: '',
      fillRect(x: number, y: number, w: number, h: number) {
        fills.push({ style: String(this.fillStyle), x, y, w, h });
      },
    };
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? canvas : realCreateElement(tag),
    );
    return { canvas, fills };
  }
  const grey = (style: string) => parseInt(style.slice(1, 3), 16) / 255;

  it('is simply absent where nothing can draw it (no 2D context): the floor stays plain, nothing is cached', () => {
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
      tag === 'canvas' ? ({ getContext: () => null } as unknown as HTMLCanvasElement) : realCreateElement(tag),
    );
    expect(getSlabTexture(31.1)).toBeNull();
    // a later call that CAN draw must not be answered from a poisoned cache
    fakeCanvas();
    expect(getSlabTexture(31.1)).toBeInstanceOf(THREE.Texture);
  });

  it('draws one slab: a light fill, then a darker joint down its left edge and along its top edge', () => {
    const { canvas, fills } = fakeCanvas();
    getSlabTexture(37.7);
    const [slab, ...joints] = fills;
    expect(slab).toMatchObject({ x: 0, y: 0, w: canvas.width, h: canvas.height });
    expect(joints).toHaveLength(2);
    // a joint along the left edge (thin, full height) and along the top edge (thin, full width): the two
    // edges that tile into a full grid, so a slab is never outlined twice
    const [left, top] = joints;
    expect(left).toMatchObject({ x: 0, y: 0, h: canvas.height });
    expect(left.w).toBeLessThan(canvas.width / 16);
    expect(top).toMatchObject({ x: 0, y: 0, w: canvas.width });
    expect(top.h).toBeLessThan(canvas.height / 16);
    expect(grey(left.style)).toBeLessThan(grey(slab.style));
    expect(left.style).toBe(top.style);
  });

  // The joints are a hint of scale, not a grid: a hard black line would fight the lane dashes and the seat outlines.
  it('keeps the joints faint: no darker than 80% of the slab', () => {
    const { fills } = fakeCanvas();
    getSlabTexture(41.3);
    const [slab, left] = fills;
    expect(grey(left.style) / grey(slab.style)).toBeGreaterThan(0.8);
  });

  it('repeats once per slab in both directions, wrapping rather than stretching', () => {
    fakeCanvas();
    const texture = getSlabTexture(23.9)!;
    expect(texture.repeat.x).toBe(slabCount(23.9));
    expect(texture.repeat.y).toBe(slabCount(23.9));
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
  });

  it('shares one texture between floors with the same number of slabs', () => {
    fakeCanvas();
    const a = getSlabTexture(51.2)!;
    expect(getSlabTexture(51.4)).toBe(a); // rounds to the same slab count
    expect(getSlabTexture(8.0)).not.toBe(a);
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

describe('stripColorFor', () => {
  const colours = {
    lane: new THREE.Color('#111111'),
    bay: new THREE.Color('#222222'),
    accents: [new THREE.Color('#00aa00'), new THREE.Color('#aa0000')] as [THREE.Color, THREE.Color],
  };

  it('paints a lane in the lane colour and a bay in the bay colour', () => {
    expect(stripColorFor({ kind: 'lane' }, colours)).toBe(colours.lane);
    expect(stripColorFor({ kind: 'bay' }, colours)).toBe(colours.bay);
  });

  it('paints a threshold in its room’s accent: the first for accent 0, the second for accent 1', () => {
    expect(stripColorFor({ kind: 'threshold', accent: 0 }, colours)).toBe(colours.accents[0]);
    expect(stripColorFor({ kind: 'threshold', accent: 1 }, colours)).toBe(colours.accents[1]);
  });

  it('falls back to the first accent for a threshold with none', () => {
    expect(stripColorFor({ kind: 'threshold' }, colours)).toBe(colours.accents[0]);
  });
});
