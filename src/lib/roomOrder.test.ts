// roomOrder.test.ts — AASC-55: a reorder from a device that sees only some rooms lands in the whole list,
// writes listOrder only, and never moves a room's 3D slot (roomIndex).
import { describe, it, expect } from 'vitest';
import type { Room } from '@/types';
import { listOrdersAfterReorder, mergeRoomOrder, roomsInListOrder, stepRoom } from './roomOrder';

const room = (id: string, over: Partial<Room> = {}): Room =>
  ({ id, name: id, sessionIds: [], collapsed: false, createdAt: 0, ...over });

describe('roomsInListOrder', () => {
  it('ranks by listOrder, then the 3D slot, then array order; never changes its input', () => {
    const rooms = [room('c'), room('b', { roomIndex: 1 }), room('a', { listOrder: 0, roomIndex: 9 }), room('d')];
    const before = JSON.stringify(rooms);
    expect(roomsInListOrder(rooms).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(JSON.stringify(rooms)).toBe(before);
  });
});

describe('mergeRoomOrder', () => {
  it('puts the wanted ids in the slots they hold now; the others keep theirs', () => {
    // A phone sees a, b, c; the hidden room h sits between them on the Mac.
    expect(mergeRoomOrder(['a', 'h', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'h', 'a', 'b']);
  });

  it('ignores unknown ids and repeats, and returns the same array when nothing moves', () => {
    const ordered = ['a', 'b', 'c'];
    expect(mergeRoomOrder(ordered, ['a', 'zz', 'a', 'b'])).toBe(ordered);
    expect(mergeRoomOrder(ordered, [])).toBe(ordered);
    expect(mergeRoomOrder(ordered, ['b', 'zz', 'a'])).toEqual(['b', 'a', 'c']);
  });
});

describe('listOrdersAfterReorder', () => {
  it('stamps a dense 0..N-1 over every room and never touches roomIndex', () => {
    const rooms = [room('a', { roomIndex: 0 }), room('h', { roomIndex: 1 }), room('b', { roomIndex: 2 })];
    const orders = listOrdersAfterReorder(rooms, ['b', 'a']);
    expect(orders && Object.fromEntries(orders)).toEqual({ b: 0, h: 1, a: 2 });
    expect(rooms.map((r) => r.roomIndex)).toEqual([0, 1, 2]);
  });

  it('is null when nothing moves: a repeated, stale or unknown request writes nothing', () => {
    const rooms = [room('a', { listOrder: 0 }), room('b', { roomIndex: 7 })];
    expect(listOrdersAfterReorder(rooms, ['a', 'b'])).toBeNull();
    expect(listOrdersAfterReorder(rooms, ['zz'])).toBeNull();
  });
});

describe('stepRoom', () => {
  it('moves a room one step, and is null at the ends or for an unknown room', () => {
    expect(stepRoom(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(stepRoom(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(stepRoom(['a', 'b'], 'a', -1)).toBeNull();
    expect(stepRoom(['a', 'b'], 'b', 1)).toBeNull();
    expect(stepRoom(['a'], 'x', 1)).toBeNull();
  });
});
