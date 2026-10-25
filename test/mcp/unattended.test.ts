// test/mcp/unattended.test.ts — Ruling 42, the helper (server/mcp/unattended.ts). A central starts no unattended run in
// a session it did not open itself: `assertMayStartUnattended` refuses (DENIED) everywhere but in the calling central's
// own worker (Ruling P4-12, server/mcp/workers.ts), the one place it is relaxed. `turnsOnUnattended` says which
// automation changes turn an unattended send ON (autoSend, autoEnter, autoResume); turning one OFF is always allowed.
//
// Rulings 43, 52 and 53 send more changes through the same helper, each with its own words, and the predicates here
// say which: a change to a prompt that is ON, a move that reorders the prompts that are on, quiet hours taken away,
// more resume attempts, a guard turned off and a new resume prompt.
import { describe, expect, it, vi } from 'vitest';
import { SteerRefusal } from '../../server/mcp/policy.js';
import {
  assertMayStartUnattended,
  isEnabledPrompt,
  loosensAutomation,
  onlyAddsQuietHours,
  raisesResumeRetries,
  reordersEnabled,
  turnsOnUnattended,
  UNATTENDED_SWITCHES,
} from '../../server/mcp/unattended.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { automationOf, item, queueOf, refusalOf } from './queueFixtures.js';
import { makeCentral, makeCtx, makeRoom, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** What the person is told, word for word (Ruling 42). */
const HINT = 'Only you can turn this on in AASC; a central can do it only in a session it opened itself';

describe('assertMayStartUnattended', () => {
  it('refuses with DENIED and the hint the person reads, for a global central', () => {
    const s = makeSession('s1', { terminalId: 'term-s1' });
    const { ctx } = makeCtx({ sessions: [s] });

    const err = refusalOf(() => assertMayStartUnattended(ctx, s));

    expect(err.code).toBe('DENIED');
    expect(err.hint).toBe(HINT);
  });

  it('refuses for a room central on a session its own room lists, and for a project central on one in its folder', () => {
    const s = makeSession('s1', { terminalId: 'term-s1', projectPath: '/a/proj' });
    const room = makeCtx({ central: makeCentral('room', 'r1'), sessions: [s], rooms: [makeRoom('r1', ['s1'])] });
    const project = makeCtx({ central: makeCentral('project', '/a/proj'), sessions: [s] });

    expect(refusalOf(() => assertMayStartUnattended(room.ctx, s)).code).toBe('DENIED');
    expect(refusalOf(() => assertMayStartUnattended(project.ctx, s)).code).toBe('DENIED');
  });

  it('unattended lock passes for an own worker and refuses any other', () => {
    const mine = makeSession('cli-mine', { terminalId: 'term-w1' });
    const theirs = makeSession('cli-theirs', { terminalId: 'term-w2' });
    const person = makeSession('s3', { terminalId: 'term-s3' });
    const workers = createWorkerRegistry({ controller: () => null });
    const opened = { openedAt: NOW - 60_000, folder: '/a/proj', cli: 'claude' as const };
    workers.add({ centralId: 'central-1', terminalId: 'term-w1', ...opened });
    workers.add({ centralId: 'central-2', terminalId: 'term-w2', ...opened });
    const { ctx } = makeCtx({
      central: makeCentral('room', 'r1'),
      sessions: [mine, theirs, person],
      rooms: [makeRoom('r1', ['cli-theirs', 's3'])],
      workers,
    });

    // Its own worker, re-keyed and filed in no room: in scope, and every kind of change goes through.
    expect(ctx.inScope(mine)).toBe(true);
    for (const change of ['start', 'enabledPrompt', 'loosen'] as const) {
      expect(() => assertMayStartUnattended(ctx, mine, change), change).not.toThrow();
    }
    // Another central's worker (in this central's room) and a person's session stay locked.
    for (const s of [theirs, person]) {
      expect(ctx.inScope(s), s.sessionId).toBe(true);
      expect(refusalOf(() => assertMayStartUnattended(ctx, s)).code, s.sessionId).toBe('DENIED');
    }
    // Once a person drives it, it is no longer the central's own: locked again.
    workers.release('term-w1', 'adopted');
    expect(refusalOf(() => assertMayStartUnattended(ctx, mine)).code).toBe('DENIED');
  });

  it('refuses whatever the session is like: it is a rule about centrals, not about one session’s state', () => {
    const states = [
      makeSession('a', { terminalId: 'term-a', status: 'idle' }),
      makeSession('b', { terminalId: 'term-b', status: 'working' }),
      makeSession('c', { terminalId: 'term-c', status: 'approval' }),
      makeSession('d', { terminalId: 'term-d', handsOff: true }),
      makeSession('e', { terminalId: null }),
    ];
    const { ctx } = makeCtx({ sessions: states });

    for (const s of states) expect(refusalOf(() => assertMayStartUnattended(ctx, s)).code, s.sessionId).toBe('DENIED');
  });

  it('is a SteerRefusal that carries the session for the log, and its words name neither the session nor a value', () => {
    const s = makeSession('abcdef-secret-id', { terminalId: 'term-x', title: 'TOP SECRET plan' });
    const { ctx } = makeCtx({ sessions: [s] });

    const err = refusalOf(() => assertMayStartUnattended(ctx, s));

    expect(err).toBeInstanceOf(SteerRefusal);
    expect((err as SteerRefusal).sessionId).toBe('abcdef-secret-id');
    expect(`${err.message} ${err.hint}`).not.toMatch(/abcdef-secret-id|TOP SECRET/);
  });

  it('changes nothing it is given', () => {
    const s = Object.freeze(makeSession('s1', { terminalId: 'term-s1' }));
    const { ctx } = makeCtx({ sessions: [s] });

    expect(() => assertMayStartUnattended(ctx, s)).toThrow();
  });
});

describe('turnsOnUnattended', () => {
  it('names exactly the three switches that make the window send without being asked', () => {
    expect([...UNATTENDED_SWITCHES].sort()).toEqual(['autoEnter', 'autoResume', 'autoSend']);
  });

  it.each(['autoSend', 'autoEnter', 'autoResume'])('is true when %s is turned on', (name) => {
    expect(turnsOnUnattended({ [name]: true })).toBe(true);
  });

  it('is false when they are turned off or left out: turning one off is always allowed', () => {
    expect(turnsOnUnattended({})).toBe(false);
    expect(turnsOnUnattended({ autoSend: false, autoEnter: false, autoResume: false })).toBe(false);
    expect(turnsOnUnattended({ autoSend: undefined, autoEnter: undefined, autoResume: undefined })).toBe(false);
  });

  it('is true when one is turned on among others turned off: the whole change is the unattended one', () => {
    expect(turnsOnUnattended({ autoEnter: false, autoResume: true })).toBe(true);
  });
});

describe('assertMayStartUnattended, for what Rulings 43 and 53 add', () => {
  const s = makeSession('s1', { terminalId: 'term-s1' });
  const { ctx } = makeCtx({ sessions: [s] });

  it('is DENIED for each kind of change, in words of its own, carrying the session for the log', () => {
    const start = refusalOf(() => assertMayStartUnattended(ctx, s, 'start'));
    const on = refusalOf(() => assertMayStartUnattended(ctx, s, 'enabledPrompt'));
    const loosen = refusalOf(() => assertMayStartUnattended(ctx, s, 'loosen'));

    for (const err of [start, on, loosen]) {
      expect(err.code).toBe('DENIED');
      expect(err).toBeInstanceOf(SteerRefusal);
      expect((err as SteerRefusal).sessionId).toBe('s1');
    }
    expect(start.hint).toBe(HINT);
    expect(on.hint).toBe('Turn it off first (queue_set_item_enabled), then change it: once a central has changed it, only a person can turn it back on, in AASC.');
    expect(loosen.hint).toBe('Only you can change this in AASC; a central can do it only in a session it opened itself');
    expect(new Set([start.message, on.message, loosen.message]).size).toBe(3);
  });

  it('says what Ruling 42 says when it is not told what the change is', () => {
    expect(refusalOf(() => assertMayStartUnattended(ctx, s)).message).toBe(refusalOf(() => assertMayStartUnattended(ctx, s, 'start')).message);
  });
});

describe('isEnabledPrompt', () => {
  it('is true for a prompt that is on, false for one that is off or not in the queue', () => {
    const items = [item(1), item(2, { disabled: true }), 'not an item' as never];

    expect(isEnabledPrompt(items, 1)).toBe(true);
    expect(isEnabledPrompt(items, 2)).toBe(false);
    expect(isEnabledPrompt(items, 3)).toBe(false);
  });

  it('reads any value of the mark but true as on, as the scheduler does', () => {
    expect(isEnabledPrompt([item(1, { disabled: false })], 1)).toBe(true);
    expect(isEnabledPrompt([item(1, { disabled: 'yes' })], 1)).toBe(true);
  });
});

describe('reordersEnabled', () => {
  it('is false when the prompts that are on stand in the same order, wherever the ones that are off went', () => {
    const before = [item(1, { position: 0 }), item(2, { position: 1, disabled: true }), item(3, { position: 2 })];
    const after = [item(2, { position: 0, disabled: true }), item(1, { position: 1 }), item(3, { position: 2 })];

    expect(reordersEnabled(before, after)).toBe(false);
  });

  it('is true when two prompts that are on swap places', () => {
    expect(reordersEnabled(queueOf(1, 2), [item(1, { position: 1 }), item(2, { position: 0 })])).toBe(true);
  });

  it('goes by the stored positions, not by where the list holds an item', () => {
    const before = [item(2, { position: 1 }), item(1, { position: 0 })];

    expect(reordersEnabled(before, queueOf(1, 2))).toBe(false);
    expect(reordersEnabled(before, queueOf(2, 1))).toBe(true);
  });

  it('is true when a prompt that is on comes or goes', () => {
    expect(reordersEnabled(queueOf(1), queueOf(1, 2))).toBe(true);
    expect(reordersEnabled(queueOf(1, 2), queueOf(1))).toBe(true);
  });

  it('is true for a queue where a prompt has no position: the window sorts by it, so its order cannot be told', () => {
    const unplaced = [item(1, { position: 0 }), item(2, { position: 1 }), item(3, { position: undefined, disabled: true })];

    expect(reordersEnabled(unplaced, queueOf(1, 2))).toBe(true);
    expect(reordersEnabled(queueOf(1, 2), [item(1, { position: 0 }), item(2, { position: 'last' })])).toBe(true);
  });
});

describe('onlyAddsQuietHours', () => {
  const stored = automationOf({
    loopExcludeWindows: [
      { id: 1, startHHMM: '22:00', endHHMM: '06:00' },
      { id: 2, startHHMM: '12:00', endHHMM: '13:00' },
    ],
  });
  const night = { start: '22:00', end: '06:00' };
  const lunch = { start: '12:00', end: '13:00' };

  it('is true for the same windows, in any order, and for more of them', () => {
    expect(onlyAddsQuietHours(stored, [lunch, night])).toBe(true);
    expect(onlyAddsQuietHours(stored, [night, lunch, { start: '03:00', end: '04:00' }])).toBe(true);
  });

  it('is false when a window is taken away, moved or cut short, or the list is cleared', () => {
    expect(onlyAddsQuietHours(stored, [night])).toBe(false);
    expect(onlyAddsQuietHours(stored, [{ start: '22:00', end: '05:00' }, lunch])).toBe(false);
    expect(onlyAddsQuietHours(stored, [])).toBe(false);
  });

  it('counts a window stored twice twice', () => {
    const twice = automationOf({ loopExcludeWindows: [{ id: 1, startHHMM: '22:00', endHHMM: '06:00' }, { id: 2, startHHMM: '22:00', endHHMM: '06:00' }] });

    expect(onlyAddsQuietHours(twice, [night])).toBe(false);
    expect(onlyAddsQuietHours(twice, [night, night])).toBe(true);
  });

  it('counts only the windows the scheduler keeps: one it ignores may go', () => {
    const odd = automationOf({
      loopExcludeWindows: [
        { id: 1, startHHMM: '09:00', endHHMM: '09:00' },
        { id: 2, startHHMM: 'soon', endHHMM: '10:00' },
        'not a window',
        { id: 3, startHHMM: '7:30', endHHMM: '08:00' },
      ],
    });

    expect(onlyAddsQuietHours(odd, [{ start: '07:30', end: '08:00' }])).toBe(true);
    expect(onlyAddsQuietHours(odd, [])).toBe(false);
  });

  it('is true for any list when none are stored', () => {
    expect(onlyAddsQuietHours(automationOf(), [])).toBe(true);
    expect(onlyAddsQuietHours(null, [night])).toBe(true);
  });
});

describe('raisesResumeRetries', () => {
  it('is true only above the attempts stored now', () => {
    const stored = automationOf({ resumeMaxRetries: 4 });

    expect(raisesResumeRetries(stored, 5)).toBe(true);
    expect(raisesResumeRetries(stored, 4)).toBe(false);
    expect(raisesResumeRetries(stored, 1)).toBe(false);
  });

  it('reads the attempts as the window does: three when none are stored, and within 1 to 10', () => {
    expect(raisesResumeRetries(null, 4)).toBe(true);
    expect(raisesResumeRetries(automationOf({ resumeMaxRetries: undefined }), 3)).toBe(false);
    expect(raisesResumeRetries(automationOf({ resumeMaxRetries: 50 }), 10)).toBe(false);
  });
});

describe('loosensAutomation', () => {
  it('is true when the idle guard or the prompting hold is turned off, or the resume prompt is given at all', () => {
    expect(loosensAutomation({ idleGuard: false })).toBe(true);
    expect(loosensAutomation({ skipWhenPrompting: false })).toBe(true);
    expect(loosensAutomation({ resumePrompt: 'keep going' })).toBe(true);
    expect(loosensAutomation({ resumePrompt: '' })).toBe(true);
  });

  it('is false when they are turned on or left out', () => {
    expect(loosensAutomation({})).toBe(false);
    expect(loosensAutomation({ idleGuard: true, skipWhenPrompting: true })).toBe(false);
  });
});
