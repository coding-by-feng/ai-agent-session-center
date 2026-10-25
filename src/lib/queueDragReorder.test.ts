import { describe, it, expect } from 'vitest';
import {
  computeInsertIndex,
  applyReorder,
  rebaseInsertIndex,
  computeGridInsertIndex,
  computeGridShifts,
  clampGridDragOffset,
  type DragRect,
} from './queueDragReorder';

/** Three 100x50 cards side by side, as in the wrapping Card grid. */
const ROW: DragRect[] = [
  { id: 1, left: 0, right: 100, top: 0, bottom: 50 },
  { id: 2, left: 110, right: 210, top: 0, bottom: 50 },
  { id: 3, left: 220, right: 320, top: 0, bottom: 50 },
];

/** Three full-width rows stacked, as in List mode. */
const COLUMN: DragRect[] = [
  { id: 1, left: 0, right: 300, top: 0, bottom: 40 },
  { id: 2, left: 0, right: 300, top: 50, bottom: 90 },
  { id: 3, left: 0, right: 300, top: 100, bottom: 140 },
];

describe('computeInsertIndex — grid (items share a row → X axis)', () => {
  it('left half of the first card inserts before it', () => {
    expect(computeInsertIndex(ROW, 20, 25)).toBe(0);
  });

  it('right half of the first card inserts after it', () => {
    expect(computeInsertIndex(ROW, 80, 25)).toBe(1);
  });

  it('left half of the middle card inserts before it', () => {
    expect(computeInsertIndex(ROW, 130, 25)).toBe(1);
  });

  it('right half of the last card inserts at the end', () => {
    expect(computeInsertIndex(ROW, 300, 25)).toBe(3);
  });

  it('a pointer in the gap resolves to the nearer card, not to nothing', () => {
    // Hit-testing would return "no target" here — precisely where the user is
    // aiming when dropping between two cards.
    expect(computeInsertIndex(ROW, 105, 25)).toBe(1);
  });

  it('past the right edge of the row still resolves to the end', () => {
    expect(computeInsertIndex(ROW, 999, 25)).toBe(3);
  });
});

describe('computeInsertIndex — list (one item per row → Y axis)', () => {
  it('top half of the first row inserts before it', () => {
    expect(computeInsertIndex(COLUMN, 150, 5)).toBe(0);
  });

  it('bottom half of the first row inserts after it', () => {
    expect(computeInsertIndex(COLUMN, 150, 35)).toBe(1);
  });

  it('bottom half of the last row inserts at the end', () => {
    expect(computeInsertIndex(COLUMN, 150, 135)).toBe(3);
  });

  it('uses the vertical axis even when X is far off to one side', () => {
    // The axis is chosen by layout, not by pointer position: a full-width row
    // has no horizontal meaning, so a wide X must not flip the answer.
    expect(computeInsertIndex(COLUMN, 295, 5)).toBe(0);
  });
});

describe('computeInsertIndex — degenerate input', () => {
  it('returns 0 for an empty queue', () => {
    expect(computeInsertIndex([], 10, 10)).toBe(0);
  });

  it('handles a single item, using the VERTICAL axis', () => {
    // A lone card shares its row with nothing, so by the rule it is treated
    // as list-like and split top/bottom — not left/right. Worth pinning: the
    // first version of this test varied X and failed, which is the rule
    // working correctly rather than a bug.
    const one = [ROW[0]]; // top 0, bottom 50 → midpoint y = 25
    expect(computeInsertIndex(one, 50, 10)).toBe(0);
    expect(computeInsertIndex(one, 50, 40)).toBe(1);
  });
});

describe('applyReorder', () => {
  const ids = [1, 2, 3, 4];

  it('moves an item BACKWARD to the requested slot', () => {
    expect(applyReorder(ids, 4, 1)).toEqual([1, 4, 2, 3]);
  });

  it('moves an item FORWARD accounting for its own removal', () => {
    // THE off-by-one: insertIndex 3 is measured with item 1 still present.
    // Splicing at 3 after removing it would land past the intended slot.
    expect(applyReorder(ids, 1, 3)).toEqual([2, 3, 1, 4]);
  });

  it('moves an item to the very end', () => {
    expect(applyReorder(ids, 1, 4)).toEqual([2, 3, 4, 1]);
  });

  it('moves an item to the very front', () => {
    expect(applyReorder(ids, 4, 0)).toEqual([4, 1, 2, 3]);
  });

  it('is a no-op when dropped in its own slot', () => {
    expect(applyReorder(ids, 2, 1)).toBe(ids);
  });

  it('is a no-op when dropped just after itself', () => {
    // Same visual position — must not churn the queue or trigger a write.
    expect(applyReorder(ids, 2, 2)).toBe(ids);
  });

  it('returns the input unchanged for an unknown id', () => {
    expect(applyReorder(ids, 99, 0)).toBe(ids);
  });

  it('never drops or duplicates an item', () => {
    for (let target = 0; target <= ids.length; target++) {
      for (const id of ids) {
        const out = applyReorder(ids, id, target);
        expect([...out].sort()).toEqual([1, 2, 3, 4]);
      }
    }
  });
});

describe('rebaseInsertIndex — a drop lands before the row it was shown before (Oct 21 2026)', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

  it('is the slot itself when the queue did not change', () => {
    for (let i = 0; i <= rows.length; i++) expect(rebaseInsertIndex(rows, 3, i, [1, 2, 3, 4])).toBe(i);
  });

  it('follows the row when the queue shrank under the drag', () => {
    expect(rebaseInsertIndex(rows, 4, 1, [2, 3, 4])).toBe(0); // before 2, now first
  });

  it('takes the next row still there when the one it was shown before left', () => {
    expect(rebaseInsertIndex(rows, 1, 2, [1, 2, 4])).toBe(2); // 3 left: before 4
    expect(rebaseInsertIndex(rows, 1, 3, [1, 2, 3])).toBe(3); // 4 left: the end
  });

  it('is -1 when the dragged prompt itself is gone', () => {
    expect(rebaseInsertIndex(rows, 2, 0, [1, 3, 4])).toBe(-1);
  });
});

/** A Card grid three columns wide: 100×80 cards 10 apart, the second row one card short.
 *  Centres: 1 (50,40) 2 (160,40) 3 (270,40) / 4 (50,130) 5 (160,130); the empty cell's is (270,130). */
const GRID: DragRect[] = [
  { id: 1, left: 0, right: 100, top: 0, bottom: 80 },
  { id: 2, left: 110, right: 210, top: 0, bottom: 80 },
  { id: 3, left: 220, right: 320, top: 0, bottom: 80 },
  { id: 4, left: 0, right: 100, top: 90, bottom: 170 },
  { id: 5, left: 110, right: 210, top: 90, bottom: 170 },
];

describe('computeGridInsertIndex — a carried card takes the place of the nearest card (Oct 22 2026)', () => {
  it('at rest it lands where it is', () => {
    expect(computeGridInsertIndex(GRID, 2, 160, 40)).toBe(1);
  });

  it('carried forward onto a card, it takes that card’s place', () => {
    expect(computeGridInsertIndex(GRID, 1, 160, 40)).toBe(2);
    expect(applyReorder([1, 2, 3, 4, 5], 1, 2)).toEqual([2, 1, 3, 4, 5]);
  });

  it('carried back onto a card, it takes that card’s place', () => {
    expect(computeGridInsertIndex(GRID, 5, 160, 40)).toBe(1);
    expect(applyReorder([1, 2, 3, 4, 5], 5, 1)).toEqual([1, 5, 2, 3, 4]);
  });

  it('changes place once its centre is past halfway to the next card', () => {
    expect(computeGridInsertIndex(GRID, 1, 104, 40)).toBe(0); // 54 from its own centre, 56 from 2's
    expect(computeGridInsertIndex(GRID, 1, 106, 40)).toBe(2); // 56 from its own, 54 from 2's
  });

  it('reaches across rows: onto the first card of the next row', () => {
    expect(computeGridInsertIndex(GRID, 3, 50, 130)).toBe(4);
    expect(applyReorder([1, 2, 3, 4, 5], 3, 4)).toEqual([1, 2, 4, 3, 5]);
  });

  it('the empty cells after the last card are the end of the queue', () => {
    expect(computeGridInsertIndex(GRID, 1, 270, 130)).toBe(5);
    expect(computeGridInsertIndex(GRID, 1, 300, 150)).toBe(5);
  });

  it('the last card carried into the empty cells after it stays where it is', () => {
    expect(computeGridInsertIndex(GRID, 5, 270, 130)).toBe(5); // from + 1: a no-op slot
    expect(applyReorder([1, 2, 3, 4, 5], 5, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a full last row has no empty cell: its last card is the end', () => {
    expect(computeGridInsertIndex(GRID.slice(0, 3), 1, 270, 40)).toBe(3);
  });

  it('one column (a narrow panel) orders top to bottom', () => {
    const column: DragRect[] = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 80 },
      { id: 2, left: 0, right: 100, top: 90, bottom: 170 },
      { id: 3, left: 0, right: 100, top: 180, bottom: 260 },
    ];
    expect(computeGridInsertIndex(column, 1, 50, 130)).toBe(2);
    expect(computeGridInsertIndex(column, 3, 50, 130)).toBe(1);
  });
});

describe('computeGridShifts — the cards a carried one passes step one cell toward its old place', () => {
  it('nothing moves at rest or over either no-op slot', () => {
    expect(computeGridShifts(GRID, 2, null).size).toBe(0);
    expect(computeGridShifts(GRID, 2, 1).size).toBe(0);
    expect(computeGridShifts(GRID, 2, 2).size).toBe(0);
  });

  it('carried forward, each passed card steps back a cell, the first of a row up to the end of the one above', () => {
    expect([...computeGridShifts(GRID, 2, 4)]).toEqual([
      [3, { x: -110, y: 0 }],
      [4, { x: 220, y: -90 }],
    ]);
  });

  it('carried back, each passed card steps forward a cell, the last of a row down to the start of the next', () => {
    expect([...computeGridShifts(GRID, 5, 2)]).toEqual([
      [3, { x: -220, y: 90 }],
      [4, { x: 110, y: 0 }],
    ]);
  });

  it('carried to the end, every card after it steps back one cell', () => {
    const shifts = computeGridShifts(GRID, 1, 5);
    expect([...shifts.keys()]).toEqual([2, 3, 4, 5]);
    expect(shifts.get(5)).toEqual({ x: -110, y: 0 });
  });
});

describe('clampGridDragOffset — a carried card stays over the cards', () => {
  it('passes an offset inside the grid through', () => {
    expect(clampGridDragOffset(GRID, 1, 60, 20)).toEqual({ x: 60, y: 20 });
  });

  it('stops at the edges of the box the cards cover', () => {
    expect(clampGridDragOffset(GRID, 1, 2000, 2000)).toEqual({ x: 220, y: 90 });
    expect(clampGridDragOffset(GRID, 5, -2000, -2000)).toEqual({ x: -110, y: -90 });
  });

  it('is no offset for a card that was not measured', () => {
    expect(clampGridDragOffset(GRID, 99, 50, 50)).toEqual({ x: 0, y: 0 });
  });
});
