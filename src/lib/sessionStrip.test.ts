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

  it('Projects view: one frame per project directory and no rooms, under RECENT', () => {
    const list = [s('a', { projectPath: '/w/app' }), s('b', { projectPath: '/w/app' }), s('c', { projectPath: '' })];
    const items = buildStripItems({ filtered: list, all: list, rooms, mode: 'project', recentIds: ['a'] });
    expect(items.map((i) => i.type)).toEqual(['recent', 'project', 'session']);
    expect(items[0].type === 'recent' && ids(items[0].sessions)).toEqual(['a']);
    expect(items[1].type === 'project' && ids(items[1].group.sessions)).toEqual(['a', 'b']);
  });

  it('Projects view: no RECENT when nothing is recent', () => {
    const list = [s('a', { projectPath: '/w/app' })];
    const items = buildStripItems({ filtered: list, all: list, rooms, mode: 'project', recentIds: [] });
    expect(items.map((i) => i.type)).toEqual(['project']);
  });

  it('the room filter narrows the list, RECENT included', () => {
    const filtered = filterByRooms(all, new Set(['R2']), rooms);
    expect(ids(filtered)).toEqual(['c']);
    const items = buildStripItems({ filtered, all, rooms, mode: 'room', recentIds: ['d', 'c'] });
    expect(items[0].type === 'recent' && ids(items[0].sessions)).toEqual(['c']);
  });
});

describe('buildStripItems — the PINNED frame', () => {
  const all = [s('a', { pinned: true }), s('b'), s('c', { pinned: true }), s('d')];
  const rooms = [room('R1', ['a', 'b']), room('R2', ['c'])];

  it('goes first, above RECENT, and lists the pinned sessions in strip order', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: ['d'], showPinned: true });
    expect(items.map((i) => i.type)).toEqual(['pinned', 'recent', 'room', 'room', 'session']);
    expect(items[0].type === 'pinned' && ids(items[0].sessions)).toEqual(['a', 'c']);
  });

  it('leaves each pinned session in its own room too', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [], showPinned: true });
    expect(items[1].type === 'room' && ids(items[1].sessions)).toEqual(['a', 'b']);
  });

  it('is absent unless asked for: the phone never asks', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [] });
    expect(items.some((i) => i.type === 'pinned')).toBe(false);
  });

  it('is absent when nothing is pinned', () => {
    const none = [s('b'), s('d')];
    const items = buildStripItems({ filtered: none, all: none, rooms, mode: 'room', recentIds: [], showPinned: true });
    expect(items.some((i) => i.type === 'pinned')).toBe(false);
  });

  it('is absent in the activity view', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'activity', recentIds: [], showPinned: true });
    expect(items.some((i) => i.type === 'pinned')).toBe(false);
  });

  describe('in the Projects view', () => {
    const paths = [s('a', { pinned: true, projectPath: '/w/app' }), s('b', { projectPath: '/w/app' }), s('c', { pinned: true, projectPath: '/w/site' }), s('d', { projectPath: '' })];

    it('goes above RECENT and the project frames, pinned sessions from every project in strip order', () => {
      const items = buildStripItems({ filtered: paths, all: paths, rooms, mode: 'project', recentIds: ['d'], showPinned: true });
      expect(items.map((i) => i.type)).toEqual(['pinned', 'recent', 'project', 'project', 'session']);
      expect(items[0].type === 'pinned' && ids(items[0].sessions)).toEqual(['a', 'c']);
    });

    it('leaves each pinned session in its project frame too', () => {
      const items = buildStripItems({ filtered: paths, all: paths, rooms, mode: 'project', recentIds: [], showPinned: true });
      expect(items[1].type === 'project' && ids(items[1].group.sessions)).toEqual(['a', 'b']);
    });

    it('obeys the Pinned room toggle', () => {
      const items = buildStripItems({ filtered: paths, all: paths, rooms, mode: 'project', recentIds: [], showPinned: false });
      expect(items.some((i) => i.type === 'pinned')).toBe(false);
    });

    it('follows the room filter', () => {
      const filtered = filterByRooms(paths, new Set(['R2']), rooms);
      const items = buildStripItems({ filtered, all: paths, rooms, mode: 'project', recentIds: [], showPinned: true });
      expect(items[0].type === 'pinned' && ids(items[0].sessions)).toEqual(['c']);
    });

    it('is skipped by the swipe order, as RECENT is: their sessions stay in their project frames', () => {
      const items = buildStripItems({ filtered: paths, all: paths, rooms, mode: 'project', recentIds: ['b'], showPinned: true });
      expect(stripSessionOrder(items)).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  it('follows the room filter', () => {
    const filtered = filterByRooms(all, new Set(['R2']), rooms);
    const items = buildStripItems({ filtered, all, rooms, mode: 'room', recentIds: [], showPinned: true });
    expect(items[0].type === 'pinned' && ids(items[0].sessions)).toEqual(['c']);
  });
});

describe('buildStripItems — the CENTRAL frame', () => {
  const G = { centralId: 'c1', kind: 'global', scopeRef: null } as const;
  const all = [s('a', { pinned: true }), s('b', { central: { ...G } }), s('c', { central: { ...G, centralId: 'c2' } }), s('d')];
  const rooms = [room('R1', ['a', 'b']), room('R2', ['c'])];

  it('goes first, above PINNED and RECENT, and lists the central sessions in strip order', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: ['d'], showPinned: true, showCentral: true });
    expect(items.map((i) => i.type)).toEqual(['central', 'pinned', 'recent', 'room', 'room', 'session']);
    expect(items[0].type === 'central' && ids(items[0].sessions)).toEqual(['b', 'c']);
  });

  it('leaves each central in its own room too', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [], showCentral: true });
    expect(items[1].type === 'room' && ids(items[1].sessions)).toEqual(['a', 'b']);
  });

  it('is absent unless asked for: the phone never asks', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [] });
    expect(items.some((i) => i.type === 'central')).toBe(false);
  });

  it('is absent when no session is a central', () => {
    const none = [s('a'), s('d')];
    const items = buildStripItems({ filtered: none, all: none, rooms, mode: 'room', recentIds: [], showCentral: true });
    expect(items.some((i) => i.type === 'central')).toBe(false);
  });

  it.each(['activity', 'project'] as const)('is absent in the %s view', (mode) => {
    const items = buildStripItems({ filtered: all, all, rooms, mode, recentIds: [], showCentral: true });
    expect(items.some((i) => i.type === 'central')).toBe(false);
  });

  it('follows the room filter', () => {
    const filtered = filterByRooms(all, new Set(['R2']), rooms);
    const items = buildStripItems({ filtered, all, rooms, mode: 'room', recentIds: [], showCentral: true });
    expect(items[0].type === 'central' && ids(items[0].sessions)).toEqual(['c']);
  });

  it('is skipped by the swipe order: its sessions stay in their rooms', () => {
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [], showCentral: true });
    expect(stripSessionOrder(items)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('stripSessionOrder — the swipe order', () => {
  it('walks the frames as drawn, skips RECENT (its sessions stay in their rooms), and lists each session once', () => {
    const all = [s('a'), s('b'), s('c'), s('d')];
    const rooms = [room('R1', ['b', 'c'])];
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: ['d', 'b'] });
    expect(stripSessionOrder(items)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('skips PINNED too: its sessions stay in their rooms', () => {
    const all = [s('a', { pinned: true }), s('b'), s('c', { pinned: true })];
    const rooms = [room('R1', ['b', 'c'])];
    const items = buildStripItems({ filtered: all, all, rooms, mode: 'room', recentIds: [], showPinned: true });
    expect(stripSessionOrder(items)).toEqual(['b', 'c', 'a']);
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
