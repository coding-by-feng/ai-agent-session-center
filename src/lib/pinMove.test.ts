// The phone's Move up / Move down in Pinned (Nov 18 2026): the order a step sends to setPinnedOrder.
import { describe, it, expect } from 'vitest';
import { pinnedMoveOrder, pinnedPlace } from './pinMove';
import type { Session } from '@/types';

const s = (sessionId: string, extra: Partial<Session> = {}) =>
  ({ sessionId, status: 'idle', title: sessionId, ...extra }) as Session;
const sessions = [
  s('loose'),
  s('b', { pinned: true, pinOrder: 2 }),
  s('a', { pinned: true, pinOrder: 1 }),
  s('gone', { pinned: true, pinOrder: 3, status: 'ended' }),
  s('c', { pinned: true, pinOrder: 4 }),
];

describe('pinnedPlace', () => {
  it('is the place in PINNED as listed (pinOrder), ended and unpinned sessions left out', () => {
    expect(pinnedPlace(sessions, 'a')).toEqual({ index: 0, count: 3 });
    expect(pinnedPlace(sessions, 'c')).toEqual({ index: 2, count: 3 });
    expect(pinnedPlace(sessions, 'loose')).toBeNull();
    expect(pinnedPlace(sessions, 'gone')).toBeNull();
  });
});

describe('pinnedMoveOrder', () => {
  it('swaps the card with its neighbour', () => {
    expect(pinnedMoveOrder(sessions, 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(pinnedMoveOrder(sessions, 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('is null past either end, and for a session that is not in PINNED', () => {
    expect(pinnedMoveOrder(sessions, 'a', -1)).toBeNull();
    expect(pinnedMoveOrder(sessions, 'c', 1)).toBeNull();
    expect(pinnedMoveOrder(sessions, 'loose', 1)).toBeNull();
  });
});
