// roomsListModel.test.ts — AASC-55: the phone's room grouping — folds kept per phone, where a dragged
// session lands, and the reorder a drag of room groups asks the Mac for.
import { describe, it, expect } from 'vitest';
import type { Room } from '@/types';
import {
  parseCollapsedRooms, pruneCollapsedRooms, reorderOpFor, roomDropTarget, sessionDropOp, toggleRoomCollapsed,
} from './roomsListModel';

const room = (id: string, over: Partial<Room> = {}): Room =>
  ({ id, name: id, sessionIds: [], collapsed: false, createdAt: 0, ...over });

describe('folded rooms (this phone only)', () => {
  it('reads ids from localStorage and treats anything malformed as none folded', () => {
    expect([...parseCollapsedRooms('["r1","r2"]')]).toEqual(['r1', 'r2']);
    expect([...parseCollapsedRooms('["r1",4,"",null]')]).toEqual(['r1']);
    for (const raw of [null, '', 'not json', '{"r1":true}', '"r1"']) expect(parseCollapsedRooms(raw).size).toBe(0);
    const many = JSON.stringify(Array.from({ length: 500 }, (_, i) => `r${i}`));
    expect(parseCollapsedRooms(many).size).toBe(200);
  });

  it('toggles into a new set, never changing the old one', () => {
    const before = new Set(['r1']);
    const after = toggleRoomCollapsed(before, 'r2');
    expect([...after]).toEqual(['r1', 'r2']);
    expect([...before]).toEqual(['r1']);
    expect([...toggleRoomCollapsed(after, 'r1')]).toEqual(['r2']);
  });

  it('forgets the fold of a room that is gone, and keeps the same set when nothing is', () => {
    const folded = new Set(['r1', 'gone']);
    expect([...pruneCollapsedRooms(folded, [room('r1')])]).toEqual(['r1']);
    const same = new Set(['r1']);
    expect(pruneCollapsedRooms(same, [room('r1'), room('r2')])).toBe(same);
  });
});

describe('dragging a session into a room', () => {
  const rects = [
    { roomId: 'r1', top: 100, bottom: 300 },
    { roomId: 'r2', top: 316, bottom: 400 },
    { roomId: null, top: 416, bottom: 600 },
  ];

  it('lands in the group under the finger, or nowhere between groups', () => {
    expect(roomDropTarget(rects, 150)?.roomId).toBe('r1');
    expect(roomDropTarget(rects, 350)?.roomId).toBe('r2');
    expect(roomDropTarget(rects, 500)?.roomId).toBeNull();
    expect(roomDropTarget(rects, 308)).toBeNull();
    expect(roomDropTarget(rects, 50)).toBeNull();
  });

  it('asks to move only when the room changes', () => {
    expect(sessionDropOp('s1', 'r1', rects[1])).toEqual({ type: 'move', sessionId: 's1', roomId: 'r2' });
    expect(sessionDropOp('s1', 'r1', rects[2])).toEqual({ type: 'move', sessionId: 's1', roomId: null });
    expect(sessionDropOp('s1', null, rects[0])).toEqual({ type: 'move', sessionId: 's1', roomId: 'r1' });
    expect(sessionDropOp('s1', 'r1', rects[0])).toBeNull();
    expect(sessionDropOp('s1', null, rects[2])).toBeNull();
    expect(sessionDropOp('s1', 'r1', null)).toBeNull();
  });
});

describe('reordering room groups', () => {
  const rooms = [room('a', { listOrder: 0 }), room('b', { listOrder: 1 }), room('c', { listOrder: 2 })];

  it('sends every room the phone has, the dragged ones in their new order', () => {
    expect(reorderOpFor(rooms, ['c', 'a', 'b'])).toEqual({ type: 'reorder', roomIds: ['c', 'a', 'b'] });
  });

  it('keeps a room with no group on screen (search, filter) in its slot', () => {
    // b has no group right now; a and c swap around it.
    expect(reorderOpFor(rooms, ['c', 'a'])).toEqual({ type: 'reorder', roomIds: ['c', 'b', 'a'] });
  });

  it('asks for nothing when nothing moves', () => {
    expect(reorderOpFor(rooms, ['a', 'b', 'c'])).toBeNull();
    expect(reorderOpFor(rooms, ['a', 'c'])).toBeNull();
  });
});
