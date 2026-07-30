/**
 * Cyberdrome room-grid math — pure layout arithmetic, no rendering.
 *
 * Deliberately its own module with NO imports. These helpers used to live in
 * `cyberdromeScene.ts`, which does `import * as THREE from 'three'` — so
 * SceneOverlay (a plain DOM overlay, reached eagerly from LiveView) dragged all
 * ~1.2 MB of Three.js into the app's boot path just to compute a camera target
 * from a room index.
 *
 * Keep this file dependency-free. `cyberdromeScene.ts` re-exports everything
 * here so 3D code keeps a single import site.
 */

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

export const ROOM_SIZE = 8;                     // internal room dimension (fits 10 desks)
export const ROOM_GAP = 2;                      // corridor width between rooms
export const ROOM_CELL = ROOM_SIZE + ROOM_GAP;  // 10
export const ROOM_HALF = ROOM_SIZE / 2;         // 4
export const ROOM_COLS = 4;                     // max rooms per row before wrapping

// ---------------------------------------------------------------------------
// Room placement
// ---------------------------------------------------------------------------

/** Compute the world-space center of a room by its grid index. */
export function computeRoomCenter(roomIndex: number): [number, number, number] {
  const col = roomIndex % ROOM_COLS;
  const row = Math.floor(roomIndex / ROOM_COLS);
  // Center the columns around x=0
  const x = (col - (ROOM_COLS - 1) / 2) * ROOM_CELL;
  const z = row * ROOM_CELL;
  return [x, 0, z];
}

// ---------------------------------------------------------------------------
// Camera framing
// ---------------------------------------------------------------------------

const ROOM_VIEW_DISTANCE = 14;
const ROOM_VIEW_HEIGHT = 10;
const ROOM_VIEW_ANGLE = Math.PI / 4; // 45 degrees from south-east

/** Compute camera position + look-at target to view a specific room. */
export function computeRoomCameraTarget(
  roomIndex: number,
): { position: [number, number, number]; lookAt: [number, number, number] } {
  const [cx, , cz] = computeRoomCenter(roomIndex);
  return {
    lookAt: [cx, 1, cz],
    position: [
      cx + Math.sin(ROOM_VIEW_ANGLE) * ROOM_VIEW_DISTANCE,
      ROOM_VIEW_HEIGHT,
      cz + Math.cos(ROOM_VIEW_ANGLE) * ROOM_VIEW_DISTANCE,
    ],
  };
}
