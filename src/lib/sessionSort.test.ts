import { describe, it, expect } from 'vitest';
import { sortSessions, sortSessionsByActivity, numberedSessions } from './sessionSort';
import type { Session } from '@/types/session';

function s(partial: Partial<Session>): Session {
  return { sessionId: partial.title, status: 'waiting', title: partial.title, ...partial } as Session;
}

describe('sortSessions', () => {
  it('floats pinned sessions to the top, then sorts by status, then title', () => {
    const list = [
      s({ title: 'b-working', status: 'working' }),
      s({ title: 'a-pinned-idle', status: 'idle', pinned: true }),
      s({ title: 'c-waiting', status: 'waiting' }),
      s({ title: 'd-pinned-working', status: 'working', pinned: true }),
    ];
    const sorted = sortSessions(list).map((x) => x.title);
    // Pinned first (ordered among themselves by status: working < idle), then the rest.
    expect(sorted).toEqual(['d-pinned-working', 'a-pinned-idle', 'b-working', 'c-waiting']);
  });

  it('keeps status/title ordering when nothing is pinned', () => {
    const list = [
      s({ title: 'z', status: 'waiting' }),
      s({ title: 'a', status: 'waiting' }),
      s({ title: 'busy', status: 'working' }),
    ];
    expect(sortSessions(list).map((x) => x.title)).toEqual(['busy', 'a', 'z']);
  });
});

describe('sortSessionsByActivity', () => {
  it('orders by lastActivityAt descending — most recently active first', () => {
    const list = [
      s({ title: 'old', lastActivityAt: 1_000 }),
      s({ title: 'newest', lastActivityAt: 9_000 }),
      s({ title: 'middle', lastActivityAt: 5_000 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual(['newest', 'middle', 'old']);
  });

  it('floats pinned sessions above every unpinned one, however recent', () => {
    const list = [
      s({ title: 'busiest', lastActivityAt: 9_999 }),
      s({ title: 'pinned-stale', lastActivityAt: 1, pinned: true }),
      s({ title: 'active', lastActivityAt: 5_000 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual([
      'pinned-stale',
      'busiest',
      'active',
    ]);
  });

  it('sorts pinned sessions among themselves by recency too', () => {
    const list = [
      s({ title: 'pin-old', lastActivityAt: 100, pinned: true }),
      s({ title: 'pin-new', lastActivityAt: 900, pinned: true }),
      s({ title: 'loose', lastActivityAt: 500 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual(['pin-new', 'pin-old', 'loose']);
  });

  it('ignores status entirely — a stale "working" sinks below a fresh "idle"', () => {
    const list = [
      s({ title: 'stale-working', status: 'working', lastActivityAt: 10 }),
      s({ title: 'fresh-idle', status: 'idle', lastActivityAt: 9_000 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual(['fresh-idle', 'stale-working']);
  });

  it('breaks ties on title so equal timestamps never shuffle between renders', () => {
    const list = [
      s({ title: 'zebra', lastActivityAt: 500 }),
      s({ title: 'apple', lastActivityAt: 500 }),
      s({ title: 'mango', lastActivityAt: 500 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('sinks sessions with a missing lastActivityAt to the bottom', () => {
    const list = [
      s({ title: 'no-timestamp', lastActivityAt: undefined as unknown as number }),
      s({ title: 'has-timestamp', lastActivityAt: 1 }),
    ];
    expect(sortSessionsByActivity(list).map((x) => x.title)).toEqual(['has-timestamp', 'no-timestamp']);
  });

  it('gives untitled sessions a total order, so status can never leak back in', () => {
    // Untitled sessions all collapse to the same title, so without a final
    // discriminator the stable sort falls back to input order — which upstream
    // is the *status* pre-sort. That would reorder the flat list on a pure
    // status change, in a mode whose whole point is to ignore status.
    const a = s({ sessionId: 'aaa', title: '', status: 'idle', lastActivityAt: 500 });
    const b = s({ sessionId: 'bbb', title: '', status: 'working', lastActivityAt: 500 });
    const fromOneOrder = sortSessionsByActivity([a, b]).map((x) => x.sessionId);
    const fromTheOther = sortSessionsByActivity([b, a]).map((x) => x.sessionId);
    expect(fromOneOrder).toEqual(fromTheOther);
    expect(fromOneOrder).toEqual(['aaa', 'bbb']);
  });

  it('does not mutate the input array', () => {
    const list = [
      s({ title: 'a', lastActivityAt: 1 }),
      s({ title: 'b', lastActivityAt: 2 }),
    ];
    const before = list.map((x) => x.title);
    sortSessionsByActivity(list);
    expect(list.map((x) => x.title)).toEqual(before);
  });
});

/**
 * The session numbers on the rail's cards. The badges, Alt+⌘+1…9 and the
 * "go to session #" jump all read this one order, so the number you type is
 * the number you see.
 */
describe('numberedSessions', () => {
  it('drops ended sessions and orders pinned, then status, then title', () => {
    const list = [
      s({ title: 'b-idle', status: 'idle' }),
      s({ title: 'gone', status: 'ended' }),
      s({ title: 'a-waiting', status: 'waiting' }),
      s({ title: 'z-pinned-idle', status: 'idle', pinned: true }),
      s({ title: 'c-working', status: 'working' }),
    ];
    expect(numberedSessions(list).map((x) => x.title)).toEqual(['z-pinned-idle', 'c-working', 'a-waiting', 'b-idle']);
  });

  it('falls back to the project name, then to nothing, like the rail always has', () => {
    // Not sessionDisplayTitle ("Unnamed"): an untitled, project-less card has
    // always sorted first among its status, and renumbering it would move
    // every badge after it.
    const list = [
      s({ sessionId: 'p', title: '', projectName: 'beta', status: 'idle' }),
      s({ sessionId: 'n', title: '', projectName: '', status: 'idle' }),
      s({ sessionId: 't', title: 'alpha', status: 'idle' }),
    ];
    expect(numberedSessions(list).map((x) => x.sessionId)).toEqual(['n', 't', 'p']);
  });

  it('does not reorder its input', () => {
    const list = [s({ title: 'b' }), s({ title: 'a' })];
    numberedSessions(list);
    expect(list.map((x) => x.title)).toEqual(['b', 'a']);
  });
});
