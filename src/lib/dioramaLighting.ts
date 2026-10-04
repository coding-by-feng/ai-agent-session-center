/**
 * The diorama style's light balance, derived from the active theme's own lighting numbers.
 *
 * The neon scene is lit by a strong key light (hard shadows) plus two coloured point lights that wash
 * the room. A tabletop model wants a gentle key light so shadows stay soft, a sky light filling them
 * in, and the neon washes turned down. Scaling the THEME's numbers (rather than hard-coding new ones)
 * keeps every palette recognisably itself — a dark theme stays dark, a light one stays light.
 *
 * A bright palette needs a lighter hand: it is already lit hard to look bright, and adding the dark
 * palettes' sky-light boost on top blows the floor out to flat white and loses every edge of the
 * furniture (the same wash-out `sceneThemes.ts` documents for the XP theme).
 *
 * Pure, so the balance is testable without a renderer.
 */
import type { Scene3DTheme } from './sceneThemes';

/** Multipliers against the theme's own values, for dark and for bright palettes. */
export const DIORAMA_LIGHT = {
  dark: { ambient: 1.1, dir: 0.55, fill: 1, hemisphere: 1.5, point: 0.4 },
  // A bright palette's numbers are tuned so DARK objects come out right under a bright rig; a matte,
  // mid-toned diorama under the same rig clips to white. Measured in a real render: ~0.4 of the
  // palette's light keeps the floor light grey and a robot a readable mid-tone.
  light: { ambient: 0.45, dir: 0.3, fill: 0.4, hemisphere: 0.45, point: 0.4 },
} as const;

/** Background brighter than this (0..1) makes a palette "light". A mid-blue sky is not. */
const LIGHT_BACKGROUND = 0.6;

/**
 * The luma (0..1) of a hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; alpha ignored), or null for
 * anything else — a colour name, `rgb(…)`, junk.
 */
function hexLuma(hex: string): number | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return null;
  const body = match[1].length <= 4 ? [...match[1]].map((c) => c + c).join('') : match[1];
  const digits = body.slice(0, 6);
  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Is this hex colour bright? Anything unparseable counts as dark: the palettes all use `#rrggbb`, and a
 * wrong guess that way only leaves the diorama on the (brighter-lit) dark rig, never a black scene.
 */
export function isLightBackground(hex: string): boolean {
  const luma = hexLuma(hex);
  return luma !== null && luma > LIGHT_BACKGROUND;
}

// ---------------------------------------------------------------------------
// The robot's clay body
// ---------------------------------------------------------------------------

/** Which clay paints the diorama's robots: the standard mid blue-grey, or a deeper slate for bright scenes. */
export type ClayTone = 'standard' | 'deep';

/**
 * The robot's body (head, torso, feet) and its shade (antenna, legs), for each tone.
 *
 * The standard body reads as a lit lavender against a dark palette, but a bright palette's rig lifts the
 * same paint to near white: measured in a real render, the robot sat at 1.0-1.2:1 against the pixels round
 * it on `light`, `warm`, `blonde` and `windows-xp`, and disappeared into its own furniture. The deep body
 * is the first step of a measured ladder (live-recoloured robots, same scene, four bright palettes) whose
 * head holds about 3:1 or better against those pixels on every one of them; the step above it (`#33405e`)
 * left Windows XP at 2.35:1. It renders as a mid-blue, not as black.
 */
export const CLAY_PAINT: Readonly<Record<ClayTone, { readonly body: string; readonly shade: string }>> = {
  standard: { body: '#9fadcb', shade: '#74839f' },
  deep: { body: '#2a354f', shade: '#1d263a' },
};

/** Furniture brighter than this on average (0..1) is "bright". The palettes sit at 0.07–0.23 or 0.60–0.65. */
const BRIGHT_FURNITURE = 0.4;

/**
 * The clay a palette needs. A robot sits at a desk on a chair in a room, so it has to read against THEM —
 * the sky is only half the answer: Windows XP has a mid-blue sky (not "light") over white desks, and the
 * standard body rendered white on white there. So it is the deep clay when the backdrop is light OR the
 * desk, chair and room floor are bright on average; anything unparseable counts as dark.
 */
export function clayToneFor(theme: Pick<Scene3DTheme, 'background' | 'desk' | 'chair' | 'roomFloor'>): ClayTone {
  if (isLightBackground(theme.background)) return 'deep';
  const surfaces = [theme.desk, theme.chair, theme.roomFloor].map((hex) => hexLuma(hex) ?? 0);
  const mean = surfaces.reduce((sum, luma) => sum + luma, 0) / surfaces.length;
  return mean > BRIGHT_FURNITURE ? 'deep' : 'standard';
}

/** The Canvas's tone-mapping exposure — what the neon scene has always rendered with. */
export const BASE_EXPOSURE = 1.2;
/** The diorama's exposure on a light palette, as a share of the base. */
const LIGHT_EXPOSURE_SCALE = 0.85;

/**
 * The tone-mapping exposure for a style on a palette. The neon scene is untouched. The diorama keeps
 * the base on a dark palette and eases it off on a light one — the tone mapper brightens by exposure,
 * and a palette that is near white already has nowhere left to go but a flat white floor.
 */
export function sceneExposure(
  style: 'diorama' | 'cyberdrome',
  theme: Pick<Scene3DTheme, 'background'>,
): number {
  if (style !== 'diorama') return BASE_EXPOSURE;
  return isLightBackground(theme.background) ? BASE_EXPOSURE * LIGHT_EXPOSURE_SCALE : BASE_EXPOSURE;
}

export interface DioramaRig {
  ambient: number;
  dir: number;
  fill: number;
  hemisphere: number;
  /** Applied to the coloured point lights (the room lights and the two scene-wide washes). */
  pointScale: number;
}

export function dioramaLighting(
  theme: Pick<Scene3DTheme, 'background' | 'ambientIntensity' | 'dirIntensity' | 'fillIntensity' | 'hemisphereIntensity'>,
): DioramaRig {
  const k = isLightBackground(theme.background) ? DIORAMA_LIGHT.light : DIORAMA_LIGHT.dark;
  return {
    ambient: theme.ambientIntensity * k.ambient,
    dir: theme.dirIntensity * k.dir,
    fill: theme.fillIntensity * k.fill,
    hemisphere: theme.hemisphereIntensity * k.hemisphere,
    pointScale: k.point,
  };
}
