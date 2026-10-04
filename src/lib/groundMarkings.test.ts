import { describe, it, expect } from 'vitest';
import {
  BAY_BORDER,
  BAY_LENGTH,
  BAY_WIDTH,
  THRESHOLD_WIDTH,
  buildBayStrips,
  buildLaneStrips,
  buildThresholdStrips,
  type MarkingStrip,
} from './groundMarkings';
import { ROOM_CELL, ROOM_COLS, ROOM_HALF, computeRoomCenter } from './roomGrid';
import { DOOR_GAP, buildDynamicWorkstations, computeRoomConfigs } from './cyberdromeScene';

/** The rooms a roomStore with these grid slots produces — only the field the markings read. */
const rooms = (...indices: number[]) => indices.map((index) => ({ index }));

const roomBounds = (index: number) => {
  const [cx, , cz] = computeRoomCenter(index);
  return { minX: cx - 4, maxX: cx + 4, minZ: cz - 4, maxZ: cz + 4 };
};

const inside = (s: MarkingStrip, b: ReturnType<typeof roomBounds>) =>
  s.x > b.minX && s.x < b.maxX && s.z > b.minZ && s.z < b.maxZ;

describe('buildLaneStrips', () => {
  it('paints nothing when there are no rooms', () => {
    expect(buildLaneStrips([])).toEqual([]);
  });

  it('only ever marks lane strips', () => {
    expect(buildLaneStrips(rooms(0, 1)).every((s) => s.kind === 'lane')).toBe(true);
  });

  it('never puts a dash on a room floor — lanes live in the corridors between rooms', () => {
    const all = rooms(0, 1, 2, 3, 4, 5);
    const strips = buildLaneStrips(all);
    expect(strips.length).toBeGreaterThan(0);
    for (const { index } of all) {
      const b = roomBounds(index);
      expect(strips.filter((s) => inside(s, b))).toEqual([]);
    }
  });

  it('keeps every dash inside the block of rooms plus its ring road', () => {
    // Rooms 0, 1, 4, 5 fill columns 0..1 of rows 0..1; the ring road is one half cell outside them.
    const strips = buildLaneStrips(rooms(0, 1, 4, 5));
    const xMin = computeRoomCenter(0)[0] - ROOM_CELL / 2;
    const xMax = computeRoomCenter(1)[0] + ROOM_CELL / 2;
    const zMin = computeRoomCenter(0)[2] - ROOM_CELL / 2;
    const zMax = computeRoomCenter(ROOM_COLS)[2] + ROOM_CELL / 2;
    for (const s of strips) {
      expect(s.x).toBeGreaterThanOrEqual(xMin - 0.001);
      expect(s.x).toBeLessThanOrEqual(xMax + 0.001);
      expect(s.z).toBeGreaterThanOrEqual(zMin - 0.001);
      expect(s.z).toBeLessThanOrEqual(zMax + 0.001);
    }
  });

  it('runs a ring road round the whole block: a lane on the outer edge of its first and last column and row', () => {
    // Rooms 0, 1, 4, 5 fill columns 0..1 of rows 0..1, so the lane lines are x = -20, -10, 0 and z = -5, 5, 15.
    const strips = buildLaneStrips(rooms(0, 1, 4, 5));
    const xs = new Set(strips.filter((s) => Math.abs(Math.sin(s.rotY)) > 0.99).map((s) => Math.round(s.x)));
    const zs = new Set(strips.filter((s) => Math.abs(Math.cos(s.rotY)) > 0.99).map((s) => Math.round(s.z)));
    expect([...xs].sort((a, b) => a - b)).toEqual([-20, -10, 0]);
    expect([...zs].sort((a, b) => a - b)).toEqual([-5, 5, 15]);
  });

  it('draws more of the road as the block of rooms grows', () => {
    expect(buildLaneStrips(rooms(0, 1, 2, 3)).length).toBeGreaterThan(buildLaneStrips(rooms(0)).length);
    expect(buildLaneStrips(rooms(0, 1, 2, 3, 4)).length).toBeGreaterThan(buildLaneStrips(rooms(0, 1, 2, 3)).length);
  });

  it('runs dashes along the lane: horizontal lanes along X, vertical lanes along Z', () => {
    const strips = buildLaneStrips(rooms(0, 1));
    const horizontal = strips.filter((s) => Math.abs(Math.cos(s.rotY)) > 0.99);
    const vertical = strips.filter((s) => Math.abs(Math.sin(s.rotY)) > 0.99);
    expect(horizontal.length + vertical.length).toBe(strips.length);
    expect(horizontal.length).toBeGreaterThan(0);
    expect(vertical.length).toBeGreaterThan(0);
    // A horizontal dash sits on one of the lane lines z = row edge; a vertical one on x = column edge.
    for (const s of horizontal) expect(Math.abs(((s.z + ROOM_CELL / 2) % ROOM_CELL + ROOM_CELL) % ROOM_CELL)).toBeLessThan(0.001);
  });

  it('leaves each crossing clear instead of stacking two dashes on it', () => {
    const strips = buildLaneStrips(rooms(0, 1, 4, 5));
    const crossingX = computeRoomCenter(0)[0] + ROOM_CELL / 2; // between columns 0 and 1
    const crossingZ = ROOM_CELL / 2; // between rows 0 and 1
    const near = strips.filter((s) => Math.abs(s.x - crossingX) < 1 && Math.abs(s.z - crossingZ) < 1);
    expect(near).toEqual([]);
  });

  it('is stable: the same rooms give the same strips', () => {
    expect(buildLaneStrips(rooms(0, 1, 2))).toEqual(buildLaneStrips(rooms(0, 1, 2)));
  });

  it('wraps the block by grid slot, not by list order', () => {
    expect(buildLaneStrips(rooms(5, 0, 1, 4))).toEqual(buildLaneStrips(rooms(0, 1, 4, 5)));
  });

  it('spans a whole row even when rooms have wrapped onto the second one', () => {
    const wrapped = buildLaneStrips(rooms(ROOM_COLS)); // first room of row 1
    expect(wrapped.length).toBeGreaterThan(0);
  });
});

describe('buildBayStrips', () => {
  const seat = { x: 2, z: 3, faceRot: 0 };

  it('paints nothing without seats', () => {
    expect(buildBayStrips([])).toEqual([]);
  });

  it('outlines each seat with four strips', () => {
    expect(buildBayStrips([seat])).toHaveLength(4);
    expect(buildBayStrips([seat, { ...seat, x: 5 }, { ...seat, x: 8 }])).toHaveLength(12);
  });

  it('only ever marks bay strips', () => {
    expect(buildBayStrips([seat]).every((s) => s.kind === 'bay')).toBe(true);
  });

  it('surrounds the seat: the outline is centred on it, nudged toward the desk', () => {
    const strips = buildBayStrips([seat]);
    const cx = strips.reduce((sum, s) => sum + s.x, 0) / strips.length;
    const cz = strips.reduce((sum, s) => sum + s.z, 0) / strips.length;
    expect(cx).toBeCloseTo(seat.x, 5);
    // faceRot 0 faces +Z (toward the desk), so the bay is shifted a little toward +Z
    expect(cz).toBeGreaterThan(seat.z);
    expect(cz - seat.z).toBeLessThan(BAY_LENGTH / 4);
  });

  it('sizes the outline to the seat: two long sides and two short ends', () => {
    const strips = buildBayStrips([seat]);
    const long = strips.filter((s) => Math.abs(s.length - BAY_LENGTH) < 1e-9);
    const short = strips.filter((s) => s.length < BAY_LENGTH);
    expect(long).toHaveLength(2);
    expect(short).toHaveLength(2);
    for (const s of strips) expect(s.width).toBeCloseTo(BAY_BORDER, 9);
    // the ends sit between the sides, so the corners are not painted twice
    for (const s of short) expect(s.length).toBeCloseTo(BAY_WIDTH - 2 * BAY_BORDER, 9);
  });

  it('turns with the seat: the long sides run the way the seat faces', () => {
    for (const faceRot of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7]) {
      const strips = buildBayStrips([{ x: 0, z: 0, faceRot }]);
      const long = strips.filter((s) => Math.abs(s.length - BAY_LENGTH) < 1e-9);
      for (const s of long) {
        // the strip's local X axis, after rotating about Y by rotY, is (cos, -sin) in world (x, z)
        const dx = Math.cos(s.rotY);
        const dz = -Math.sin(s.rotY);
        const fx = Math.sin(faceRot);
        const fz = Math.cos(faceRot);
        expect(Math.abs(dx * fx + dz * fz)).toBeCloseTo(1, 6); // parallel to the facing direction
      }
    }
  });

  // The real layout: ten seats per room, five rows of two, 1.2 apart along the wall. Each outline's
  // actual extents (from the strips, rotation and all) must stay clear of every other and of the walls.
  describe('on the real room layout', () => {
    const [room] = computeRoomConfigs([
      { id: 'r', name: 'r', sessionIds: [], collapsed: false, createdAt: 0, roomIndex: 0 },
    ]);
    const seats = buildDynamicWorkstations([room]).map((w) => ({ x: w.seatPos.x, z: w.seatPos.z, faceRot: w.faceRot }));
    const strips = buildBayStrips(seats);

    /** Axis-aligned extents of the four strips of one seat's outline. */
    const extents = (group: MarkingStrip[]) => {
      const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (const s of group) {
        // local X -> (cos, -sin), local Z -> (sin, cos) in world (x, z)
        const ux = Math.cos(s.rotY), uz = -Math.sin(s.rotY);
        const vx = Math.sin(s.rotY), vz = Math.cos(s.rotY);
        for (const a of [-1, 1]) {
          for (const b of [-1, 1]) {
            const x = s.x + (ux * a * s.length) / 2 + (vx * b * s.width) / 2;
            const z = s.z + (uz * a * s.length) / 2 + (vz * b * s.width) / 2;
            box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
            box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
          }
        }
      }
      return box;
    };
    const boxes = seats.map((_, i) => extents(strips.slice(i * 4, i * 4 + 4)));

    it('outlines all ten seats of the room', () => {
      expect(seats).toHaveLength(10);
      expect(strips).toHaveLength(40);
    });

    it('keeps every outline clear of every other one', () => {
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          const overlapX = Math.min(boxes[a].maxX, boxes[b].maxX) - Math.max(boxes[a].minX, boxes[b].minX);
          const overlapZ = Math.min(boxes[a].maxZ, boxes[b].maxZ) - Math.max(boxes[a].minZ, boxes[b].minZ);
          expect(overlapX > 1e-9 && overlapZ > 1e-9).toBe(false);
        }
      }
    });

    it('keeps every outline on the room floor, never across a wall', () => {
      const { minX, maxX, minZ, maxZ } = room.bounds;
      for (const box of boxes) {
        expect(box.minX).toBeGreaterThanOrEqual(minX);
        expect(box.maxX).toBeLessThanOrEqual(maxX);
        expect(box.minZ).toBeGreaterThanOrEqual(minZ);
        expect(box.maxZ).toBeLessThanOrEqual(maxZ);
      }
    });

    it('sizes each outline to the seat it surrounds', () => {
      for (const box of boxes) {
        const span = [box.maxX - box.minX, box.maxZ - box.minZ].sort((p, q) => p - q);
        expect(span[0]).toBeCloseTo(BAY_WIDTH, 6);
        expect(span[1]).toBeCloseTo(BAY_LENGTH, 6);
      }
    });
  });
});

describe('buildThresholdStrips', () => {
  const room = (cx: number, cz: number, stripColor: 0 | 1 = 0) => ({ center: [cx, 0, cz] as [number, number, number], stripColor });

  it('paints nothing without rooms', () => {
    expect(buildThresholdStrips([], DOOR_GAP)).toEqual([]);
  });

  it('puts one strip in each doorway of a room: the north wall and the south wall', () => {
    const strips = buildThresholdStrips([room(-15, 0)], DOOR_GAP);
    expect(strips).toHaveLength(2);
    expect(strips.map((s) => s.z).sort((a, b) => a - b)).toEqual([-ROOM_HALF, ROOM_HALF]);
    for (const s of strips) expect(s.x).toBe(-15);
  });

  it('only ever marks threshold strips', () => {
    expect(buildThresholdStrips([room(0, 0), room(10, 0)], DOOR_GAP).every((s) => s.kind === 'threshold')).toBe(true);
  });

  it('spans exactly the doorway, so it never runs under a wall', () => {
    for (const s of buildThresholdStrips([room(0, 0)], DOOR_GAP)) {
      expect(s.length).toBeCloseTo(DOOR_GAP, 9);
      expect(s.rotY).toBe(0); // along X, across the doorway
      expect(s.width).toBe(THRESHOLD_WIDTH);
    }
  });

  it('carries its room’s accent, so a doorway is painted in the colour of the room it leads into', () => {
    expect(buildThresholdStrips([room(0, 0, 0)], DOOR_GAP).every((s) => s.accent === 0)).toBe(true);
    expect(buildThresholdStrips([room(0, 0, 1)], DOOR_GAP).every((s) => s.accent === 1)).toBe(true);
  });

  it('gives every room its own pair', () => {
    expect(buildThresholdStrips([room(0, 0), room(10, 0), room(20, 0)], DOOR_GAP)).toHaveLength(6);
  });

  // The real layout: a threshold must not land on a seat outline or a lane dash.
  describe('on the real layout', () => {
    const configs = computeRoomConfigs(
      [0, 1, 4, 5].map((roomIndex) => ({ id: `r${roomIndex}`, name: `r${roomIndex}`, sessionIds: [], collapsed: false, createdAt: 0, roomIndex })),
    );
    const thresholds = buildThresholdStrips(configs, DOOR_GAP);
    const others = [
      ...buildLaneStrips(configs),
      ...buildBayStrips(buildDynamicWorkstations(configs).map((w) => ({ x: w.seatPos.x, z: w.seatPos.z, faceRot: w.faceRot }))),
    ];

    const box = (s: MarkingStrip) => {
      const alongX = Math.abs(Math.cos(s.rotY)) > 0.5;
      const [hx, hz] = alongX ? [s.length / 2, s.width / 2] : [s.width / 2, s.length / 2];
      return { minX: s.x - hx, maxX: s.x + hx, minZ: s.z - hz, maxZ: s.z + hz };
    };

    it('has a pair for every room', () => {
      expect(thresholds).toHaveLength(configs.length * 2);
    });

    it('never overlaps a lane dash or a seat outline', () => {
      for (const t of thresholds) {
        const a = box(t);
        for (const o of others) {
          const b = box(o);
          const overlapX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
          const overlapZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
          expect(overlapX > 1e-9 && overlapZ > 1e-9, `threshold at (${t.x}, ${t.z}) vs ${o.kind} at (${o.x.toFixed(2)}, ${o.z.toFixed(2)})`).toBe(false);
        }
      }
    });
  });
});
