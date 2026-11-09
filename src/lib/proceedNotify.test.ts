import { describe, expect, it } from 'vitest';
import { newProceedAsks, proceedNotice, shouldShowProceed, type ProceedSession } from './proceedNotify';

const s = (sessionId: string, over: Partial<ProceedSession> = {}): ProceedSession =>
  ({ sessionId, status: 'waiting', pendingProceedAt: null, title: `T ${sessionId}`, ...over });

describe('newProceedAsks', () => {
  it('a session seen for the first time never counts (a launch or reconnect brings every P back)', () => {
    const { asks } = newProceedAsks(new Map(), [s('a', { pendingProceedAt: 5 })]);
    expect(asks).toEqual([]);
  });

  it('counts a session whose "proceed" ask is new since the last look, once', () => {
    const first = newProceedAsks(new Map(), [s('a'), s('b')]);
    const second = newProceedAsks(first.seen, [s('a', { pendingProceedAt: 7 }), s('b')]);
    expect(second.asks).toEqual([{ sessionId: 'a', askedAt: 7 }]);
    expect(newProceedAsks(second.seen, [s('a', { pendingProceedAt: 7 }), s('b')]).asks).toEqual([]);
  });

  it('a later ask by the same session counts again', () => {
    let seen = newProceedAsks(new Map(), [s('a', { pendingProceedAt: 7 })]).seen;
    seen = newProceedAsks(seen, [s('a', { status: 'working' })]).seen;
    expect(newProceedAsks(seen, [s('a', { pendingProceedAt: 9 })]).asks).toEqual([{ sessionId: 'a', askedAt: 9 }]);
  });

  it('ignores an ask on a session that is not waiting or idle', () => {
    const seen = newProceedAsks(new Map(), [s('a')]).seen;
    expect(newProceedAsks(seen, [s('a', { status: 'working', pendingProceedAt: 3 })]).asks).toEqual([]);
  });

  it('forgets sessions that are gone', () => {
    const seen = newProceedAsks(new Map(), [s('a'), s('b')]).seen;
    expect([...newProceedAsks(seen, [s('b')]).seen.keys()]).toEqual(['b']);
  });
});

describe('shouldShowProceed', () => {
  const ctx = { enabled: true, focused: false, openSessionId: null };

  it('shows a still-owed ask', () => {
    expect(shouldShowProceed(s('a', { pendingProceedAt: 7 }), 7, ctx)).toBe(true);
    expect(shouldShowProceed(s('a', { status: 'idle', pendingProceedAt: 7 }), 7, ctx)).toBe(true);
  });

  it('not once a prompt answered it, a newer ask replaced it, or the session is gone', () => {
    expect(shouldShowProceed(s('a', { status: 'prompting' }), 7, ctx)).toBe(false);
    expect(shouldShowProceed(s('a', { pendingProceedAt: 9 }), 7, ctx)).toBe(false);
    expect(shouldShowProceed(undefined, 7, ctx)).toBe(false);
  });

  it('not for a muted session, nor with the setting off', () => {
    expect(shouldShowProceed(s('a', { pendingProceedAt: 7, muted: true }), 7, ctx)).toBe(false);
    expect(shouldShowProceed(s('a', { pendingProceedAt: 7 }), 7, { ...ctx, enabled: false })).toBe(false);
  });

  it('not while the user is looking at that very session; yes for another one', () => {
    const looking = { enabled: true, focused: true, openSessionId: 'a' };
    expect(shouldShowProceed(s('a', { pendingProceedAt: 7 }), 7, looking)).toBe(false);
    expect(shouldShowProceed(s('b', { pendingProceedAt: 7 }), 7, looking)).toBe(true);
    expect(shouldShowProceed(s('a', { pendingProceedAt: 7 }), 7, { ...looking, focused: false })).toBe(true);
  });
});

describe('proceedNotice', () => {
  it('the session name and what it waits for; no answer text', () => {
    expect(proceedNotice(s('abc-1', { title: 'KTS' }))).toEqual({
      sessionId: 'abc-1', title: 'KTS', body: 'Waiting for you to proceed',
    });
  });

  it('flattens and clips a long or odd name', () => {
    const notice = proceedNotice(s('a', { title: `line\none\t${'x'.repeat(200)}` }));
    expect(notice.title.startsWith('line one x')).toBe(true);
    expect(notice.title.length).toBeLessThanOrEqual(80);
  });
});
