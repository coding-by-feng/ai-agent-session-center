// alertNotify.test.ts — what an alerted session shows besides its sounds (Nov 23 2026).
import { describe, it, expect } from 'vitest';
import { alertNotice, isAlerting, newAlertMoments, shouldShowAlert, type AlertSession } from './alertNotify';

const s = (sessionId: string, status: string, over: Partial<AlertSession> = {}): AlertSession =>
  ({ sessionId, status, alerted: true, title: sessionId, ...over });

describe('newAlertMoments', () => {
  it('fires when an alerted session finishes or needs you, never on a first sighting', () => {
    const first = newAlertMoments(new Map(), [s('a', 'waiting'), s('b', 'approval')]);
    expect(first.moments).toEqual([]);
    const working = newAlertMoments(first.seen, [s('a', 'working'), s('b', 'working')]);
    expect(working.moments).toEqual([]);
    const back = newAlertMoments(working.seen, [s('a', 'waiting'), s('b', 'approval')]);
    expect(back.moments).toEqual([{ sessionId: 'a', kind: 'done' }, { sessionId: 'b', kind: 'approval' }]);
  });

  it('fires once per moment, and approval → input is a new one', () => {
    const a = newAlertMoments(new Map([['a', null]]), [s('a', 'approval')]);
    expect(newAlertMoments(a.seen, [s('a', 'approval')]).moments).toEqual([]);
    expect(newAlertMoments(a.seen, [s('a', 'input')]).moments).toEqual([{ sessionId: 'a', kind: 'input' }]);
  });

  it('a session without Alert never fires', () => {
    expect(newAlertMoments(new Map([['a', null]]), [s('a', 'waiting', { alerted: false })]).moments).toEqual([]);
    expect(newAlertMoments(new Map([['a', null]]), [s('a', 'waiting', { alerted: undefined })]).moments).toEqual([]);
  });
});

describe('shouldShowAlert', () => {
  const away = { focused: false, openSessionId: 'a' };
  it('shows while it still stands, over Mute', () => {
    expect(shouldShowAlert({ ...s('a', 'waiting'), muted: true } as AlertSession, 'done', away)).toBe(true);
  });
  it('not once answered, moved on, or Alert turned off', () => {
    expect(shouldShowAlert(s('a', 'working'), 'approval', away)).toBe(false);
    expect(shouldShowAlert(s('a', 'approval', { alerted: false }), 'approval', away)).toBe(false);
    expect(shouldShowAlert(undefined, 'done', away)).toBe(false);
  });
  it('not while you are looking at that session in a focused window', () => {
    expect(shouldShowAlert(s('a', 'waiting'), 'done', { focused: true, openSessionId: 'a' })).toBe(false);
    expect(shouldShowAlert(s('a', 'waiting'), 'done', { focused: true, openSessionId: 'b' })).toBe(true);
  });
});

describe('alertNotice', () => {
  it('names the session and the moment, never the answer', () => {
    expect(alertNotice(s('a', 'approval', { title: 'AI\nWeekly  Video' }), 'approval'))
      .toEqual({ sessionId: 'a', title: 'AI Weekly Video', body: 'Needs your approval' });
    expect(alertNotice(s('a', 'waiting'), 'done').body).toBe('Finished — ready for review');
    expect(alertNotice(s('a', 'waiting', { pendingProceedAt: 5 }), 'done').body).toBe('Finished — waiting for you to proceed');
  });
});

describe('isAlerting (the card ring)', () => {
  it('rings an alerted card that finished unseen or needs you, never the open one or an unalerted one', () => {
    expect(isAlerting(s('a', 'waiting'), { isCurrent: false, finishedUnseen: true })).toBe(true);
    expect(isAlerting(s('a', 'approval'), { isCurrent: false, finishedUnseen: false })).toBe(true);
    expect(isAlerting(s('a', 'waiting'), { isCurrent: false, finishedUnseen: false })).toBe(false);
    expect(isAlerting(s('a', 'approval'), { isCurrent: true, finishedUnseen: false })).toBe(false);
    expect(isAlerting(s('a', 'approval', { alerted: false }), { isCurrent: false, finishedUnseen: false })).toBe(false);
  });
});
