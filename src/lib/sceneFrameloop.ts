/**
 * Render-loop policy for the 3D cyberdrome.
 *
 * The Canvas used to run react-three-fiber's default `frameloop="always"`: a
 * 60 fps rAF loop with shadows, PCF soft shadow maps, antialiasing and ACES tone
 * mapping, driven by eight `useFrame` sites (robots, models, labels, dialogue,
 * particles, subagent links, environment, camera) multiplied by the session
 * count. That ran whether or not anything on screen had changed — and Electron
 * ships with `MacWebContentsOcclusion` disabled, so burying the window behind
 * another app does NOT pause rAF the way it would in a browser tab. A dashboard
 * left open in the background therefore rendered a full 3D scene forever.
 *
 * Policy:
 *   hidden (minimised / occluded / another Space) → `never`  — stop entirely
 *   visible but unfocused                        → `demand` — pumped at UNFOCUSED_FPS
 *   visible and focused                          → `always` — full 60 fps
 *
 * `demand` is not "frozen": each pumped `invalidate()` renders one frame, and
 * `useFrame` receives the real elapsed delta, so animation still advances — just
 * coarser. That matters because the robots' walk cycles and the particle drift
 * are continuous animations, so a plain `demand` with no pump (the usual
 * "only render on state change" recipe) would freeze the scene mid-stride.
 *
 * Dependency-free by design: imported by DOM-layer code, so it must never pull
 * in Three.js (see the "never import a Three.js-touching module from 2D code"
 * invariant in CLAUDE.md).
 */

export type FrameloopMode = 'always' | 'demand' | 'never';

/** Frame rate pumped while the window is visible but not focused. */
export const UNFOCUSED_FPS = 10;

/** Interval between pumped frames, in ms. */
export const UNFOCUSED_FRAME_MS = Math.round(1000 / UNFOCUSED_FPS);

export function resolveFrameloop(visible: boolean, focused: boolean): FrameloopMode {
  if (!visible) return 'never';
  return focused ? 'always' : 'demand';
}

/** True when the scene needs an external invalidate pump to keep animating. */
export function needsFramePump(visible: boolean, focused: boolean): boolean {
  return resolveFrameloop(visible, focused) === 'demand';
}
