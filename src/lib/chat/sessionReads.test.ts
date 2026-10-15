// sessionReads.test.ts — this phone's "read" stamps per session (AASC-40).
import { describe, it, expect, beforeEach } from 'vitest';
import type { Session } from '@/types';
import { MAX_READS, SESSION_READS_KEY, getSessionReads, markSessionRead, moveSessionRead, readStamp, resetSessionReadsForTest } from './sessionReads';
import { useSessionStore } from '@/stores/sessionStore';

describe('sessionReads', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSessionReadsForTest();
  });

  it('stamps a session read and keeps it in storage', () => {
    markSessionRead('s1', 100);
    expect(getSessionReads()).toEqual({ s1: 100 });
    expect(JSON.parse(localStorage.getItem(SESSION_READS_KEY) ?? '{}')).toEqual({ s1: 100 });
  });

  it('never moves a stamp back in time', () => {
    markSessionRead('s1', 200);
    markSessionRead('s1', 100);
    expect(getSessionReads().s1).toBe(200);
  });

  it('reads back what was saved, dropping anything malformed', () => {
    localStorage.setItem(SESSION_READS_KEY, JSON.stringify({ a: 5, b: 'x', c: null }));
    resetSessionReadsForTest();
    expect(getSessionReads()).toEqual({ a: 5 });
    localStorage.setItem(SESSION_READS_KEY, '{nope');
    resetSessionReadsForTest();
    expect(getSessionReads()).toEqual({});
  });

  it('stamps on the Mac\'s clock (the session\'s own last activity)', () => {
    expect(readStamp({ lastActivityAt: 1234 })).toBe(1234);
  });

  it('reads the session on show as each turn finishes', () => {
    const s = (status: string, lastActivityAt: number) => ({ sessionId: 's9', status, lastActivityAt }) as unknown as Session;
    useSessionStore.setState({ sessions: new Map([['s9', s('working', 10)]]), selectedSessionId: 's9' });
    expect(getSessionReads().s9).toBeUndefined();
    useSessionStore.setState({ sessions: new Map([['s9', s('waiting', 20)]]) });
    expect(getSessionReads().s9).toBe(20);
    useSessionStore.setState({ selectedSessionId: null });
    useSessionStore.setState({ sessions: new Map([['s9', s('waiting', 30)]]) });
    expect(getSessionReads().s9).toBe(20);
  });

  it('moves a stamp to a session\'s new id when it re-keys', () => {
    markSessionRead('old', 40);
    moveSessionRead('old', 'new');
    expect(getSessionReads().new).toBe(40);
    moveSessionRead('never-read', 'x');
    expect(getSessionReads().x).toBeUndefined();
  });

  it(`keeps the newest ${MAX_READS} stamps`, () => {
    for (let i = 0; i < MAX_READS + 5; i++) markSessionRead(`s${i}`, i + 1);
    const kept = getSessionReads();
    expect(Object.keys(kept)).toHaveLength(MAX_READS);
    expect(kept.s0).toBeUndefined();
    expect(kept[`s${MAX_READS + 4}`]).toBe(MAX_READS + 5);
  });
});
