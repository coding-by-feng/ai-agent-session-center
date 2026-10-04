/**
 * The two looks the 3D scene can wear.
 *
 *  - `diorama`    — the default: a soft, matte tabletop model. Rounded toy-like furniture and robots,
 *                   light shadows, ground markings (corridor lanes, a bay outline per seat) and
 *                   strategy-game selection effects (corner brackets, name chip, attention pin).
 *  - `cyberdrome` — the original neon look: metal and emissive strips, a glowing grid, floating data
 *                   particles. Kept as it was, one click away.
 *
 * Colours are not part of the style — they still come from the active theme's 3D palette
 * (`sceneThemes.ts`). The style decides geometry, materials, lighting balance and decals.
 *
 * Import-free on purpose: `settingsStore` reads the type and the default from here, and it is loaded
 * on every boot — it must never drag Three.js in.
 */

export const SCENE_STYLES = ['diorama', 'cyberdrome'] as const;
export type SceneStyle = (typeof SCENE_STYLES)[number];

export const DEFAULT_SCENE_STYLE: SceneStyle = 'diorama';

/**
 * Whatever is stored or passed in, a style the scene can draw. A value that predates the setting, or
 * that a newer build wrote, must not leave the scene without a look — it reads as the default.
 */
export function resolveSceneStyle(value: unknown): SceneStyle {
  return (SCENE_STYLES as readonly unknown[]).includes(value) ? (value as SceneStyle) : DEFAULT_SCENE_STYLE;
}

/** The other look — what the HUD button switches to. */
export function nextSceneStyle(current: SceneStyle): SceneStyle {
  return current === 'diorama' ? 'cyberdrome' : 'diorama';
}

/** The HUD button's label for a style. */
export function sceneStyleLabel(style: SceneStyle): string {
  return style === 'diorama' ? 'Diorama' : 'Cyberdrome';
}
