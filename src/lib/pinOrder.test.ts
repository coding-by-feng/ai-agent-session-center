import { describe, it, expect } from 'vitest';
import { nextPinOrder, placeVisiblePins, planPinnedOrder } from './pinOrder';

// PINNED drag (Nov 18 2026): the server keeps each pinned card's place as `pinOrder`.
describe('nextPinOrder', () => {
  it('puts a new pin after every placed one', () => {
    expect(nextPinOrder([{ pinned: true, pinOrder: 2 }, { pinned: true, pinOrder: 5 }, { pinned: false, pinOrder: 9 }])).toBe(6);
  });

  it('starts at 1, and counts unplaced pins so the new one still lands last', () => {
    expect(nextPinOrder([])).toBe(1);
    expect(nextPinOrder([{ pinned: true }, { pinned: true }])).toBe(3);
    expect(nextPinOrder([{ pinned: true, pinOrder: 1 }, { pinned: true }])).toBe(3);
  });
});

describe('planPinnedOrder', () => {
  const pinned = [
    { sessionId: 'a', pinOrder: 1 },
    { sessionId: 'b', pinOrder: 2 },
    { sessionId: 'c', pinOrder: 3 },
    { sessionId: 'd' },
  ];

  it('numbers the listed ids 1..N in the given order, then the rest in their old order', () => {
    expect([...planPinnedOrder(pinned, ['c', 'a'])]).toEqual([['c', 1], ['a', 2], ['b', 3], ['d', 4]]);
  });

  it('ignores ids that are not pinned and repeats', () => {
    expect([...planPinnedOrder(pinned, ['x', 'b', 'b', 'a'])]).toEqual([['b', 1], ['a', 2], ['c', 3], ['d', 4]]);
  });
});

// A phone sees only the sessions shared with it (Nov 18 2026): its reorder must not move the rest.
describe('placeVisiblePins', () => {
  const pinned = [
    { sessionId: 'a', pinOrder: 1 },
    { sessionId: 'h1', pinOrder: 2 },
    { sessionId: 'b', pinOrder: 3 },
    { sessionId: 'h2', pinOrder: 4 },
    { sessionId: 'c', pinOrder: 5 },
  ];
  const visible = (id: string) => !id.startsWith('h');

  it('refills the visible pins\' slots in the new order and leaves every hidden pin in its slot', () => {
    expect(placeVisiblePins(pinned, ['c', 'a', 'b'], visible)).toEqual(['c', 'h1', 'a', 'h2', 'b']);
  });

  it('a visible pin left out keeps its relative place after the listed ones', () => {
    expect(placeVisiblePins(pinned, ['b'], visible)).toEqual(['b', 'h1', 'a', 'h2', 'c']);
  });

  it('ignores hidden, unknown and repeated ids in the request', () => {
    expect(placeVisiblePins(pinned, ['h2', 'x', 'c', 'c', 'a'], visible)).toEqual(['c', 'h1', 'a', 'h2', 'b']);
  });

  it('with everything visible it is the plain order', () => {
    expect(placeVisiblePins(pinned, ['c', 'a'], () => true)).toEqual(['c', 'a', 'h1', 'b', 'h2']);
  });
});
