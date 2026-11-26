// alertNotify.test.ts — what a loud session shows besides its sounds (Nov 23 2026); which sessions do is their alert
// level's (Nov 25 2026): notification "every moment" and the glowing card.
import { describe, it, expect } from 'vitest';
import { alertNotice, isAlerting, newAlertMoments, shouldShowAlert, type AlertSession } from './alertNotify';

type Test = AlertSession & { loud?: boolean };
const s = (sessionId: string, status: string, over: Partial<Test> = {}): Test =>
  ({ sessionId, status, loud: true, title: sessionId, ...over });
/** The level's notify setting, as useAlertNotifications reads it: here, a session's `loud`. */
const notifies = (t: Test) => t.loud === true;

describe('newAlertMoments', () => {
  it('fires when a notifying session finishes or needs you, never on a first sighting', () => {
    const first = newAlertMoments(new Map(), [s('a', 'waiting'), s('b', 'approval')], notifies);
    expect(first.moments).toEqual([]);
    const working = newAlertMoments(first.seen, [s('a', 'working'), s('b', 'working')], notifies);
    expect(working.moments).toEqual([]);
    const back = newAlertMoments(working.seen, [s('a', 'waiting'), s('b', 'approval')], notifies);
    expect(back.moments).toEqual([{ sessionId: 'a', kind: 'done' }, { sessionId: 'b', kind: 'approval' }]);
  });

  it('fires once per moment, and approval → input is a new one', () => {
    const a = newAlertMoments(new Map([['a', null]]), [s('a', 'approval')], notifies);
    expect(newAlertMoments(a.seen, [s('a', 'approval')], notifies).moments).toEqual([]);
    expect(newAlertMoments(a.seen, [s('a', 'input')], notifies).moments).toEqual([{ sessionId: 'a', kind: 'input' }]);
  });

  it('a session whose level does not notify never fires, but its moment is still seen', () => {
    const quiet = newAlertMoments(new Map([['a', null]]), [s('a', 'waiting', { loud: false })], notifies);
    expect(quiet.moments).toEqual([]);
    expect(quiet.seen.get('a')).toBe('done');
  });
});

describe('shouldShowAlert', () => {
  const away = { focused: false, openSessionId: 'a', notify: 'all' as const };
  it('shows while it still stands, whatever Mute said', () => {
    expect(shouldShowAlert({ ...s('a', 'waiting'), muted: true } as AlertSession, 'done', away)).toBe(true);
  });
  it('not once answered, moved on, or its level stopped notifying every moment', () => {
    expect(shouldShowAlert(s('a', 'working'), 'approval', away)).toBe(false);
    expect(shouldShowAlert(s('a', 'approval'), 'approval', { ...away, notify: 'proceed' })).toBe(false);
    expect(shouldShowAlert(s('a', 'approval'), 'approval', { ...away, notify: 'none' })).toBe(false);
    expect(shouldShowAlert(undefined, 'done', away)).toBe(false);
  });
  it('not while you are looking at that session in a focused window', () => {
    expect(shouldShowAlert(s('a', 'waiting'), 'done', { ...away, focused: true, openSessionId: 'a' })).toBe(false);
    expect(shouldShowAlert(s('a', 'waiting'), 'done', { ...away, focused: true, openSessionId: 'b' })).toBe(true);
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
  const ring = { isCurrent: false, finishedUnseen: false, glow: true };
  it('rings a glowing card that finished unseen or needs you, never the open one or one whose level does not glow', () => {
    expect(isAlerting(s('a', 'waiting'), { ...ring, finishedUnseen: true })).toBe(true);
    expect(isAlerting(s('a', 'approval'), ring)).toBe(true);
    expect(isAlerting(s('a', 'waiting'), ring)).toBe(false);
    expect(isAlerting(s('a', 'approval'), { ...ring, isCurrent: true })).toBe(false);
    expect(isAlerting(s('a', 'approval'), { ...ring, glow: false })).toBe(false);
  });
});
