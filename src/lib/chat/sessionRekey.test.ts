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
});
