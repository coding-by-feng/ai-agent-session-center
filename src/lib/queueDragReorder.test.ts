import { describe, it, expect } from 'vitest';
import { computeInsertIndex, applyReorder, type DragRect } from './queueDragReorder';

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
