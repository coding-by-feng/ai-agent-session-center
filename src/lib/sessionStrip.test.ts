// sessionStrip.test.ts — what the strip and the phone's drawer list, and the
// order the phone's swipe walks (AASC-18).
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import { buildStripItems, filterByRooms, neighbourSession, stripSessionOrder } from './sessionStrip';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, title: id, status: 'idle', projectPath: `/w/${id}`, events: [], promptHistory: [], ...over }) as unknown as Session;

const room = (id: string, sessionIds: string[], over: Partial<Room> = {}): Room =>
  ({ id, name: id, sessionIds, collapsed: false, createdAt: 0, ...over });

const ids = (list: Session[]) => list.map((x) => x.sessionId);

describe('buildStripItems', () => {
  const all = [s('a'), s('b'), s('c'), s('d')];
  const rooms = [room('R2', ['c'], { listOrder: 1 }), room('R1', ['a', 'b'], { listOrder: 0 })];

  it('Rooms view: RECENT first, then rooms in list order, then the loose sessions', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: ['d', 'a'] });
    expect(items.map((i) => i.type)).toEqual(['recent', 'room', 'room', 'session']);
    expect(items[0].type === 'recent' && ids(items[0].sessions)).toEqual(['d', 'a']);
    expect(items[1].type === 'room' && items[1].room.id).toBe('R1');
    expect(items[2].type === 'room' && items[2].room.id).toBe('R2');
    expect(items[3].type === 'session' && items[3].session.sessionId).toBe('d');
  });

  it('Recent activity view: one flat list, no frames', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'activity', recentIds: ['a'] });
    expect(items.every((i) => i.type === 'session')).toBe(true);
    expect(items).toHaveLength(4);
  });

  it('Projects view: one frame per project directory, no rooms and no RECENT', () => {
    const list = [s('a', { projectPath: '/w/app' }), s('b', { projectPath: '/w/app' }), s('c', { projectPath: '' })];
    const items = buildStripItems({ filtered: list, all: list, rooms, mode: 'project', recentIds: ['a'] });
    expect(items.map((i) => i.type)).toEqual(['project', 'session']);
    expect(items[0].type === 'project' && ids(items[0].group.sessions)).toEqual(['a', 'b']);
  });

  it('the room filter narrows the list, RECENT included', () => {
    const filtered = filterByRooms(all, new Set(['R2']), rooms);
    expect(ids(filtered)).toEqual(['c']);
    const items = buildStripItems({ filtered, all, rooms, mode: 'room', recentIds: ['d', 'c'] });
    expect(items[0].type === 'recent' && ids(items[0].sessions)).toEqual(['c']);
  });
});

describe('stripSessionOrder — the swipe order', () => {
  it('walks the frames as drawn, skips RECENT (its sessions stay in their rooms), and lists each session once', () => {
    const all = [s('a'), s('b'), s('c'), s('d')];
    const rooms = [room('R1', ['b', 'c'])];
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: ['d', 'b'] });
    expect(stripSessionOrder(items)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('counts a folded room: folding hides cards, not sessions', () => {
    const all = [s('a'), s('b')];
    const items = buildStripItems({ filtered: all, all, rooms: [room('R1', ['b'], { collapsed: true })], mode: 'room', recentIds: [] });
    expect(stripSessionOrder(items)).toEqual(['b', 'a']);
  });
});

describe('neighbourSession', () => {
  const order = ['a', 'b', 'c'];
  it('steps forward and back', () => {
    expect(neighbourSession(order, 'b', 1)).toBe('c');
    expect(neighbourSession(order, 'b', -1)).toBe('a');
  });
  it('stops at either end rather than wrapping', () => {
    expect(neighbourSession(order, 'c', 1)).toBeNull();
    expect(neighbourSession(order, 'a', -1)).toBeNull();
  });
  it('a session not in the list steps onto the first or last', () => {
    expect(neighbourSession(order, 'x', 1)).toBe('a');
    expect(neighbourSession(order, 'x', -1)).toBe('c');
    expect(neighbourSession([], 'x', 1)).toBeNull();
  });
});
