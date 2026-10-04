import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { THEMES } from '@/stores/settingsStore';
import { deltaE } from './colorMath';
import {
  COUNTER_HALF_LENGTH,
  COUNTER_INSET,
  DESK_HALF_LONG,
  DESK_HALF_SHORT,
  DIORAMA_WALL_H,
  FOLIAGE_CANDIDATES,
  FOLIAGE_MIN_DELTA_E,
  LOUNGE_SIZE,
  LOUNGE_TABLE_RADIUS,
  LOUNGE_TABLE_SPACING,
  PLANT_PART,
  PLANT_RADIUS,
  PLANT_SCALE,
  SEAT_HALF,
  buildDoorPosts,
  buildPlantSpots,
  plantFoliage,
  plantHeight,
} from './dioramaProps';
import { ROOM_HALF } from './roomGrid';
import { getScene3DTheme } from './sceneThemes';
import { DOOR_GAP, buildCasualAreas, buildDynamicDeskDefs, buildDynamicWorkstations, computeRoomConfigs } from './cyberdromeScene';

const room = (cx: number, cz: number, stripColor: 0 | 1 = 0) => ({ center: [cx, 0, cz] as [number, number, number], stripColor });

describe('buildDoorPosts', () => {
  it('has none without rooms', () => {
    expect(buildDoorPosts([], DOOR_GAP)).toEqual([]);
  });

  it('puts a post at each end of each doorway: four per room', () => {
    expect(buildDoorPosts([room(0, 0)], DOOR_GAP)).toHaveLength(4);
    expect(buildDoorPosts([room(0, 0), room(10, 0), room(20, 0)], DOOR_GAP)).toHaveLength(12);
  });

  it('stands them at the wall line, half a doorway either side of the room’s centre line', () => {
    const posts = buildDoorPosts([room(-15, 3)], DOOR_GAP);
    expect(posts.map((p) => p.x).sort((a, b) => a - b)).toEqual([-15 - DOOR_GAP / 2, -15 - DOOR_GAP / 2, -15 + DOOR_GAP / 2, -15 + DOOR_GAP / 2]);
    expect(posts.map((p) => p.z).sort((a, b) => a - b)).toEqual([3 - ROOM_HALF, 3 - ROOM_HALF, 3 + ROOM_HALF, 3 + ROOM_HALF]);
  });

  it('is mirror-symmetric: every post has a partner across the doorway', () => {
    const posts = buildDoorPosts([room(0, 0)], DOOR_GAP);
    for (const p of posts) {
      expect(posts.some((q) => q.z === p.z && Math.abs(q.x + p.x) < 1e-9 && q !== p)).toBe(true);
    }
  });

  it('carries its room’s accent', () => {
    expect(buildDoorPosts([room(0, 0, 1)], DOOR_GAP).every((p) => p.accent === 1)).toBe(true);
    expect(buildDoorPosts([room(0, 0, 0)], DOOR_GAP).every((p) => p.accent === 0)).toBe(true);
  });

  it('follows the real room layout', () => {
    const configs = computeRoomConfigs([0, 1].map((roomIndex) => ({ id: `r${roomIndex}`, name: `r${roomIndex}`, sessionIds: [], collapsed: false, createdAt: 0, roomIndex })));
    const posts = buildDoorPosts(configs, DOOR_GAP);
    expect(posts).toHaveLength(8);
    for (const c of configs) {
      const mine = posts.filter((p) => Math.abs(p.x - c.center[0]) <= DOOR_GAP / 2 + 1e-9 && Math.abs(Math.abs(p.z - c.center[2]) - ROOM_HALF) < 1e-9);
      expect(mine).toHaveLength(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

const realRooms = (...indices: number[]) =>
  computeRoomConfigs(indices.map((roomIndex) => ({ id: `r${roomIndex}`, name: `r${roomIndex}`, sessionIds: [], collapsed: false, createdAt: 0, roomIndex })));

describe('plantFoliage', () => {
  it('has a soft green first: a plant should look like a plant where it can', () => {
    expect(FOLIAGE_CANDIDATES[0]).toBe('#6fbf73');
  });

  // Windows XP's lawn is green: green foliage on it is the camouflage bug again, in a new place. A plant stands
  // on the room floor, the lounge pad and — just outside the walls — the main floor: all three count.
  it.each(THEMES.map((theme) => theme.name))('reads against the %s main floor, room floor and lounge floor', (name) => {
    const theme = getScene3DTheme(name);
    const foliage = plantFoliage(theme);
    for (const floor of [theme.floor, theme.roomFloor, theme.coffeeFloor]) {
      expect(deltaE(foliage, floor), `${name} on ${floor}`).toBeGreaterThanOrEqual(FOLIAGE_MIN_DELTA_E);
    }
  });

  it('is green on every palette that allows it, and moves off green only where it must', () => {
    expect(plantFoliage(getScene3DTheme('command-center'))).toBe('#6fbf73');
    expect(plantFoliage(getScene3DTheme('light'))).toBe('#6fbf73');
    expect(plantFoliage(getScene3DTheme('warm'))).toBe('#6fbf73');
    expect(plantFoliage(getScene3DTheme('windows-xp'))).not.toBe('#6fbf73');
  });

  it('settles on the best of a bad lot rather than failing when nothing clears the bar', () => {
    const greenOnGreen = plantFoliage({ floor: '#6fbf73', roomFloor: '#6fbf73', coffeeFloor: '#6fbf73' });
    expect(FOLIAGE_CANDIDATES).toContain(greenOnGreen);
    expect(greenOnGreen).not.toBe('#6fbf73'); // the one colour that is invisible there
  });

  it('looks at the lounge floor too: leaves that clear the room floor can still vanish on the lounge pad', () => {
    // pink clears this room floor easily, but not a pink lounge pad
    const colour = plantFoliage({ floor: '#4a7a1e', roomFloor: '#588f26', coffeeFloor: '#f2a7c3' });
    expect(colour).not.toBe('#f2a7c3');
  });
});

describe('buildPlantSpots', () => {
  const rooms = realRooms(0, 1, 4, 5);
  const desks = buildDynamicDeskDefs(rooms);
  const seats = buildDynamicWorkstations(rooms).map((w) => ({ x: w.seatPos.x, z: w.seatPos.z }));
  const areas = buildCasualAreas(rooms); // where the scene really puts the lounge
  const lounge = areas[0];
  const spots = buildPlantSpots({ rooms, desks, seats, areas, doorGap: DOOR_GAP });

  it('has none without rooms or areas', () => {
    expect(buildPlantSpots({ rooms: [], desks: [], seats: [], areas: [], doorGap: DOOR_GAP })).toEqual([]);
  });

  it('puts a pair beside each doorway of a room (four per room) and one in each corner of a lounge', () => {
    expect(spots.filter((s) => s.kind === 'room')).toHaveLength(rooms.length * 4);
    expect(spots.filter((s) => s.kind === 'lounge')).toHaveLength(4);
  });

  it('keeps every room plant inside its room, clear of the walls, and off the robots’ path down the middle', () => {
    for (const r of rooms) {
      for (const s of spots.filter((p) => p.kind === 'room' && Math.abs(p.x - r.center[0]) < ROOM_HALF && Math.abs(p.z - r.center[2]) < ROOM_HALF)) {
        expect(Math.abs(s.x - r.center[0])).toBeLessThanOrEqual(ROOM_HALF - 0.45);
        expect(Math.abs(s.z - r.center[2])).toBeLessThanOrEqual(ROOM_HALF - 0.45);
        expect(Math.abs(s.x - r.center[0])).toBeGreaterThanOrEqual(DOOR_GAP / 2 + 0.3 + 0.3); // beside the doorway, not in it
      }
    }
  });

  // A plant is a ~0.3 radius circle. A desk is a rotated 1.5 x 0.65 slab, a chair a 0.36 square.
  it('never touches a desk: at least 0.15 clear of its footprint', () => {
    for (const s of spots) {
      for (const d of desks) {
        const hx = Math.abs(Math.cos(d.rotation)) * 0.75 + Math.abs(Math.sin(d.rotation)) * 0.325;
        const hz = Math.abs(Math.sin(d.rotation)) * 0.75 + Math.abs(Math.cos(d.rotation)) * 0.325;
        const gapX = Math.max(0, Math.abs(s.x - d.x) - hx);
        const gapZ = Math.max(0, Math.abs(s.z - d.z) - hz);
        expect(Math.hypot(gapX, gapZ) - 0.3 * s.scale, `plant (${s.x}, ${s.z}) vs desk (${d.x}, ${d.z})`).toBeGreaterThanOrEqual(0.15);
      }
    }
  });

  it('never touches a chair, or a doorway post', () => {
    const posts = buildDoorPosts(rooms, DOOR_GAP);
    for (const s of spots) {
      for (const q of seats) expect(Math.hypot(s.x - q.x, s.z - q.z), `seat (${q.x}, ${q.z})`).toBeGreaterThanOrEqual(0.3 * s.scale + 0.18 + 0.1);
      for (const p of posts) expect(Math.hypot(s.x - p.x, s.z - p.z), `post (${p.x}, ${p.z})`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('keeps lounge plants off the tables and the counter', () => {
    const [cx, , cz] = lounge.center;
    const tables = [-0.5, 0.5].flatMap((col) => [-0.5, 0.5].map((row) => [cx + col * LOUNGE_TABLE_SPACING, cz + row * LOUNGE_TABLE_SPACING]));
    for (const s of spots.filter((p) => p.kind === 'lounge')) {
      expect(Math.abs(s.x - cx)).toBeLessThanOrEqual(LOUNGE_SIZE / 2 - 0.5);
      expect(Math.abs(s.z - cz)).toBeLessThanOrEqual(LOUNGE_SIZE / 2 - 0.5);
      for (const [tx, tz] of tables) expect(Math.hypot(s.x - tx, s.z - tz)).toBeGreaterThanOrEqual(0.4 + 0.3 + 0.3);
      // the counter runs along the north edge, 5 wide
      const onCounterRow = Math.abs(s.z - (cz - LOUNGE_SIZE / 2 + 0.4)) < 0.6;
      if (onCounterRow) expect(Math.abs(s.x - cx)).toBeGreaterThanOrEqual(2.55 + 0.3 + 0.2);
    }
  });

  it('varies the sizes a little, never wildly, and is deterministic', () => {
    for (const s of spots) {
      expect(s.scale).toBeGreaterThanOrEqual(0.9);
      expect(s.scale).toBeLessThanOrEqual(1.15);
    }
    expect(new Set(spots.map((s) => s.scale)).size).toBeGreaterThan(1);
    expect(buildPlantSpots({ rooms, desks, seats, areas, doorGap: DOOR_GAP })).toEqual(spots);
  });

  // The lounge is drawn by `CoffeeLounge` from these two numbers; the scene lays its stations out from its own.
  it('uses the lounge size and table spacing the scene really lays out', () => {
    expect(lounge.bounds.maxX - lounge.bounds.minX).toBe(LOUNGE_SIZE);
    expect(lounge.bounds.maxZ - lounge.bounds.minZ).toBe(LOUNGE_SIZE);
    const tableXs = new Set(lounge.stations.map((st) => Math.round((st.pos.x - lounge.center[0]) * 10) / 10 + 0)); // seats sit 0.8 either side of a table
    expect([...tableXs].sort((a, b) => a - b)).toEqual([-2.3, -0.7, 0.7, 2.3]); // tables at ±LOUNGE_TABLE_SPACING/2, seats ±0.8
    expect(LOUNGE_TABLE_SPACING / 2 + 0.8).toBeCloseTo(2.3, 9);
  });

  // The filters, exercised: a candidate is DROPPED when it would touch furniture. In the real layout every
  // candidate is clear, so only a crowded one proves the checks exist.
  describe('drops a candidate that would touch furniture', () => {
    const solo = realRooms(0);
    const plain = buildPlantSpots({ rooms: solo, desks: [], seats: [], areas: [], doorGap: DOOR_GAP });
    const target = plain[0];
    const without = (spots: typeof plain) => spots.filter((s) => s.x === target.x && s.z === target.z);

    it('has four to start with, and the first is a real spot to crowd', () => {
      expect(plain).toHaveLength(4);
      expect(target).toBeDefined();
    });

    it('a desk on it', () => {
      const crowded = buildPlantSpots({ rooms: solo, desks: [{ x: target.x, z: target.z, rotation: 0 }], seats: [], areas: [], doorGap: DOOR_GAP });
      expect(crowded).toHaveLength(3);
      expect(without(crowded)).toHaveLength(0);
    });

    it('a chair on it', () => {
      const crowded = buildPlantSpots({ rooms: solo, desks: [], seats: [{ x: target.x, z: target.z }], areas: [], doorGap: DOOR_GAP });
      expect(crowded).toHaveLength(3);
      expect(without(crowded)).toHaveLength(0);
    });

    it('a rotated desk whose far end reaches it, but not a desk safely beyond reach', () => {
      // a desk running along z, its end 0.1 short of the plant: within the margin, so dropped
      const reaching = buildPlantSpots({ rooms: solo, desks: [{ x: target.x, z: target.z - DESK_HALF_LONG - PLANT_RADIUS - 0.05, rotation: Math.PI / 2 }], seats: [], areas: [], doorGap: DOOR_GAP });
      expect(without(reaching)).toHaveLength(0);
      const far = buildPlantSpots({ rooms: solo, desks: [{ x: target.x, z: target.z - 4, rotation: Math.PI / 2 }], seats: [], areas: [], doorGap: DOOR_GAP });
      expect(far).toHaveLength(4);
    });

    it('a lounge plant is dropped by a chair on it, and by a doorway post beside it', () => {
      const lone = { center: [0, 0, 40] as [number, number, number] };
      const four = buildPlantSpots({ rooms: [], desks: [], seats: [], areas: [lone], doorGap: DOOR_GAP });
      expect(four).toHaveLength(4);
      const seated = buildPlantSpots({ rooms: [], desks: [], seats: [{ x: four[0].x, z: four[0].z }], areas: [lone], doorGap: DOOR_GAP });
      expect(seated).toHaveLength(3);
      // a room whose south doorway stands right beside one lounge corner (post at (-14.25, 4); that corner lands ~0.4 away)
      const nearDoor = buildPlantSpots({ rooms: realRooms(0), desks: [], seats: [], areas: [{ center: [-18.25, 0, 8] }], doorGap: DOOR_GAP });
      expect(nearDoor.filter((s) => s.kind === 'lounge')).toHaveLength(3);
    });
  });

  // A plant is drawn from these dimensions and placed with these clearances: they must agree, or a leaf pokes
  // through a wall cap or over a desk although every placement test passes.
  describe('its dimensions agree with where it is placed', () => {
    it('keeps the crown inside the footprint radius the clearances assume', () => {
      expect(PLANT_PART.leafRadius).toBeLessThanOrEqual(PLANT_RADIUS);
    });

    it('stays under a metre at its tallest, and no more than 0.3 above the walls', () => {
      expect(plantHeight(PLANT_SCALE.max)).toBeLessThan(1);
      expect(plantHeight(PLANT_SCALE.max)).toBeLessThanOrEqual(DIORAMA_WALL_H + 0.3);
    });

    it('grows with its scale', () => {
      expect(plantHeight(1.1)).toBeGreaterThan(plantHeight(0.9));
    });
  });

  // The clearances use furniture sizes copied from the components that draw it. Pin each copy to its source.
  describe('uses the furniture sizes the scene really draws', () => {
    const environment = readFileSync(resolve(__dirname, '../components/3d/CyberdromeEnvironment.tsx'), 'utf8');
    const numbers = (pattern: RegExp): number[] => {
      const match = pattern.exec(environment);
      expect(match, `no match for ${pattern}`).not.toBeNull();
      return match!.slice(1).map(Number);
    };

    it('the desk top: 1.5 x 0.65', () => {
      const [length, width] = numbers(/args=\{\[([\d.]+), 0\.05, ([\d.]+)\]\}\s+position=\{\[0, 0\.7, 0\]\}/);
      expect(length / 2).toBe(DESK_HALF_LONG);
      expect(width / 2).toBe(DESK_HALF_SHORT);
    });

    it('the chair seat: 0.36 square', () => {
      const [w, d] = numbers(/args=\{\[([\d.]+), 0\.03, ([\d.]+)\]\}\s+position=\{\[0, 0\.4, 0\]\}/);
      expect(w / 2).toBe(SEAT_HALF);
      expect(d / 2).toBe(SEAT_HALF);
    });

    it('the lounge table: radius 0.4', () => {
      const [radius] = numbers(/<cylinderGeometry args=\{\[([\d.]+), [\d.]+, 0\.04, 10\]\} \/>/);
      expect(radius).toBe(LOUNGE_TABLE_RADIUS);
    });

    it('the lounge counter top: 5.1 wide, 0.4 in from the north edge', () => {
      const [width, inset] = numbers(/args=\{\[([\d.]+), 0\.03, 0\.35\]\} position=\{\[cx, 0\.96, cz - areaSize \/ 2 \+ ([\d.]+)\]\}/);
      expect(width / 2).toBe(COUNTER_HALF_LENGTH);
      expect(inset).toBe(COUNTER_INSET);
    });
  });

  it('is empty-safe for a room with no desks to avoid', () => {
    expect(buildPlantSpots({ rooms: realRooms(0), desks: [], seats: [], areas: [], doorGap: DOOR_GAP })).toHaveLength(4);
  });
});
