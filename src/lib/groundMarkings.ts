/**
 * Painted ground markings for the diorama scene style — pure layout, no rendering.
 *
 * Three kinds, all flat rectangles lying on the floor:
 *
 *  - lanes: dashed lines down the middle of the corridors between room cells (the road the robots
 *    walk between rooms), including a ring road around the whole block of rooms;
 *  - bays: a thin outline around every seat, the way a car park marks its spaces;
 *  - thresholds: a band across each doorway, in the colour of the room it leads into, the way a
 *    loading dock marks its door.
 *
 * Everything is a `MarkingStrip` so one instanced mesh can draw the lot in a single call.
 *
 * No imports but the grid math: this runs in a unit test without Three.js, and the strips are
 * recomputed only when the layout changes — never per frame.
 */
import { ROOM_CELL, ROOM_COLS, ROOM_GAP, ROOM_HALF, computeColumnX, computeRowZ } from './roomGrid';

export interface MarkingStrip {
  kind: 'lane' | 'bay' | 'threshold';
  /** Which of the theme's two room accents paints it — thresholds only. */
  accent?: 0 | 1;
  /** Centre on the ground plane. */
  x: number;
  z: number;
  /** Extent along the strip's own X axis. */
  length: number;
  /** Extent across it. */
  width: number;
  /** Rotation about Y (three.js: the local X axis ends up pointing to (cos, 0, -sin)). */
  rotY: number;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export const LANE_DASH = 0.9;
export const LANE_GAP = 0.7;
export const LANE_WIDTH = 0.12;
/** A dash this close to the middle of a crossing lane would stack on top of that lane's own dash. */
const CROSSING_CLEARANCE = ROOM_GAP / 2 + LANE_DASH / 2;

/** Dash centres along [from, to], the pattern centred in the stretch. */
function dashCentres(from: number, to: number): number[] {
  const span = to - from;
  const count = Math.max(1, Math.floor((span + LANE_GAP) / (LANE_DASH + LANE_GAP)));
  const patternLength = count * LANE_DASH + (count - 1) * LANE_GAP;
  const start = from + (span - patternLength) / 2 + LANE_DASH / 2;
  return Array.from({ length: count }, (_, i) => start + i * (LANE_DASH + LANE_GAP));
}

/**
 * Dashed lane lines for a block of rooms, given only their grid slots.
 *
 * A lane runs down the middle of each 2-unit gap between room cells — one on each side of every
 * column and row the rooms occupy, so the outermost ones make a ring road. Rooms sit 1 unit inside
 * their cell, so a lane never touches a room floor.
 */
export function buildLaneStrips(rooms: ReadonlyArray<{ index: number }>): MarkingStrip[] {
  if (rooms.length === 0) return [];

  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const { index } of rooms) {
    const col = index % ROOM_COLS;
    const row = Math.floor(index / ROOM_COLS);
    minCol = Math.min(minCol, col);
    maxCol = Math.max(maxCol, col);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }

  // Lane lines sit on the right/bottom edge of every column/row, plus the left/top edge of the first.
  const laneXs: number[] = [];
  for (let col = minCol - 1; col <= maxCol; col++) laneXs.push(computeColumnX(col) + ROOM_CELL / 2);
  const laneZs: number[] = [];
  for (let row = minRow - 1; row <= maxRow; row++) laneZs.push(computeRowZ(row) + ROOM_CELL / 2);

  const xFrom = laneXs[0];
  const xTo = laneXs[laneXs.length - 1];
  const zFrom = laneZs[0];
  const zTo = laneZs[laneZs.length - 1];

  const strips: MarkingStrip[] = [];

  // Lanes running along X (one per z line), clear of every crossing vertical lane.
  for (const z of laneZs) {
    for (const x of dashCentres(xFrom, xTo)) {
      if (laneXs.some((lx) => Math.abs(x - lx) < CROSSING_CLEARANCE)) continue;
      strips.push({ kind: 'lane', x, z, length: LANE_DASH, width: LANE_WIDTH, rotY: 0 });
    }
  }
  // Lanes running along Z (one per x line), clear of every crossing horizontal lane.
  for (const x of laneXs) {
    for (const z of dashCentres(zFrom, zTo)) {
      if (laneZs.some((lz) => Math.abs(z - lz) < CROSSING_CLEARANCE)) continue;
      strips.push({ kind: 'lane', x, z, length: LANE_DASH, width: LANE_WIDTH, rotY: Math.PI / 2 });
    }
  }
  return strips;
}

// ---------------------------------------------------------------------------
// Bays
// ---------------------------------------------------------------------------

/** The outline's size. Desks in a row are 1.2 apart, so the width has to stay under that. */
export const BAY_LENGTH = 1.1;
export const BAY_WIDTH = 0.95;
export const BAY_BORDER = 0.045;
/** The outline is nudged toward the desk, so the chair sits a little behind its centre. */
const BAY_NUDGE = 0.1;

/**
 * An outline around each seat: two long sides running the way the seat faces and two short ends
 * between them (so the corners are not painted twice, which would show through a translucent paint).
 * `faceRot` is the seat's facing, as in a `Workstation`: it faces (sin, cos) toward its desk.
 */
export function buildBayStrips(
  seats: ReadonlyArray<{ x: number; z: number; faceRot: number }>,
): MarkingStrip[] {
  const strips: MarkingStrip[] = [];
  const side = BAY_WIDTH / 2 - BAY_BORDER / 2;
  const end = BAY_LENGTH / 2 - BAY_BORDER / 2;

  for (const { x, z, faceRot } of seats) {
    const fx = Math.sin(faceRot); // the way the seat faces
    const fz = Math.cos(faceRot);
    const rx = Math.cos(faceRot); // across it
    const rz = -Math.sin(faceRot);
    const cx = x + fx * BAY_NUDGE;
    const cz = z + fz * BAY_NUDGE;

    for (const s of [-1, 1]) {
      strips.push({
        kind: 'bay',
        x: cx + rx * side * s,
        z: cz + rz * side * s,
        length: BAY_LENGTH,
        width: BAY_BORDER,
        rotY: faceRot - Math.PI / 2, // local X -> the facing direction
      });
    }
    for (const s of [-1, 1]) {
      strips.push({
        kind: 'bay',
        x: cx + fx * end * s,
        z: cz + fz * end * s,
        length: BAY_WIDTH - 2 * BAY_BORDER,
        width: BAY_BORDER,
        rotY: faceRot, // local X -> across the seat
      });
    }
  }
  return strips;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** How deep the band is, across the wall line: half in the room, half in the corridor. Slim: a line, not a mat. */
export const THRESHOLD_WIDTH = 0.36;

/**
 * A band across the doorway in each room's north and south walls, exactly as wide as the gap so it
 * never runs under a wall, painted in the room's accent. A room's doorways are centred on it, at
 * `ROOM_HALF` either side: where the lanes and the seat outlines are not.
 */
export function buildThresholdStrips(
  rooms: ReadonlyArray<{ center: readonly [number, number, number]; stripColor: 0 | 1 }>,
  doorGap: number,
): MarkingStrip[] {
  const strips: MarkingStrip[] = [];
  for (const { center, stripColor } of rooms) {
    for (const side of [-1, 1]) {
      strips.push({
        kind: 'threshold',
        accent: stripColor,
        x: center[0],
        z: center[2] + side * ROOM_HALF,
        length: doorGap,
        width: THRESHOLD_WIDTH,
        rotY: 0,
      });
    }
  }
  return strips;
}
