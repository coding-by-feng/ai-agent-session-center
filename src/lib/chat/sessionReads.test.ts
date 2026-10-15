// sessionReads.test.ts — this phone's "read" stamps per session (AASC-40).
import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_READS, SESSION_READS_KEY, getSessionReads, markSessionRead, resetSessionReadsForTest } from './sessionReads';

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

  it(`keeps the newest ${MAX_READS} stamps`, () => {
    for (let i = 0; i < MAX_READS + 5; i++) markSessionRead(`s${i}`, i + 1);
    const kept = getSessionReads();
    expect(Object.keys(kept)).toHaveLength(MAX_READS);
    expect(kept.s0).toBeUndefined();
    expect(kept[`s${MAX_READS + 4}`]).toBe(MAX_READS + 5);
  });
});
