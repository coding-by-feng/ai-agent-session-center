// liveBoard.test.ts — what the 3D-off LIVE page shows on a desktop: nothing
// until the sessions have loaded, a "how to start" card when there are none,
// otherwise a board of session cards in the same order as the panel's rail.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import {
  BOARD_FILTERS,
  BOARD_NOTE_MAX_CHARS,
  COMMON_AREA,
  boardCounts,
  boardNote,
  boardSessions,
  cardRoom,
  holdOrder,
  liveFlatState,
  matchesBoardFilter,
  quietFor,
  roomBySession,
  type BoardFilter,
} from './liveBoard';
import { ROOM_COLOR_PALETTE } from './roomColor';
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

const room = (id: string, name: string, sessionIds: string[], roomIndex?: number): Room =>
  ({ id, name, sessionIds, collapsed: false, createdAt: 1, roomIndex }) as Room;

describe('roomBySession — which room holds each session', () => {
  it('maps every session id to the room that lists it', () => {
    const a = room('r1', 'Research', ['s1', 's2'], 0);
    const b = room('r2', 'Build', ['s3'], 1);
    const map = roomBySession([a, b]);
    expect(map.get('s1')).toBe(a);
    expect(map.get('s2')).toBe(a);
    expect(map.get('s3')).toBe(b);
    expect(map.get('nobody')).toBeUndefined();
  });

  it('lets the first room win when two list the same session, like getRoomForSession', () => {
    const first = room('r1', 'First', ['s1']);
    const second = room('r2', 'Second', ['s1']);
    expect(roomBySession([first, second]).get('s1')).toBe(first);
  });

  it('is empty when there are no rooms', () => {
    expect(roomBySession([]).size).toBe(0);
  });
});

describe('cardRoom — the room chip on a card', () => {
  it('names the room and takes its colour from the slot the strip uses', () => {
    expect(cardRoom(room('r', 'Research A', [], 2), true)).toEqual({
      name: 'Research A',
      color: ROOM_COLOR_PALETTE[2],
    });
  });

  it('gives a room that was left blank a name rather than an empty chip', () => {
    expect(cardRoom(room('r', '   ', [], 0), true)?.name).toBe('Unnamed room');
  });

  it('calls a session in no room "Common Area", with no colour, once any room exists', () => {
    expect(COMMON_AREA).toBe('Common Area');
    expect(cardRoom(undefined, true)).toEqual({ name: COMMON_AREA, color: null });
  });

  it('shows nothing for a session in no room while there are no rooms at all', () => {
    expect(cardRoom(undefined, false)).toBeNull();
  });
});

describe('boardNote — the line under a card\'s title', () => {
  const prompts = (...texts: string[]) => texts.map((text, i) => ({ text, timestamp: i + 1 }));

  it('prefers the remark the user wrote', () => {
    const note = boardNote(s('a', { remark: 'waiting on the client', promptHistory: prompts('fix the cart') }));
    expect(note).toEqual({ kind: 'remark', text: 'waiting on the client' });
  });

  it('otherwise shows the latest prompt', () => {
    const note = boardNote(s('a', { promptHistory: prompts('first', 'fix the cart total') }));
    expect(note).toEqual({ kind: 'prompt', text: 'fix the cart total' });
  });

  it('skips prompts the harness injected (they start with "<") and uses the last one a person typed', () => {
    const note = boardNote(
      s('a', {
        promptHistory: prompts(
          'fix the cart total',
          '<task-notification>done</task-notification>',
          '  <command-name>/clear</command-name>',
        ),
      }),
    );
    expect(note).toEqual({ kind: 'prompt', text: 'fix the cart total' });
  });

  it('is null when nothing a person wrote is there to show', () => {
    expect(boardNote(s('a'))).toBeNull();
    expect(boardNote(s('a', { remark: '   ', promptHistory: prompts('<x>', '   ') }))).toBeNull();
  });

  it('falls back to currentPrompt when the history is empty', () => {
    expect(boardNote(s('a', { currentPrompt: 'resume the import' }))).toEqual({
      kind: 'prompt',
      text: 'resume the import',
    });
  });

  it('turns line breaks and runs of spaces into single spaces, so it stays one line', () => {
    const note = boardNote(s('a', { promptHistory: prompts('fix the\n\n  cart\ttotal') }));
    expect(note?.text).toBe('fix the cart total');
  });

  it('cuts a long prompt to the render cap and says so with an ellipsis', () => {
    const note = boardNote(s('a', { promptHistory: prompts('word '.repeat(100)) }));
    expect(note?.text.length).toBeLessThanOrEqual(BOARD_NOTE_MAX_CHARS + 1);
    expect(note?.text.endsWith('…')).toBe(true);
  });

  it('leaves a prompt that exactly fits alone', () => {
    const exact = 'x'.repeat(BOARD_NOTE_MAX_CHARS);
    expect(boardNote(s('a', { promptHistory: prompts(exact) }))?.text).toBe(exact);
  });
});

describe('malformed data never takes the board down', () => {
  // Rooms come back from localStorage and prompts over the wire: one odd entry must not throw during render.
  it('boardNote skips prompt entries whose text is not a string', () => {
    const odd = s('a', {
      promptHistory: [{ text: 'fix the cart', timestamp: 1 }, { text: 42, timestamp: 2 }, { timestamp: 3 }, null] as never,
    });
    expect(boardNote(odd)).toEqual({ kind: 'prompt', text: 'fix the cart' });
  });

  it('boardNote ignores a remark or currentPrompt that is not a string', () => {
    expect(boardNote(s('a', { remark: 7, currentPrompt: { x: 1 } } as never))).toBeNull();
  });

  it('boardNote copes with a session that has no promptHistory at all', () => {
    expect(boardNote(s('a', { promptHistory: undefined } as never))).toBeNull();
  });

  it('cardRoom gives a room with no usable name a name', () => {
    expect(cardRoom({ id: 'r', sessionIds: [] } as unknown as Room, true)?.name).toBe('Unnamed room');
    expect(cardRoom({ id: 'r', name: 5, sessionIds: [] } as unknown as Room, true)?.name).toBe('Unnamed room');
  });

  it('roomBySession skips a room whose sessionIds is missing and still maps the rest', () => {
    const ok = room('r2', 'ok', ['s1']);
    const map = roomBySession([{ id: 'r1', name: 'broken' } as unknown as Room, ok]);
    expect(map.get('s1')).toBe(ok);
  });
});

describe('quietFor — how long a quiet session has been quiet', () => {
  const NOW = 100 * 3_600_000;
  const stoppedAgo = (agoMs: number, over: Partial<Session> = {}) =>
    s('a', { status: 'idle', events: [{ type: 'Stop', timestamp: NOW - agoMs, detail: '' }], ...over });

  it.each<[number, string]>([
    [10_000, '<1m'],
    [59_999, '<1m'],
    [60_000, '1m'],
    [14 * 60_000, '14m'],
    [59 * 60_000, '59m'],
    [60 * 60_000, '1h'],
    [23 * 3_600_000 + 59 * 60_000, '23h'],
    [24 * 3_600_000, '1d'],
    [3 * 86_400_000 + 5 * 3_600_000, '3d'],
  ])('%i ms after its last work reads %s', (agoMs, text) => {
    expect(quietFor(stoppedAgo(agoMs), NOW)).toBe(text);
  });

  it.each(['idle', 'waiting', 'approval', 'input'])('is shown for a %s session', (status) => {
    expect(quietFor(stoppedAgo(5 * 60_000, { status: status as Session['status'] }), NOW)).toBe('5m');
  });

  it.each(['working', 'prompting', 'connecting', 'ended'])('is not shown for a %s session', (status) => {
    expect(quietFor(stoppedAgo(5 * 60_000, { status: status as Session['status'] }), NOW)).toBeNull();
  });

  it('measures from the last work, not lastActivityAt, which a workspace restore stamps on every session', () => {
    const restored = stoppedAgo(3 * 3_600_000, { lastActivityAt: NOW - 1_000 });
    expect(quietFor(restored, NOW)).toBe('3h');
  });

  it('counts the prompt event itself as work', () => {
    const asked = s('a', { status: 'waiting', events: [{ type: 'UserPromptSubmit', timestamp: NOW - 4 * 60_000, detail: '' }] });
    expect(quietFor(asked, NOW)).toBe('4m');
  });

  // After a workspace restore the server reloads promptHistory from the database
  // with its ORIGINAL timestamps, while the session's events start over. Reading
  // the prompt would make the age as long as the last turn plus the quiet time.
  const restoredMarkers = [
    { type: 'TerminalCreated', timestamp: NOW - 60_000, detail: '' },
    { type: 'SessionStart', timestamp: NOW - 59_000, detail: '' },
  ];

  it('shows nothing for a restored session: the prompts it got back say nothing about when the agent last worked', () => {
    const restored = s('a', {
      status: 'idle',
      events: restoredMarkers,
      promptHistory: [{ text: 'build the pdf', timestamp: NOW - 3 * 3_600_000 }],
    });
    expect(quietFor(restored, NOW)).toBeNull();
  });

  it('starts counting from the first work after the restore', () => {
    const resumed = s('a', {
      status: 'waiting',
      events: [...restoredMarkers, { type: 'Stop', timestamp: NOW - 2 * 60_000, detail: '' }],
      promptHistory: [{ text: 'build the pdf', timestamp: NOW - 3 * 3_600_000 }],
    });
    expect(quietFor(resumed, NOW)).toBe('2m');
  });

  it('is not shown for a session with no recorded work to measure from', () => {
    expect(quietFor(s('a', { status: 'idle', lastActivityAt: NOW }), NOW)).toBeNull();
  });

  it('never reads negative when the server clock is ahead of this one', () => {
    expect(quietFor(stoppedAgo(-30_000), NOW)).toBe('<1m');
  });
});
