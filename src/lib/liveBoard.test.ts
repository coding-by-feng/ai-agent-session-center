// liveBoard.test.ts — what the 3D-off LIVE page shows on a desktop: nothing
// until the sessions have loaded, a "how to start" card when there are none,
// otherwise a board of session cards in the same order as the panel's rail.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import {
  BOARD_FILTERS,
  boardCounts,
  boardSessions,
  holdOrder,
  liveFlatState,
  matchesBoardFilter,
  type BoardFilter,
} from './liveBoard';
import { isListedSession, numberedSessions } from './sessionSort';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, title: id, status: 'idle', events: [], promptHistory: [], ...over }) as unknown as Session;

describe('boardSessions — what the LIVE board lists', () => {
  it('leaves out ended sessions and floating AI popups, like the LIVE tab does', () => {
    const list = [s('live'), s('gone', { status: 'ended' }), s('popup', { isFloating: true })];
    expect(boardSessions(list).map((x) => x.sessionId)).toEqual(['live']);
    expect(list.filter(isListedSession).map((x) => x.sessionId)).toEqual(['live']);
  });

  it('orders the cards exactly as the rail numbers them: pinned, then by status, then by title', () => {
    const list = [
      s('b', { status: 'idle' }),
      s('a', { status: 'working' }),
      s('p', { status: 'idle', pinned: true }),
      s('c', { status: 'approval' }),
    ];
    const ids = boardSessions(list).map((x) => x.sessionId);
    expect(ids).toEqual(['p', 'a', 'c', 'b']);
    expect(ids).toEqual(numberedSessions(list).map((x) => x.sessionId));
  });

  it('accepts the store map values directly', () => {
    const map = new Map([['x', s('x')], ['y', s('y', { status: 'working' })]]);
    expect(boardSessions(map.values()).map((x) => x.sessionId)).toEqual(['y', 'x']);
  });
});

describe('the board filters', () => {
  it('offers All, Working and Needs you, in that order', () => {
    expect(BOARD_FILTERS.map((f) => f.label)).toEqual(['All', 'Working', 'Needs you']);
  });

  it.each<[string, BoardFilter, boolean]>([
    ['working', 'working', true],
    ['prompting', 'working', true],
    ['waiting', 'working', false],
    ['idle', 'working', false],
    ['approval', 'working', false],
    ['approval', 'needs-you', true],
    ['input', 'needs-you', true],
    ['working', 'needs-you', false],
    ['waiting', 'needs-you', false],
    ['idle', 'all', true],
    ['connecting', 'all', true],
  ])('a %s session matches %s: %s', (status, filter, expected) => {
    expect(matchesBoardFilter(status, filter)).toBe(expected);
  });

  it('counts every filter in one pass', () => {
    const list = [
      s('a', { status: 'working' }),
      s('b', { status: 'prompting' }),
      s('c', { status: 'approval' }),
      s('d', { status: 'input' }),
      s('e', { status: 'idle' }),
    ];
    expect(boardCounts(list)).toEqual({ all: 5, working: 2, 'needs-you': 2 });
    expect(boardCounts([])).toEqual({ all: 0, working: 0, 'needs-you': 0 });
  });
});

// While the pointer or keyboard focus is on the cards, the board keeps the order
// it had: a status change must not move a card from under a click.
describe('holdOrder — cards hold still while the user is on them', () => {
  const ids = (list: Session[]) => list.map((x) => x.sessionId);

  it('without a held order, it is the list as given', () => {
    const list = [s('a'), s('b')];
    expect(holdOrder(list, null)).toBe(list);
  });

  it('keeps the held order when the live order changes', () => {
    expect(ids(holdOrder([s('a'), s('b'), s('c')], ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('carries the latest session data in the held places', () => {
    const fresh = s('a', { status: 'approval' });
    const out = holdOrder([fresh, s('b')], ['b', 'a']);
    expect(out[1]).toBe(fresh);
  });

  it('drops a session that is gone and adds a new one at the end', () => {
    expect(ids(holdOrder([s('a'), s('new'), s('c')], ['c', 'gone', 'a']))).toEqual(['c', 'a', 'new']);
  });
});

describe('liveFlatState — what the 3D-off LIVE page shows', () => {
  it('shows nothing until the first session snapshot arrives, so a returning user never sees a "no sessions" flash', () => {
    expect(liveFlatState({ snapshotReceived: false, restoring: false, listedCount: 0 })).toBe('loading');
    expect(liveFlatState({ snapshotReceived: false, restoring: false, listedCount: 3 })).toBe('loading');
  });

  it('shows the empty state once loaded with nothing to list', () => {
    expect(liveFlatState({ snapshotReceived: true, restoring: false, listedCount: 0 })).toBe('empty');
  });

  it('holds the empty state back while a workspace restore is re-creating sessions', () => {
    expect(liveFlatState({ snapshotReceived: true, restoring: true, listedCount: 0 })).toBe('loading');
  });

  it('shows the board whenever something is listed, restore or not', () => {
    expect(liveFlatState({ snapshotReceived: true, restoring: false, listedCount: 2 })).toBe('board');
    expect(liveFlatState({ snapshotReceived: true, restoring: true, listedCount: 2 })).toBe('board');
  });
});
