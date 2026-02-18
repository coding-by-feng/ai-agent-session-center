/**
 * Cyberdrome scene layout — dynamic room grid system.
 * Rooms are placed in a grid. Adding/removing rooms reshapes the map.
 */
import * as THREE from 'three';
import type { Room } from '@/stores/roomStore';

// ---------------------------------------------------------------------------
// Layout Constants
// ---------------------------------------------------------------------------

export const ROOM_SIZE = 12;        // internal room dimension
export const ROOM_GAP = 5;          // corridor width between rooms
export const ROOM_CELL = ROOM_SIZE + ROOM_GAP; // 17
export const ROOM_HALF = ROOM_SIZE / 2; // 6
export const ROOM_COLS = 4;         // max rooms per row before wrapping
export const WALL_H = 2.8;
export const WALL_T = 0.12;
export const DOOR_GAP = 4;          // doorway width

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
  type: 'coffee' | 'gym';
  center: [number, number, number];
  bounds: RoomBound;
  stations: { pos: THREE.Vector3; faceRot: number }[];
}

export interface DoorWaypoint {
  roomIndex: number;
  outside: THREE.Vector3;  // south side, 1 unit past wall
  inside: THREE.Vector3;   // north side, 1 unit inside wall
}

export function buildDoorWaypoints(rooms: RoomConfig[]): DoorWaypoint[] {
  return rooms.map(room => {
    const [cx] = room.center;
    const maxZ = room.bounds.maxZ;
    return {
      roomIndex: room.index,
      outside: new THREE.Vector3(cx, 0, maxZ + 1.0),
      inside: new THREE.Vector3(cx, 0, maxZ - 1.0),
    };
  });
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

  // Exiting a room
  if (fromZone >= 0) {
    const exitDoor = doors.find(d => d.roomIndex === fromZone);
    if (exitDoor) {
      result.push(exitDoor.inside.clone());
      result.push(exitDoor.outside.clone());
    }
  }

  // Entering a room
  if (targetZone >= 0) {
    const enterDoor = doors.find(d => d.roomIndex === targetZone);
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
// Dynamic Desk Definitions (7 desks per room)
// ---------------------------------------------------------------------------

export function buildDynamicDeskDefs(rooms: RoomConfig[]): DeskDef[] {
  const desks: DeskDef[] = [];
  for (const room of rooms) {
    const [cx, , cz] = room.center;
    // All desks in the back half of the room, away from the south door.
    // 3 desks along north wall (back wall), facing south
    desks.push({ x: cx - 3.5, z: cz - 4.5, rotation: 0, zone: room.index });
    desks.push({ x: cx,       z: cz - 4.5, rotation: 0, zone: room.index });
    desks.push({ x: cx + 3.5, z: cz - 4.5, rotation: 0, zone: room.index });
    // 2 desks along west wall, facing east
    desks.push({ x: cx - 5, z: cz - 1.5, rotation: Math.PI / 2, zone: room.index });
    desks.push({ x: cx - 5, z: cz + 1.5, rotation: Math.PI / 2, zone: room.index });
    // 2 desks along east wall, facing west
    desks.push({ x: cx + 5, z: cz, rotation: -Math.PI / 2, zone: room.index });
    desks.push({ x: cx + 5, z: cz + 1.5, rotation: -Math.PI / 2, zone: room.index });
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
  // Dedicated "common area" with 10 desks for unassigned robots.
  // No desks between rooms or near room doors — only in this dedicated zone.
  const desks: { x: number; z: number; rotation: number }[] = [];

  if (roomConfigs.length === 0) {
    // No rooms — place 10 desks in a 2-row x 5-col grid near origin
    const spacingX = 3.5;
    const spacingZ = 4;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 5; col++) {
        desks.push({
          x: (col - 2) * spacingX,
          z: (row === 0 ? -3 : 3),
          rotation: row === 0 ? 0 : Math.PI,
        });
      }
    }
  } else {
    // Place 10 desks in a dedicated area well south of all rooms.
    const maxRow = Math.max(...roomConfigs.map(r => Math.floor(r.index / ROOM_COLS)));
    const maxCol = Math.min(ROOM_COLS - 1, Math.max(...roomConfigs.map(r => r.index % ROOM_COLS)));
    const minCol = Math.min(...roomConfigs.map(r => r.index % ROOM_COLS));

    const southmostRoomCenter = computeRoomCenter(maxRow * ROOM_COLS);
    const commonAreaZ = southmostRoomCenter[2] + ROOM_HALF + ROOM_GAP + 5;

    // Center horizontally across the room span
    const leftCol = computeRoomCenter(minCol);
    const rightCol = computeRoomCenter(maxCol);
    const areaCenterX = (leftCol[0] + rightCol[0]) / 2;

    // 2 rows x 5 desks, facing each other
    const spacingX = 4;
    const spacingZ = 4;
    const startX = areaCenterX - 2 * spacingX;

    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 5; col++) {
        desks.push({
          x: startX + col * spacingX,
          z: commonAreaZ + row * spacingZ,
          rotation: row === 0 ? 0 : Math.PI,
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

    // North wall (z = minZ): solid, no door
    rects.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ - ht, maxZ: b.minZ + ht });
    // South wall (z = maxZ): single door in center
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
  if (rooms.length === 0) return 30;
  let maxDist = 15;
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
    maxDist = Math.max(maxDist, Math.abs(southmostCenter[2]) + ROOM_HALF + ROOM_GAP + 15);
    // Account for casual areas north of rooms
    const minZedge = Math.min(...rooms.map(r => r.bounds.minZ));
    // casual areas extend ~20 units north of the northernmost room edge
    maxDist = Math.max(maxDist, Math.abs(minZedge) + ROOM_GAP + 20);
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
    rb.minX + 1.5 + Math.random() * (rb.maxX - rb.minX - 3),
    0,
    rb.minZ + 1.5 + Math.random() * (rb.maxZ - rb.minZ - 3),
  );
  return target;
}

/** Pick a random wander target for ungrouped robots (corridor/open area). */
export function pickCorridorTarget(bound: number): THREE.Vector3 {
  const target = new THREE.Vector3();
  // Wander near origin in the corridor areas
  const range = Math.min(bound, 8);
  target.set(
    (Math.random() - 0.5) * range * 2,
    0,
    (Math.random() - 0.5) * range * 2,
  );
  return target;
}

// ---------------------------------------------------------------------------
// Casual Areas (Coffee Lounge & Gym)
// ---------------------------------------------------------------------------

const CASUAL_AREA_SIZE = 14;  // expanded to accommodate 10+ gym devices
const CASUAL_HALF = CASUAL_AREA_SIZE / 2;

/** Build the Coffee Lounge and Gym areas NORTH of the rooms (above, negative Z side). */
export function buildCasualAreas(roomConfigs: RoomConfig[]): CasualArea[] {
  let baseZ: number;
  let centerX: number;

  if (roomConfigs.length === 0) {
    // No rooms — place casual areas north of origin
    baseZ = -12;
    centerX = 0;
  } else {
    // Find the northernmost (most negative Z) edge of all rooms
    const minZedge = Math.min(...roomConfigs.map(r => r.bounds.minZ));
    // Place casual areas north of that edge, with a gap
    baseZ = minZedge - ROOM_GAP - CASUAL_HALF - 2;

    const minCol = Math.min(...roomConfigs.map(r => r.index % ROOM_COLS));
    const maxCol = Math.min(ROOM_COLS - 1, Math.max(...roomConfigs.map(r => r.index % ROOM_COLS)));
    const leftCol = computeRoomCenter(minCol);
    const rightCol = computeRoomCenter(maxCol);
    centerX = (leftCol[0] + rightCol[0]) / 2;
  }

  const gap = 3;
  const coffeeX = centerX - CASUAL_HALF - gap / 2;
  const gymX = centerX + CASUAL_HALF + gap / 2;

  const coffeeStations: { pos: THREE.Vector3; faceRot: number }[] = [];
  // 6 coffee table seats in a 2x3 grid
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const sx = coffeeX - 3 + col * 3;
      const sz = baseZ - 2.5 + row * 5;
      coffeeStations.push({ pos: new THREE.Vector3(sx, 0, sz), faceRot: row === 0 ? 0 : Math.PI });
    }
  }

  const gymStations: { pos: THREE.Vector3; faceRot: number }[] = [];
  // 10 gym stations spread across the expanded area
  const gymPositions = [
    { x: gymX - 5,   z: baseZ - 5,   rot: 0 },           // bench press
    { x: gymX,       z: baseZ - 5,   rot: 0 },            // treadmill
    { x: gymX + 5,   z: baseZ - 5,   rot: 0 },            // rowing machine
    { x: gymX - 5,   z: baseZ,       rot: Math.PI / 2 },  // stationary bike
    { x: gymX,       z: baseZ,       rot: 0 },             // pull-up bar
    { x: gymX + 5,   z: baseZ,       rot: Math.PI / 2 },  // leg press
    { x: gymX - 5,   z: baseZ + 5,   rot: Math.PI },      // punching bag
    { x: gymX,       z: baseZ + 5,   rot: Math.PI },       // cable machine
    { x: gymX + 5,   z: baseZ + 5,   rot: Math.PI },      // kettlebell rack
    { x: gymX - 2.5, z: baseZ + 2.5, rot: Math.PI },      // weight rack / dumbbells
  ];
  for (const gp of gymPositions) {
    gymStations.push({ pos: new THREE.Vector3(gp.x, 0, gp.z), faceRot: gp.rot });
  }

  return [
    {
      type: 'coffee',
      center: [coffeeX, 0, baseZ],
      bounds: {
        minX: coffeeX - CASUAL_HALF,
        maxX: coffeeX + CASUAL_HALF,
        minZ: baseZ - CASUAL_HALF,
        maxZ: baseZ + CASUAL_HALF,
      },
      stations: coffeeStations,
    },
    {
      type: 'gym',
      center: [gymX, 0, baseZ],
      bounds: {
        minX: gymX - CASUAL_HALF,
        maxX: gymX + CASUAL_HALF,
        minZ: baseZ - CASUAL_HALF,
        maxZ: baseZ + CASUAL_HALF,
      },
      stations: gymStations,
    },
  ];
}

/** Create workstations for casual areas (zone=-2 for coffee, zone=-3 for gym). */
export function buildCasualWorkstations(
  areas: CasualArea[],
  startIdx: number,
): Workstation[] {
  const workstations: Workstation[] = [];
  let idx = startIdx;
  for (const area of areas) {
    const zone = area.type === 'coffee' ? -2 : -3;
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
  return Math.max(30, b * 2 + 10);
}
