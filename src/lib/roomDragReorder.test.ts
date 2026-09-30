import { describe, it, expect } from 'vitest';
import {
  computeRoomInsertIndex,
  applyRoomReorder,
  computeRoomShifts,
  clampRoomDragOffset,
  roomDragHitY,
  type RoomDragRect,
} from './roomDragReorder';

/** Three room frames stacked vertically, as in the left-rail switcher. */
const COLUMN: RoomDragRect[] = [
  { id: 'a', top: 0, bottom: 40 },
  { id: 'b', top: 50, bottom: 90 },
  { id: 'c', top: 100, bottom: 140 },
];

describe('computeRoomInsertIndex', () => {
  it('top half of the first frame inserts before it', () => {
    expect(computeRoomInsertIndex(COLUMN, 5)).toBe(0);
  });

  it('bottom half of the first frame inserts after it', () => {
    expect(computeRoomInsertIndex(COLUMN, 35)).toBe(1);
  });

  it('top half of the middle frame inserts before it', () => {
    expect(computeRoomInsertIndex(COLUMN, 55)).toBe(1);
  });

  it('bottom half of the last frame inserts at the end', () => {
    expect(computeRoomInsertIndex(COLUMN, 135)).toBe(3);
  });

  it('a pointer in the gap between frames resolves to the nearer one, not to nothing', () => {
    expect(computeRoomInsertIndex(COLUMN, 45)).toBe(1);
  });

  it('past the bottom edge still resolves to the end', () => {
    expect(computeRoomInsertIndex(COLUMN, 9999)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(computeRoomInsertIndex([], 10)).toBe(0);
  });

  it('handles a single room', () => {
    const one = [COLUMN[0]]; // top 0, bottom 40 -> midpoint 20
    expect(computeRoomInsertIndex(one, 10)).toBe(0);
    expect(computeRoomInsertIndex(one, 30)).toBe(1);
  });
});

describe('applyRoomReorder', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves a room BACKWARD to the requested slot', () => {
    expect(applyRoomReorder(ids, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves a room FORWARD accounting for its own removal', () => {
    // insertIndex 3 is measured with 'a' still present; splicing at 3 after
    // removing it would land past the intended slot without the adjustment.
    expect(applyRoomReorder(ids, 'a', 3)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves a room to the very end', () => {
    expect(applyRoomReorder(ids, 'a', 4)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves a room to the very front', () => {
    expect(applyRoomReorder(ids, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('is a no-op when dropped in its own slot', () => {
    expect(applyRoomReorder(ids, 'b', 1)).toBe(ids);
  });

  it('is a no-op when dropped just after itself', () => {
    expect(applyRoomReorder(ids, 'b', 2)).toBe(ids);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(applyRoomReorder(ids, 'nope', 0)).toBe(ids);
  });

  it('never drops or duplicates a room', () => {
    for (let target = 0; target <= ids.length; target++) {
      for (const id of ids) {
        const out = applyRoomReorder(ids, id, target);
        expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
      }
    }
  });
});

describe('computeRoomShifts', () => {
  // COLUMN: every frame is 40 tall with a 10 gap, so each one's pitch is 50.

  it('slides nothing until the pointer indicates a slot', () => {
    expect(computeRoomShifts(COLUMN, 'a', null).size).toBe(0);
  });

  it('slides nothing for the two no-op slots — its own, and just after itself', () => {
    // These are exactly the slots applyRoomReorder treats as "no change", so
    // the preview must show no change either (the old caret lit a neighbour).
    expect(computeRoomShifts(COLUMN, 'b', 1).size).toBe(0);
    expect(computeRoomShifts(COLUMN, 'b', 2).size).toBe(0);
  });

  it('moving DOWN slides every room it passes UP by one pitch', () => {
    expect(Object.fromEntries(computeRoomShifts(COLUMN, 'a', 3))).toEqual({ b: -50, c: -50 });
  });

  it('moving UP slides every room it passes DOWN by one pitch', () => {
    expect(Object.fromEntries(computeRoomShifts(COLUMN, 'c', 0))).toEqual({ a: 50, b: 50 });
  });

  it('only the rooms between the old and the new slot move', () => {
    expect(Object.fromEntries(computeRoomShifts(COLUMN, 'a', 2))).toEqual({ b: -50 });
    expect(Object.fromEntries(computeRoomShifts(COLUMN, 'c', 1))).toEqual({ b: 50 });
  });

  it('the pitch is the DRAGGED room\'s height plus the gap, so a tall room opens a tall slot', () => {
    // An expanded room (200 tall) above two collapsed ones (30 tall), gap 10.
    const MIXED: RoomDragRect[] = [
      { id: 'a', top: 0, bottom: 200 },
      { id: 'b', top: 210, bottom: 240 },
      { id: 'c', top: 250, bottom: 280 },
    ];
    expect(Object.fromEntries(computeRoomShifts(MIXED, 'a', 3))).toEqual({ b: -210, c: -210 });
    expect(Object.fromEntries(computeRoomShifts(MIXED, 'c', 0))).toEqual({ a: 40, b: 40 });
  });

  it('slides nothing for an id that is not in the list', () => {
    expect(computeRoomShifts(COLUMN, 'nope', 0).size).toBe(0);
  });

  it('previews every other room exactly where the committed drop will put it', () => {
    // The property the whole preview rests on: if a passed room sits even 1px
    // away from its post-drop position, every drop ends with it visibly
    // jumping. Checked for every (room, slot) pair against applyRoomReorder
    // over frames of four different heights.
    const GAP = 10;
    const rects: RoomDragRect[] = [
      { id: 'a', top: 0, bottom: 40 },
      { id: 'b', top: 50, bottom: 70 },
      { id: 'c', top: 80, bottom: 160 },
      { id: 'd', top: 170, bottom: 230 },
    ];
    const ids = rects.map((r) => r.id);
    const byId = new Map(rects.map((r) => [r.id, r]));

    for (const dragged of ids) {
      for (let slot = 0; slot <= ids.length; slot++) {
        const committed = applyRoomReorder(ids, dragged, slot);
        const expectedTop = new Map<string, number>();
        let y = rects[0].top;
        for (const id of committed) {
          const r = byId.get(id)!;
          expectedTop.set(id, y);
          y += r.bottom - r.top + GAP;
        }

        const shifts = computeRoomShifts(rects, dragged, slot);
        for (const r of rects) {
          if (r.id === dragged) continue;
          expect(r.top + (shifts.get(r.id) ?? 0), `${dragged}→${slot}, room ${r.id}`)
            .toBe(expectedTop.get(r.id));
        }
      }
    }
  });
});

describe('clampRoomDragOffset', () => {
  it('passes an offset inside the rooms\' span through unchanged', () => {
    expect(clampRoomDragOffset(COLUMN, 'b', 20)).toBe(20);
    expect(clampRoomDragOffset(COLUMN, 'b', -30)).toBe(-30);
  });

  it('stops the carried room at the top edge of the first room', () => {
    expect(clampRoomDragOffset(COLUMN, 'b', -500)).toBe(-50);
  });

  it('stops the carried room at the bottom edge of the last room', () => {
    // Otherwise it slides out over the loose session cards below the rooms.
    expect(clampRoomDragOffset(COLUMN, 'b', 500)).toBe(50);
  });

  it('the first and last rooms cannot leave the span outward at all', () => {
    expect(clampRoomDragOffset(COLUMN, 'a', -20)).toBe(0);
    expect(clampRoomDragOffset(COLUMN, 'c', 20)).toBe(0);
  });

  it('does not move a room it cannot find', () => {
    expect(clampRoomDragOffset(COLUMN, 'nope', 42)).toBe(0);
  });
});

describe('roomDragHitY — the drop is aimed by the carried room, not the grip', () => {
  // The review case: an expanded room above a collapsed one above an expanded
  // one. The grip sits near a frame's TOP, so aiming by the pointer meant
  // carrying A 196px — until A's top reached B's top, B hidden beneath it the
  // whole way — before the slot moved at all.
  const TALL: RoomDragRect[] = [
    { id: 'a', top: 0, bottom: 190 },
    { id: 'b', top: 196, bottom: 230 },
    { id: 'c', top: 236, bottom: 386 },
  ];
  const slotFor = (rects: RoomDragRect[], id: string, dy: number) =>
    computeRoomInsertIndex(rects, roomDragHitY(rects, id, dy)!);

  it('carried DOWN, the hit point is the carried room\'s bottom edge', () => {
    expect(roomDragHitY(COLUMN, 'a', 30)).toBe(70);
  });

  it('carried UP, the hit point is the carried room\'s top edge', () => {
    expect(roomDragHitY(COLUMN, 'c', -30)).toBe(70);
  });

  it('carrying a tall room down passes a short one as soon as its bottom edge crosses that room\'s middle', () => {
    expect(slotFor(TALL, 'a', 22)).toBe(1); // bottom at 212, B's middle is 213: still a no-op
    expect(slotFor(TALL, 'a', 24)).toBe(2); // bottom at 214: A now lands after B
  });

  it('carrying a tall room up passes a short one as soon as its top edge crosses that room\'s middle', () => {
    expect(slotFor(TALL, 'c', -22)).toBe(2); // top at 214: still its own slot
    expect(slotFor(TALL, 'c', -24)).toBe(1); // top at 212: C now lands before B
  });

  it('at rest every room is a no-op drop', () => {
    TALL.forEach((r, from) => {
      expect([from, from + 1]).toContain(slotFor(TALL, r.id, 0));
    });
  });

  it('every position stays reachable within the carry clamp, for rooms of any height', () => {
    // A centre-based hit point would fail this: the clamp stops a tall room's
    // centre short of a short end room's centre, so it could never reach the
    // first or last slot.
    for (const rects of [TALL, COLUMN, [
      { id: 'a', top: 0, bottom: 30 },
      { id: 'b', top: 36, bottom: 336 },
      { id: 'c', top: 342, bottom: 372 },
      { id: 'd', top: 378, bottom: 478 },
    ]]) {
      const ids = rects.map((r) => r.id);
      for (const id of ids) {
        const lo = clampRoomDragOffset(rects, id, -1e6);
        const hi = clampRoomDragOffset(rects, id, 1e6);
        const orders = new Set<string>();
        for (let dy = lo; dy <= hi; dy += 1) {
          orders.add(applyRoomReorder(ids, id, slotFor(rects, id, dy)).join(','));
        }
        expect(orders.size, `room ${id} in [${ids}]`).toBe(ids.length);
      }
    }
  });

  it('returns null for a room it cannot find', () => {
    expect(roomDragHitY(COLUMN, 'nope', 10)).toBeNull();
  });
});
