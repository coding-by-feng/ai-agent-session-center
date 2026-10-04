import { describe, it, expect } from 'vitest';
import { THEMES, type ThemeName } from '@/stores/settingsStore';
import { parseHex, rgbToHsl } from './colorMath';
import {
  BASE_EXPOSURE,
  CLAY_PAINT,
  DEEP_LIVERY,
  clayToneFor,
  dioramaLighting,
  isLightBackground,
  liveryPaint,
  sceneExposure,
  type ClayTone,
} from './dioramaLighting';
import { PALETTE } from './robotPalette';
import { getScene3DTheme } from './sceneThemes';

const darkTheme = {
  background: '#0e0c1a',
  ambientIntensity: 5,
  dirIntensity: 3.5,
  fillIntensity: 1.5,
  hemisphereIntensity: 2,
};

// The shape of the `light` palette: already bright, lit hard (see sceneThemes.ts).
const lightTheme = {
  background: '#eef2f8',
  ambientIntensity: 9,
  dirIntensity: 5,
  fillIntensity: 3,
  hemisphereIntensity: 5,
};

describe('isLightBackground', () => {
  it('tells a dark palette from a light one by its background', () => {
    expect(isLightBackground('#0e0c1a')).toBe(false);
    expect(isLightBackground('#4a90d9')).toBe(false); // a mid blue sky is not "light"
    expect(isLightBackground('#eef2f8')).toBe(true);
    expect(isLightBackground('#ffffff')).toBe(true);
  });

  it('reads every hex length, ignoring any alpha', () => {
    expect(isLightBackground('#fff')).toBe(true);
    expect(isLightBackground('#fffa')).toBe(true);
    expect(isLightBackground('#eef2f8ff')).toBe(true);
    expect(isLightBackground('#0e0c1a80')).toBe(false);
    expect(isLightBackground('#000f')).toBe(false);
  });

  // Alpha is not part of the colour: a bright green that is fully transparent is still bright, and the
  // colour is the FIRST six digits (reading the last six would make `#00ff0000` a red).
  it('ignores alpha rather than weighing it or mistaking it for colour', () => {
    expect(isLightBackground('#00ff0000')).toBe(true);
    expect(isLightBackground('#ffffff00')).toBe(true);
    expect(isLightBackground('#000000ff')).toBe(false);
    expect(isLightBackground('#0f0a')).toBe(true); // short form: #00ff00, alpha aa
  });

  it('falls back to dark for anything it cannot parse', () => {
    expect(isLightBackground('rgb(255,255,255)')).toBe(false);
    expect(isLightBackground('')).toBe(false);
  });
});

describe('dioramaLighting on a dark palette', () => {
  const rig = dioramaLighting(darkTheme);

  it('softens the key light: shadows come from a weaker sun than the neon scene uses', () => {
    expect(rig.dir).toBeLessThan(darkTheme.dirIntensity);
  });

  it('fills the shadows from above instead: the sky light is stronger than the neon scene uses', () => {
    expect(rig.hemisphere).toBeGreaterThan(darkTheme.hemisphereIntensity);
  });

  it('quietens the coloured point lights that wash the neon scene', () => {
    expect(rig.pointScale).toBeLessThan(1);
    expect(rig.pointScale).toBeGreaterThan(0);
  });

  it('keeps every light on — a theme must never come out black', () => {
    for (const value of [rig.ambient, rig.dir, rig.fill, rig.hemisphere]) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('scales with the theme: a brighter palette stays brighter', () => {
    const bright = dioramaLighting({ ...darkTheme, dirIntensity: darkTheme.dirIntensity * 2 });
    expect(bright.dir).toBeGreaterThan(rig.dir);
  });

  it('is a plain function of the theme', () => {
    expect(dioramaLighting(darkTheme)).toEqual(rig);
  });
});

describe('sceneExposure', () => {
  it('leaves the neon cyberdrome exactly as it always rendered, whatever the palette', () => {
    expect(sceneExposure('cyberdrome', darkTheme)).toBe(BASE_EXPOSURE);
    expect(sceneExposure('cyberdrome', lightTheme)).toBe(BASE_EXPOSURE);
  });

  it('leaves the diorama on a dark palette at the base exposure', () => {
    expect(sceneExposure('diorama', darkTheme)).toBe(BASE_EXPOSURE);
  });

  // The tone mapper brightens by `exposure`; on a palette that is already near white that is the
  // difference between a floor with a little shade in it and a floor that is flat white.
  it('pulls the diorama back on a light palette so its floor keeps some shade', () => {
    expect(sceneExposure('diorama', lightTheme)).toBeLessThan(BASE_EXPOSURE);
    expect(sceneExposure('diorama', lightTheme)).toBeGreaterThan(0.5);
  });
});

describe('dioramaLighting on a light palette', () => {
  const rig = dioramaLighting(lightTheme);

  // A bright palette is lit hard to look bright; adding the dark palette's sky-light boost on top
  // blows the floor out to flat white and loses every edge of the furniture.
  it('does not boost the sky light or the ambient light — the palette is bright already', () => {
    expect(rig.hemisphere).toBeLessThanOrEqual(lightTheme.hemisphereIntensity);
    expect(rig.ambient).toBeLessThanOrEqual(lightTheme.ambientIntensity);
  });

  it('still softens the key light', () => {
    expect(rig.dir).toBeLessThan(lightTheme.dirIntensity);
  });

  // The palette's own numbers are tuned so DARK objects (the neon scene's metal) come out right under
  // a bright rig. A matte, mid-toned diorama under the same light clips to white — floor, desks and
  // robots alike — so the total has to come down a long way, not a little.
  it('brings the total light well below the neon scene’s, so mid-tones survive', () => {
    const total = (r: { ambient: number; dir: number; fill: number; hemisphere: number }) =>
      r.ambient + r.dir + r.fill + r.hemisphere;
    const theirs = total({
      ambient: lightTheme.ambientIntensity,
      dir: lightTheme.dirIntensity,
      fill: lightTheme.fillIntensity,
      hemisphere: lightTheme.hemisphereIntensity,
    });
    expect(total(rig)).toBeLessThan(theirs * 0.5);
  });

  it('keeps every light on', () => {
    for (const value of [rig.ambient, rig.dir, rig.fill, rig.hemisphere]) {
      expect(value).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The robot's clay body
// ---------------------------------------------------------------------------

// Every shipped palette and the clay it needs. A `Record<ThemeName, …>`, so adding a theme is a compile
// error here until someone decides which body its furniture calls for — the same trap as
// `sceneThemes.ts`'s own table, in a file that is easy to forget.
const EXPECTED_CLAY: Record<ThemeName, ClayTone> = {
  'command-center': 'standard',
  cyberpunk: 'standard',
  dracula: 'standard',
  solarized: 'standard',
  nord: 'standard',
  monokai: 'standard',
  warm: 'deep',
  light: 'deep',
  blonde: 'deep',
  'windows-xp': 'deep',
};

/** Gamma-space luma of a `#rrggbb` colour, 0..1 — enough to say which of two paints is darker. */
const luma = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG relative luminance of a `#rrggbb` colour — written out here, apart from the code under test. */
const relativeLuminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The palettes that call for the deep clay, and the three surfaces a robot sits against in each. */
const brightSurfaces = () =>
  (Object.keys(EXPECTED_CLAY) as ThemeName[])
    .filter((name) => EXPECTED_CLAY[name] === 'deep')
    .map((name) => {
      const theme = getScene3DTheme(name);
      return { name, surfaces: [theme.desk, theme.chair, theme.roomFloor] };
    });

describe('clayToneFor', () => {
  it.each(Object.entries(EXPECTED_CLAY))('gives the %s palette the %s clay', (name, tone) => {
    expect(clayToneFor(getScene3DTheme(name as ThemeName))).toBe(tone);
  });

  // The table above is only a compile-time net (`tsc`): under `npm test` alone a theme added to the app
  // but not to the table would simply not be iterated. This makes the omission a failing test.
  it('has an entry for every shipped palette', () => {
    expect(Object.keys(EXPECTED_CLAY).sort()).toEqual(THEMES.map((theme) => theme.name).sort());
  });

  // A robot sits at a desk on a chair: it has to read against THEM. Windows XP is the proof that the sky
  // is the wrong thing to ask — a mid-blue backdrop (so "not light") over white desks, where the standard
  // body rendered white on white.
  it('goes by the furniture, not only the sky', () => {
    const xp = { background: '#4a90d9', desk: '#c4bfa8', chair: '#a8a393', roomFloor: '#588f26' };
    expect(isLightBackground(xp.background)).toBe(false);
    expect(clayToneFor(xp)).toBe('deep');
  });

  it('goes by the sky too: a light backdrop is enough, whatever the furniture', () => {
    const paper = { background: '#f5ede0', desk: '#101020', chair: '#101020', roomFloor: '#101020' };
    expect(clayToneFor(paper)).toBe('deep');
  });

  it('keeps the standard clay when the sky and the furniture are both dark', () => {
    const night = { background: '#0e0c1a', desk: '#1c1c30', chair: '#222238', roomFloor: '#2e2850' };
    expect(clayToneFor(night)).toBe('standard');
  });

  it('falls back to the standard clay for colours it cannot parse', () => {
    expect(clayToneFor({ background: 'navy', desk: 'rgb(9,9,9)', chair: '', roomFloor: '#zzz' })).toBe('standard');
  });
});

describe('CLAY_PAINT', () => {
  // The standard body is a mid blue-grey that a dark scene renders as a lit lavender. Under a bright rig
  // the same paint comes out near white — measured at 1.07:1 against the desk — and the robot vanishes.
  it('paints the deep body darker than the standard one', () => {
    expect(luma(CLAY_PAINT.deep.body)).toBeLessThan(luma(CLAY_PAINT.standard.body) - 0.1);
  });

  it('keeps the shade (antenna, legs) darker than the body, in both tones', () => {
    for (const tone of ['standard', 'deep'] as const) {
      expect(luma(CLAY_PAINT[tone].shade)).toBeLessThan(luma(CLAY_PAINT[tone].body));
    }
  });

  // The floor comes from the calibration, not from taste: painted live onto the running robots and
  // re-measured, `#33405e` (2.30:1 against the warm desk, the worst surface) left Windows XP's robot at
  // 2.35:1 in the render, while the shipped `#2a354f` (2.72:1) held about 3:1 or better on every bright palette.
  const MIN_PAINT_CONTRAST = 2.5;

  it('keeps the deep body at 2.5:1 or better against the desk, chair and room floor of every palette that uses it', () => {
    const palettes = brightSurfaces();
    expect(palettes.length).toBeGreaterThan(0);
    for (const { surfaces } of palettes) {
      for (const surface of surfaces) {
        expect(contrast(CLAY_PAINT.deep.body, surface)).toBeGreaterThanOrEqual(MIN_PAINT_CONTRAST);
      }
    }
  });

  // The defect this exists to prevent: on every bright palette the standard body is within 1.5:1 of
  // something the robot sits against (1.12:1 on Windows XP's chair), and the bright rig then lifts it to
  // near white — 1.0-1.2:1 in the render.
  it('would not do on a bright palette: the standard body is under 1.5:1 against its furniture', () => {
    for (const { name, surfaces } of brightSurfaces()) {
      const worst = Math.min(...surfaces.map((surface) => contrast(CLAY_PAINT.standard.body, surface)));
      expect(worst, name).toBeLessThan(1.5);
    }
  });
});

// ---------------------------------------------------------------------------
// The robot's livery paint (arms and chest band)
// ---------------------------------------------------------------------------

describe('liveryPaint', () => {
  const hsl = (hex: string) => rgbToHsl(parseHex(hex)!);
  /** Smallest angle between two hues, in degrees. */
  const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

  it.each(PALETTE)('leaves %s exactly as it is on a dark palette: neon on dark is right', (hex) => {
    expect(liveryPaint(hex, 'standard')).toBe(hex);
  });

  describe('on a bright palette (the deep tone)', () => {
    // The defect: the neon session colours render as pale ice on a bright rig — measured at 1.05-1.21:1
    // against the furniture, 8.7 CIELAB units from the floor on Windows XP — and the colour is the one
    // thing that tells one CLI from another.
    it.each(PALETTE)('keeps the hue of %s: the colour is how a CLI is told apart', (hex) => {
      expect(hueGap(hsl(liveryPaint(hex, 'deep'))[0], hsl(hex)[0])).toBeLessThanOrEqual(4);
    });

    it.each(PALETTE)('paints %s saturated', (hex) => {
      expect(hsl(liveryPaint(hex, 'deep'))[1]).toBeGreaterThanOrEqual(DEEP_LIVERY.minSaturation - 0.02);
    });

    it.each(PALETTE)('paints %s no lighter than the ceiling, and never lighter than it was', (hex) => {
      const lightness = hsl(liveryPaint(hex, 'deep'))[2];
      expect(lightness).toBeLessThanOrEqual(DEEP_LIVERY.maxLightness + 0.02);
      expect(lightness).toBeLessThanOrEqual(hsl(hex)[2] + 0.02);
    });

    it('is idempotent: painting a deep colour again changes nothing', () => {
      for (const hex of PALETTE) {
        const once = liveryPaint(hex, 'deep');
        expect(liveryPaint(once, 'deep')).toBe(once);
      }
    });

    it('would not have: most neon colours sit above the lightness ceiling', () => {
      const tooLight = PALETTE.filter((hex) => hsl(hex)[2] > DEEP_LIVERY.maxLightness + 0.02);
      expect(tooLight.length).toBeGreaterThanOrEqual(12);
    });

    it('hands back a colour it cannot parse untouched', () => {
      expect(liveryPaint('teal', 'deep')).toBe('teal');
      expect(liveryPaint('', 'deep')).toBe('');
    });

    // The saturation floor lifts a pale colour to a real one — but a grey has no hue to keep, and must stay grey
    // (a custom accentColor can be any string: white or grey would otherwise come out red or blue).
    it.each(['#ffffff', '#808080', '#7f7f80', '#fffffe', '#c0c0c0', '#000000'])('leaves the grey %s grey', (hex) => {
      const [r, g, b] = parseHex(liveryPaint(hex, 'deep'))!;
      expect(Math.max(r, g, b) - Math.min(r, g, b), hex).toBeLessThanOrEqual(3);
      expect(hsl(liveryPaint(hex, 'deep'))[2], hex).toBeLessThanOrEqual(DEEP_LIVERY.maxLightness + 0.02);
    });

    // Codex's green (#10a37f, saturation 0.82) is the one robot colour in play that the floor changes:
    // the palette colours are all above it, so only a colour from outside the palette exercises it.
    it.each(['#10a37f', '#aa66ff', '#5b8a72'])('lifts the weakly saturated %s to the floor, keeping its hue', (hex) => {
      const [h, s] = hsl(liveryPaint(hex, 'deep'));
      expect(s).toBeGreaterThanOrEqual(DEEP_LIVERY.minSaturation - 0.02);
      expect(hueGap(h, hsl(hex)[0])).toBeLessThanOrEqual(4);
    });

    it('does lift #10a37f: it sits below the floor to begin with', () => {
      expect(hsl('#10a37f')[1]).toBeLessThan(DEEP_LIVERY.minSaturation);
    });
  });
});
