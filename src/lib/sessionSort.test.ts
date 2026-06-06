import { describe, it, expect } from 'vitest';
import { sortSessions } from './sessionSort';
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
