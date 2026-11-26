// urgentRepeat.test.ts — a repeating level reminds you of a moment you have not handled (Nov 25 2026).
import { describe, it, expect } from 'vitest';
import { reminderNotice, reminderStep, remindsByNotification, type ReminderState } from './urgentRepeat';
import type { AlertSession } from './alertNotify';

type Test = AlertSession & { repeat?: number };
const s = (sessionId: string, status: string, over: Partial<Test> = {}): Test =>
  ({ sessionId, status, repeat: 5, title: sessionId, ...over });
const MIN = 60_000;
const EMPTY: ReminderState = { seen: new Map(), owed: new Map() };

/** One look at `sessions` at `now`, nobody looking unless `lookingAt` says so. */
function look(state: ReminderState, sessions: Test[], now: number, lookingAt: string | null = null) {
  return reminderStep(state, { sessions, now, lookingAt, repeatMinOf: (t) => t.repeat ?? 0 });
}

/** A session seen working at 0, then reaching `status` at 1 s. */
function arrived(status: string, over: Partial<Test> = {}) {
  const first = look(EMPTY, [s('a', 'working', over)], 0);
  return look(first.state, [s('a', status, over)], 1_000);
}

describe('reminderStep', () => {
  it('owes a moment that arrives under a repeating level, and reminds every repeatMin until it stops standing', () => {
    const start = arrived('approval');
    expect(start.due).toEqual([]);
    expect(start.state.owed.get('a')).toEqual({ kind: 'approval', lastAt: 1_000 });

    expect(look(start.state, [s('a', 'approval')], 1_000 + 4 * MIN).due).toEqual([]);
    const first = look(start.state, [s('a', 'approval')], 1_000 + 5 * MIN);
    expect(first.due).toEqual([{ sessionId: 'a', kind: 'approval' }]);
    const again = look(first.state, [s('a', 'approval')], 1_000 + 7 * MIN);
    expect(again.due).toEqual([]);
    expect(look(again.state, [s('a', 'approval')], 1_000 + 10 * MIN).due).toEqual([{ sessionId: 'a', kind: 'approval' }]);
  });

  it('never owes a first sighting: a launch, reconnect or restore brings nothing back', () => {
    const first = look(EMPTY, [s('a', 'approval'), s('b', 'waiting')], 0);
    expect(first.state.owed.size).toBe(0);
    expect(look(first.state, [s('a', 'approval'), s('b', 'waiting')], 60 * MIN).due).toEqual([]);
  });

  it('a finished turn stays owed while the session waits or decays to idle, and ends with the next prompt', () => {
    const done = arrived('waiting');
    expect(done.state.owed.get('a')?.kind).toBe('done');
    const idle = look(done.state, [s('a', 'idle')], 1_000 + 5 * MIN);
    expect(idle.due).toEqual([{ sessionId: 'a', kind: 'done' }]);
    expect(look(idle.state, [s('a', 'prompting')], 1_000 + 20 * MIN).state.owed.has('a')).toBe(false);
  });

  it('an answered approval or question is no longer owed', () => {
    expect(look(arrived('approval').state, [s('a', 'working')], 2_000).state.owed.has('a')).toBe(false);
    expect(look(arrived('input').state, [s('a', 'working')], 2_000).state.owed.has('a')).toBe(false);
  });

  it('approval → input is a new moment, owed from when it arrived', () => {
    const next = look(arrived('approval').state, [s('a', 'input')], 3 * MIN);
    expect(next.state.owed.get('a')).toEqual({ kind: 'input', lastAt: 3 * MIN });
  });

  it('looking at the session (open in a focused window) settles it, and a moment arriving in view is never owed', () => {
    const seen = look(arrived('approval').state, [s('a', 'approval')], 2 * MIN, 'a');
    expect(seen.state.owed.has('a')).toBe(false);
    expect(look(seen.state, [s('a', 'approval')], 10 * MIN).due).toEqual([]);

    const first = look(EMPTY, [s('a', 'working')], 0);
    const inView = look(first.state, [s('a', 'waiting')], 1_000, 'a');
    expect(inView.state.owed.has('a')).toBe(false);
  });

  it('a level that does not repeat owes nothing, and lowering the level drops what was owed', () => {
    expect(arrived('approval', { repeat: 0 }).state.owed.has('a')).toBe(false);
    const lowered = look(arrived('approval').state, [s('a', 'approval', { repeat: 0 })], 10 * MIN);
    expect(lowered.due).toEqual([]);
    expect(lowered.state.owed.has('a')).toBe(false);
  });

  it('a session that is gone or ended is dropped', () => {
    expect(look(arrived('approval').state, [], 10 * MIN).state.owed.size).toBe(0);
    expect(look(arrived('waiting').state, [s('a', 'ended')], 10 * MIN).state.owed.size).toBe(0);
  });
});

describe('remindsByNotification', () => {
  it('every moment for "all"; for "proceed" only a proceed ask, and only with the setting on', () => {
    const plain = s('a', 'waiting');
    const ask = s('a', 'waiting', { pendingProceedAt: 5 });
    expect(remindsByNotification(plain, 'approval', 'all', false)).toBe(true);
    expect(remindsByNotification(plain, 'done', 'proceed', true)).toBe(false);
    expect(remindsByNotification(ask, 'done', 'proceed', true)).toBe(true);
    expect(remindsByNotification(ask, 'done', 'proceed', false)).toBe(false);
    expect(remindsByNotification(ask, 'done', 'none', true)).toBe(false);
  });
});

describe('reminderNotice', () => {
  it('says it is a reminder, names the session, never the answer', () => {
    expect(reminderNotice(s('a', 'approval'), 'approval')).toEqual({ sessionId: 'a', title: 'a', body: 'Reminder · Needs your approval' });
  });
});
