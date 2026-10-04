/**
 * Set dressing for the diorama scene style — pure layout, no rendering.
 *
 * Where the doorway posts and the plants go. Kept free of Three.js (it imports only the grid and colour
 * maths) so every clearance rule is a unit test: the scene renders whatever this returns.
 */
import { deltaE } from './colorMath';
import { ROOM_HALF } from './roomGrid';

export interface DoorPost {
  x: number;
  z: number;
  /** Which of the theme's two room accents paints it. */
  accent: 0 | 1;
}

/**
 * The posts that frame each doorway: one at each end of the gap in a room's north wall and in its
 * south wall, four per room, at the wall line. A post at each end and nothing across the top — a lintel
 * at robot height would cut through the robots walking the doorway.
 */
export function buildDoorPosts(
  rooms: ReadonlyArray<{ center: readonly [number, number, number]; stripColor: 0 | 1 }>,
  doorGap: number,
): DoorPost[] {
  const posts: DoorPost[] = [];
  for (const { center, stripColor } of rooms) {
    for (const wall of [-1, 1]) {
      for (const end of [-1, 1]) {
        posts.push({ x: center[0] + (end * doorGap) / 2, z: center[2] + wall * ROOM_HALF, accent: stripColor });
      }
    }
  }
  return posts;
}

// ---------------------------------------------------------------------------
// Shared dimensions — the scene draws from these, the layout below clears them
// ---------------------------------------------------------------------------

/** The diorama's walls: 0.7 high (not the neon look's 2.0 — see `CyberdromeEnvironment`) and 0.14 thick. */
export const DIORAMA_WALL_H = 0.7;
export const DIORAMA_WALL_T = 0.14;

/**
 * Furniture sizes the plant clearances are measured against. Each is a copy of what a component draws —
 * `dioramaProps.test.ts` reads that component's source and fails if the two drift apart.
 */
/** Half of the desk top (1.5 x 0.65 in `DeskWithChair`): along its length, and across it. */
export const DESK_HALF_LONG = 0.75;
export const DESK_HALF_SHORT = 0.325;
/** Half of the chair seat (0.36 square). */
export const SEAT_HALF = 0.18;
/** The lounge: its pad is this many units square, its four tables this far apart and this big, its counter 5.1 wide. */
export const LOUNGE_SIZE = 10;
export const LOUNGE_TABLE_SPACING = 3;
export const LOUNGE_TABLE_RADIUS = 0.4;
export const COUNTER_HALF_LENGTH = 2.55;
/** The counter stands this far in from the lounge's north edge. */
export const COUNTER_INSET = 0.4;

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

export interface PlantSpot {
  x: number;
  z: number;
  /** Between `PLANT_SCALE.min` and `.max`: no two plants in a row are the same height. */
  scale: number;
  kind: 'room' | 'lounge';
}

/** The sizes a plant is drawn at (scale 1): a terracotta pot, a short trunk, a ball of leaves. */
export const PLANT_PART = { potHeight: 0.26, trunkHeight: 0.18, leafRadius: 0.26 } as const;
export const PLANT_SCALE = { min: 0.9, max: 1.15 } as const;
/** The radius the clearances assume for a plant at scale 1: at least the crown, which is its widest part. */
export const PLANT_RADIUS = 0.3;

/**
 * A plant's height at a scale: pot, trunk, then the crown (centred 0.6 of its radius above the trunk's top).
 * Kept under a metre at the largest scale, and under 0.3 above the walls, so a planter beside the NEAR
 * doorway cannot hide the last seat row from the default camera.
 */
export function plantHeight(scale: number): number {
  return (PLANT_PART.potHeight + PLANT_PART.trunkHeight + 1.6 * PLANT_PART.leafRadius) * scale;
}

/**
 * Foliage colours in order of preference: a soft green, then a deeper one, then blossom pink and autumn
 * gold for a lawn that is green itself (Windows XP, where green foliage on the green room floor is the
 * camouflage bug again).
 */
export const FOLIAGE_CANDIDATES = ['#6fbf73', '#2f8f4e', '#f2a7c3', '#f0b24a'] as const;

/** A leaf colour must be at least this many CIELAB units from every floor it can stand on (clearly visible at crown size). */
export const FOLIAGE_MIN_DELTA_E = 35;

/**
 * The foliage colour for a palette: the first candidate that clears `FOLIAGE_MIN_DELTA_E` against all three
 * floors a plant can stand on — the room floor, the lounge pad, and (beside a doorway, just outside the
 * wall) the main floor — or the one that comes closest.
 */
export function plantFoliage(floors: { floor: string; roomFloor: string; coffeeFloor: string }): string {
  let best: string = FOLIAGE_CANDIDATES[0];
  let bestGap = -1;
  for (const candidate of FOLIAGE_CANDIDATES) {
    const gap = Math.min(deltaE(candidate, floors.floor), deltaE(candidate, floors.roomFloor), deltaE(candidate, floors.coffeeFloor));
    if (gap >= FOLIAGE_MIN_DELTA_E) return candidate;
    if (gap > bestGap) {
      best = candidate;
      bestGap = gap;
    }
  }
  return best;
}

/** Clear air a plant keeps from a desk, a chair, and a doorway post. */
const DESK_MARGIN = 0.15;
const SEAT_MARGIN = 0.1;
const POST_CLEARANCE = 1.5;
/** Plants stand this far inside a wall at the most. */
const WALL_MARGIN = 0.45;
/**
 * Where a room's plants stand: flanking each doorway, just inside the wall. Desks hug the east and west
 * walls and run to z = ±3.15, leaving under a unit between the last desk and the wall — too little for a
 * plant — so the planters go beside the door instead, clear of the desk columns (x = ±3.0) and of the
 * robots' path down the middle.
 */
const ROOM_PLANTER = { x: 2.3, z: 3.5 };
const LOUNGE_CORNER = LOUNGE_SIZE / 2 - 0.7;

/** Deterministic 0..1 from an index — the same layout always grows the same plants. */
const jitter = (i: number): number => (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
const scaleFor = (i: number): number => PLANT_SCALE.min + (PLANT_SCALE.max - PLANT_SCALE.min) * jitter(i);

/**
 * Where the plants stand: a pair flanking each doorway of every room (four per room) and one in each
 * corner of every lounge. Each candidate is checked against the furniture (room desks, every chair,
 * doorway posts; in a lounge also its tables and counter) and DROPPED if it would touch any — a changed
 * layout loses a plant rather than putting one through a desk. Only the room desks are passed in: the
 * corridor desks (for robots with no room) stand in the corridors, never near a doorway or a lounge corner.
 */
export function buildPlantSpots(layout: {
  rooms: ReadonlyArray<{ center: readonly [number, number, number]; stripColor: 0 | 1 }>;
  desks: ReadonlyArray<{ x: number; z: number; rotation: number }>;
  seats: ReadonlyArray<{ x: number; z: number }>;
  areas: ReadonlyArray<{ center: readonly [number, number, number] }>;
  doorGap: number;
}): PlantSpot[] {
  const { rooms, desks, seats, areas, doorGap } = layout;
  const posts = buildDoorPosts(rooms, doorGap);
  const spots: PlantSpot[] = [];
  let index = 0;

  /** Clear of every desk, chair and doorway post — wherever the plant stands. */
  const clearOfFurniture = (x: number, z: number, radius: number): boolean => {
    for (const d of desks) {
      const hx = Math.abs(Math.cos(d.rotation)) * DESK_HALF_LONG + Math.abs(Math.sin(d.rotation)) * DESK_HALF_SHORT;
      const hz = Math.abs(Math.sin(d.rotation)) * DESK_HALF_LONG + Math.abs(Math.cos(d.rotation)) * DESK_HALF_SHORT;
      const gap = Math.hypot(Math.max(0, Math.abs(x - d.x) - hx), Math.max(0, Math.abs(z - d.z) - hz));
      if (gap - radius < DESK_MARGIN) return false;
    }
    for (const q of seats) if (Math.hypot(x - q.x, z - q.z) < radius + SEAT_HALF + SEAT_MARGIN) return false;
    return posts.every((p) => Math.hypot(x - p.x, z - p.z) >= POST_CLEARANCE);
  };

  for (const { center } of rooms) {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const scale = scaleFor(index++);
        const x = center[0] + sx * ROOM_PLANTER.x;
        const z = center[2] + sz * ROOM_PLANTER.z;
        const inside = Math.abs(x - center[0]) <= ROOM_HALF - WALL_MARGIN && Math.abs(z - center[2]) <= ROOM_HALF - WALL_MARGIN;
        if (inside && clearOfFurniture(x, z, PLANT_RADIUS * scale)) spots.push({ x, z, scale, kind: 'room' });
      }
    }
  }

  for (const { center } of areas) {
    const [cx, , cz] = center;
    const tables = [-0.5, 0.5].flatMap((col) => [-0.5, 0.5].map((row) => [cx + col * LOUNGE_TABLE_SPACING, cz + row * LOUNGE_TABLE_SPACING] as const));
    const counterZ = cz - LOUNGE_SIZE / 2 + COUNTER_INSET;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const scale = scaleFor(index++);
        const radius = PLANT_RADIUS * scale;
        const x = cx + sx * LOUNGE_CORNER;
        const z = cz + sz * LOUNGE_CORNER;
        const offTables = tables.every(([tx, tz]) => Math.hypot(x - tx, z - tz) >= LOUNGE_TABLE_RADIUS + radius + 0.3);
        const offCounter = Math.abs(z - counterZ) >= 0.6 || Math.abs(x - cx) >= COUNTER_HALF_LENGTH + radius + 0.2;
        if (offTables && offCounter && clearOfFurniture(x, z, radius)) spots.push({ x, z, scale, kind: 'lounge' });
      }
    }
  }
  return spots;
}
