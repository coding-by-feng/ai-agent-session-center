// sessionRekey.test.ts — spotting a session that re-keyed (/clear, a resume).
import { describe, it, expect } from 'vitest';
import { rekeyedSessions } from './sessionRekey';

const s = (sessionId: string, replacesId?: string) => ({ sessionId, replacesId });

describe('rekeyedSessions', () => {
  it('names the old and new id of a session that took over another\'s', () => {
    const prev = new Map([['a', s('a')], ['b', s('b')]]);
    const next = new Map([['a2', s('a2', 'a')], ['b', s('b')]]);
    expect(rekeyedSessions(prev, next)).toEqual([['a', 'a2']]);
  });

  it('ignores an old replacesId still carried by later updates, and unrelated changes', () => {
    const prev = new Map([['a2', s('a2', 'a')]]);
    expect(rekeyedSessions(prev, new Map([['a2', s('a2', 'a')]]))).toEqual([]);
    expect(rekeyedSessions(prev, prev)).toEqual([]);
    // The old one never seen here (hidden from this phone): nothing to follow.
    expect(rekeyedSessions(new Map(), new Map([['x2', s('x2', 'x')]]))).toEqual([]);
  });

  // Seen on a real iPhone (Oct 2026): a session's first re-key arrives as TWO updates 39 ms apart —
  // the new session without replacesId, then the same session with it, which drops the old entry.
  it('follows a re-key whose new session arrived one update before its replacesId', () => {
    const before = new Map([['term-1', s('term-1')]]);
    const first = new Map([['term-1', s('term-1')], ['c1', s('c1')]]);
    const second = new Map([['c1', s('c1', 'term-1')]]);
    expect(rekeyedSessions(before, first)).toEqual([]);
    expect(rekeyedSessions(first, second)).toEqual([['term-1', 'c1']]);
  });
});
