/**
 * Cyberdrome scene layout — dynamic room grid system.
 * Rooms are placed in a grid. Adding/removing rooms reshapes the map.
 */
import * as THREE from 'three';
import type { Room } from '@/stores/roomStore';

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

export const ROOM_SIZE = 8;         // internal room dimension (fits 10 desks)
export const ROOM_GAP = 2;          // corridor width between rooms
export const ROOM_CELL = ROOM_SIZE + ROOM_GAP; // 10
export const ROOM_HALF = ROOM_SIZE / 2; // 4
export const ROOM_COLS = 4;         // max rooms per row before wrapping
export const WALL_H = 2.0;
export const WALL_T = 0.08;
export const DOOR_GAP = 1.5;        // doorway width

// ---------------------------------------------------------------------------
// Room Config (computed from groups)
// ---------------------------------------------------------------------------

export interface RoomBound {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface RoomConfig {
  index: number;
  roomId: string;
  name: string;
  center: [number, number, number];
  bounds: RoomBound;
  stripColor: 0 | 1;
}

export interface DeskDef {
  x: number;
  z: number;
  rotation: number;
  zone: number;
}

export interface WallRect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Workstation {
  idx: number;
  zone: number;
  seatPos: THREE.Vector3;
  faceRot: number;
  occupantId: string | null;
}

export interface CasualArea {
  type: 'coffee';
  center: [number, number, number];
  bounds: RoomBound;
  stations: { pos: THREE.Vector3; faceRot: number }[];
}

export interface DoorWaypoint {
  roomIndex: number;
  side: 'south' | 'north';
  outside: THREE.Vector3;  // outside the wall, 1 unit past
  inside: THREE.Vector3;   // inside the room, 1 unit past
}

export function buildDoorWaypoints(rooms: RoomConfig[]): DoorWaypoint[] {
  const doors: DoorWaypoint[] = [];
  for (const room of rooms) {
    const [cx] = room.center;
    // South door
    doors.push({
      roomIndex: room.index,
      side: 'south',
      outside: new THREE.Vector3(cx, 0, room.bounds.maxZ + 1.0),
      inside: new THREE.Vector3(cx, 0, room.bounds.maxZ - 1.0),
    });
    // North door
    doors.push({
      roomIndex: room.index,
      side: 'north',
      outside: new THREE.Vector3(cx, 0, room.bounds.minZ - 1.0),
      inside: new THREE.Vector3(cx, 0, room.bounds.minZ + 1.0),
    });
  }
  return doors;
}

/**
 * Compute waypoints for navigating between zones through doors.
 * Returns ordered array of intermediate points to visit.
 */
export function computePathWaypoints(
  fromX: number,
  fromZ: number,
  target: THREE.Vector3,
  fromZone: number,
  targetZone: number,
  doors: DoorWaypoint[],
): THREE.Vector3[] {
  // Same zone or both in corridor/casual areas → direct path
  if (fromZone === targetZone) return [target];
  if (fromZone < 0 && targetZone < 0) return [target];

  const result: THREE.Vector3[] = [];

  // Pick the nearest door for a given room relative to a world position
  function nearestDoor(roomIdx: number, wx: number, wz: number): DoorWaypoint | undefined {
    const roomDoors = doors.filter(d => d.roomIndex === roomIdx);
    if (roomDoors.length === 0) return undefined;
    let best = roomDoors[0];
    let bestDist = (best.outside.x - wx) ** 2 + (best.outside.z - wz) ** 2;
    for (let i = 1; i < roomDoors.length; i++) {
      const d = (roomDoors[i].outside.x - wx) ** 2 + (roomDoors[i].outside.z - wz) ** 2;
      if (d < bestDist) { best = roomDoors[i]; bestDist = d; }
    }
    return best;
  }

  // Exiting a room — pick the door closest to the target
  if (fromZone >= 0) {
    const exitDoor = nearestDoor(fromZone, target.x, target.z);
    if (exitDoor) {
      result.push(exitDoor.inside.clone());
      result.push(exitDoor.outside.clone());
    }
  }

  // Entering a room — pick the door closest to where the robot currently is
  if (targetZone >= 0) {
    const enterDoor = nearestDoor(targetZone, fromX, fromZ);
    if (enterDoor) {
      result.push(enterDoor.outside.clone());
      result.push(enterDoor.inside.clone());
    }
  }

  result.push(target);
  return result;
}

// ---------------------------------------------------------------------------
// Dynamic Room Position Computation
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

/** Compute room bounds from grid index. */
export function computeRoomBounds(roomIndex: number): RoomBound {
  const [cx, , cz] = computeRoomCenter(roomIndex);
  return {
    minX: cx - ROOM_HALF,
    maxX: cx + ROOM_HALF,
    minZ: cz - ROOM_HALF,
    maxZ: cz + ROOM_HALF,
  };
}

/** Get label position (above room center). */
export function getRoomCenter(roomIndex: number): [number, number, number] {
  const [cx, , cz] = computeRoomCenter(roomIndex);
  return [cx, 2.5, cz];
}

// ---------------------------------------------------------------------------
// Camera Target for Room Zoom
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

// ---------------------------------------------------------------------------
// Build Room Configs from Groups
// ---------------------------------------------------------------------------

export function computeRoomConfigs(rooms: Room[]): RoomConfig[] {
  return rooms
    .filter((r) => r.roomIndex != null)
    .map((r) => ({
      index: r.roomIndex!,
      roomId: r.id,
      name: r.name,
      center: computeRoomCenter(r.roomIndex!),
      bounds: computeRoomBounds(r.roomIndex!),
      stripColor: (r.roomIndex! % 2 === 0 ? 0 : 1) as 0 | 1,
    }));
}

// ---------------------------------------------------------------------------
// Dynamic Desk Definitions (10 desks per room — 5 rows x 2 facing each other)
// ---------------------------------------------------------------------------

export function buildDynamicDeskDefs(rooms: RoomConfig[]): DeskDef[] {
  const desks: DeskDef[] = [];
  for (const room of rooms) {
    const [cx, , cz] = room.center;
    const ROWS = 5;
    const ROW_SPACING = 1.2;
    const startZ = cz - (ROWS - 1) * ROW_SPACING / 2;
    for (let row = 0; row < ROWS; row++) {
      const z = startZ + row * ROW_SPACING;
      // Left desk against west wall facing right, right desk against east wall facing left
      desks.push({ x: cx - 3.0, z, rotation: Math.PI / 2, zone: room.index });
      desks.push({ x: cx + 3.0, z, rotation: -Math.PI / 2, zone: room.index });
    }
  }
  return desks;
}

// ---------------------------------------------------------------------------
// Dynamic Workstations
// ---------------------------------------------------------------------------

export function buildDynamicWorkstations(rooms: RoomConfig[]): Workstation[] {
  const desks = buildDynamicDeskDefs(rooms);
  return desks.map((def, idx) => {
    const seatX = def.x + 0.65 * Math.sin(def.rotation);
    const seatZ = def.z + 0.65 * Math.cos(def.rotation);
    return {
      idx,
      zone: def.zone,
      seatPos: new THREE.Vector3(seatX, 0, seatZ),
      faceRot: def.rotation + Math.PI,
      occupantId: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Corridor Workstations (for unassigned robots)
// ---------------------------------------------------------------------------

export function buildCorridorWorkstations(
  roomConfigs: RoomConfig[],
  startIdx: number,
): Workstation[] {
  // Dedicated "common area" with 10 desks for unassigned robots (5 rows x 2).
  const desks: { x: number; z: number; rotation: number }[] = [];

  if (roomConfigs.length === 0) {
    // No rooms — place 10 desks in a 5x2 grid south of coffee lounge (gap of 5 units)
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 2; col++) {
        desks.push({
          x: (col - 0.5) * 3,
          z: 3 + row * 1.5,
          rotation: col === 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  } else {
    // Place 10 desks in a dedicated common area south of all rooms.
    const maxRow = Math.max(...roomConfigs.map(r => Math.floor(r.index / ROOM_COLS)));
    const maxCol = Math.min(ROOM_COLS - 1, Math.max(...roomConfigs.map(r => r.index % ROOM_COLS)));
    const minCol = Math.min(...roomConfigs.map(r => r.index % ROOM_COLS));

    const southmostRoomCenter = computeRoomCenter(maxRow * ROOM_COLS);
    const commonAreaZ = southmostRoomCenter[2] + ROOM_HALF + ROOM_GAP + 3;

    const leftCol = computeRoomCenter(minCol);
    const rightCol = computeRoomCenter(maxCol);
    const areaCenterX = (leftCol[0] + rightCol[0]) / 2;

    // 5 rows x 2 desks, facing each other
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 2; col++) {
        desks.push({
          x: areaCenterX + (col - 0.5) * 3,
          z: commonAreaZ + row * 1.5,
          rotation: col === 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  }

  return desks.map((p, i) => {
    const seatX = p.x + 0.65 * Math.sin(p.rotation);
    const seatZ = p.z + 0.65 * Math.cos(p.rotation);
    return {
      idx: startIdx + i,
      zone: -1,
      seatPos: new THREE.Vector3(seatX, 0, seatZ),
      faceRot: p.rotation + Math.PI,
      occupantId: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Dynamic Wall Collision Rects (4 walls per room, each split by doorway)
// ---------------------------------------------------------------------------

export function buildDynamicWallRects(rooms: RoomConfig[]): WallRect[] {
  const rects: WallRect[] = [];
  const dg = DOOR_GAP / 2;

  for (const room of rooms) {
    const b = room.bounds;
    const mx = (b.minX + b.maxX) / 2;
    const ht = 0.25; // wall half-thickness for collision

    // North wall (z = minZ): door in center
    rects.push({ minX: b.minX, maxX: mx - dg, minZ: b.minZ - ht, maxZ: b.minZ + ht });
    rects.push({ minX: mx + dg, maxX: b.maxX, minZ: b.minZ - ht, maxZ: b.minZ + ht });
    // South wall (z = maxZ): door in center
    rects.push({ minX: b.minX, maxX: mx - dg, minZ: b.maxZ - ht, maxZ: b.maxZ + ht });
    rects.push({ minX: mx + dg, maxX: b.maxX, minZ: b.maxZ - ht, maxZ: b.maxZ + ht });
    // West wall (x = minX): solid, no door
    rects.push({ minX: b.minX - ht, maxX: b.minX + ht, minZ: b.minZ, maxZ: b.maxZ });
    // East wall (x = maxX): solid, no door
    rects.push({ minX: b.maxX - ht, maxX: b.maxX + ht, minZ: b.minZ, maxZ: b.maxZ });
  }
  return rects;
}

// ---------------------------------------------------------------------------
// Dynamic Collision Detection
// ---------------------------------------------------------------------------

export function collidesAnyWall(x: number, z: number, rects: WallRect[]): boolean {
  for (const w of rects) {
    if (x + 0.25 > w.minX && x - 0.25 < w.maxX && z + 0.25 > w.minZ && z - 0.25 < w.maxZ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Dynamic Bounds (encompasses all rooms + corridor)
// ---------------------------------------------------------------------------

export function computeSceneBounds(rooms: RoomConfig[]): number {
  if (rooms.length === 0) return 15;
  let maxDist = 10;
  for (const room of rooms) {
    const [cx, , cz] = room.center;
    maxDist = Math.max(
      maxDist,
      Math.abs(cx) + ROOM_HALF + 2,
      Math.abs(cz) + ROOM_HALF + 2,
    );
  }
  // Account for the common area south of rooms
  if (rooms.length > 0) {
    const maxRow = Math.max(...rooms.map(r => Math.floor(r.index / ROOM_COLS)));
    const southmostCenter = computeRoomCenter(maxRow * ROOM_COLS);
    maxDist = Math.max(maxDist, Math.abs(southmostCenter[2]) + ROOM_HALF + ROOM_GAP + 8);
    // Account for casual areas north of rooms
    const minZedge = Math.min(...rooms.map(r => r.bounds.minZ));
    maxDist = Math.max(maxDist, Math.abs(minZedge) + ROOM_GAP + 8);
  }
  return maxDist;
}

// ---------------------------------------------------------------------------
// Dynamic Zone Detection
// ---------------------------------------------------------------------------

/** Returns the roomIndex the position falls within, or -1 for corridor. */
export function getZone(x: number, z: number, rooms: RoomConfig[]): number {
  for (const room of rooms) {
    const b = room.bounds;
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
      return room.index;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Dynamic Target Picking
// ---------------------------------------------------------------------------

/** Pick a random target within a specific room. */
export function pickTargetInRoom(roomIndex: number): THREE.Vector3 {
  const rb = computeRoomBounds(roomIndex);
  const target = new THREE.Vector3();
  target.set(
    rb.minX + 0.8 + Math.random() * (rb.maxX - rb.minX - 1.6),
    0,
    rb.minZ + 0.8 + Math.random() * (rb.maxZ - rb.minZ - 1.6),
  );
  return target;
}

/** Pick a random wander target for ungrouped robots (corridor/open area). */
export function pickCorridorTarget(bound: number): THREE.Vector3 {
  const target = new THREE.Vector3();
  // Wander near origin in the corridor areas
  const range = Math.min(bound, 5);
  target.set(
    (Math.random() - 0.5) * range * 2,
    0,
    (Math.random() - 0.5) * range * 2,
  );
  return target;
}

// ---------------------------------------------------------------------------
// Casual Areas (Coffee Lounge)
// ---------------------------------------------------------------------------

const CASUAL_AREA_SIZE = 10;
const CASUAL_HALF = CASUAL_AREA_SIZE / 2;

/** Build the Coffee Lounge area NORTH of the rooms (above, negative Z side). */
export function buildCasualAreas(roomConfigs: RoomConfig[]): CasualArea[] {
  let baseZ: number;
  let centerX: number;

  if (roomConfigs.length === 0) {
    baseZ = -8;
    centerX = 0;
  } else {
    const minZedge = Math.min(...roomConfigs.map(r => r.bounds.minZ));
    baseZ = minZedge - ROOM_GAP - CASUAL_HALF - 1;

    const minCol = Math.min(...roomConfigs.map(r => r.index % ROOM_COLS));
    const maxCol = Math.min(ROOM_COLS - 1, Math.max(...roomConfigs.map(r => r.index % ROOM_COLS)));
    const leftCol = computeRoomCenter(minCol);
    const rightCol = computeRoomCenter(maxCol);
    centerX = (leftCol[0] + rightCol[0]) / 2;
  }

  const coffeeStations: { pos: THREE.Vector3; faceRot: number }[] = [];
  // 4 tables x 2 seats each (8 total) in a 2x2 table grid
  const TABLE_SPACING = 3;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const tx = centerX + (col - 0.5) * TABLE_SPACING;
      const tz = baseZ + (row - 0.5) * TABLE_SPACING;
      coffeeStations.push({ pos: new THREE.Vector3(tx - 0.8, 0, tz), faceRot: Math.PI / 2 });
      coffeeStations.push({ pos: new THREE.Vector3(tx + 0.8, 0, tz), faceRot: -Math.PI / 2 });
    }
  }

  return [
    {
      type: 'coffee',
      center: [centerX, 0, baseZ],
      bounds: {
        minX: centerX - CASUAL_HALF,
        maxX: centerX + CASUAL_HALF,
        minZ: baseZ - CASUAL_HALF,
        maxZ: baseZ + CASUAL_HALF,
      },
      stations: coffeeStations,
    },
  ];
}

/** Create workstations for the coffee lounge (zone=-2). */
export function buildCasualWorkstations(
  areas: CasualArea[],
  startIdx: number,
): Workstation[] {
  const workstations: Workstation[] = [];
  let idx = startIdx;
  for (const area of areas) {
    const zone = -2;
    for (const station of area.stations) {
      workstations.push({
        idx,
        zone,
        seatPos: station.pos.clone(),
        faceRot: station.faceRot,
        occupantId: null,
      });
      idx++;
    }
  }
  return workstations;
}

// ---------------------------------------------------------------------------
// Dynamic Floor Size
// ---------------------------------------------------------------------------

export function computeFloorSize(rooms: RoomConfig[]): number {
  const b = computeSceneBounds(rooms);
  return Math.max(20, b * 2 + 6);
}
