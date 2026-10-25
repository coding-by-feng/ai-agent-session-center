import { describe, expect, it } from 'vitest';

import {
  activityOutcomeLabel,
  activityOutcomeTone,
  activityTargetLabel,
  activityTime,
  taskStateHint,
  workerBadgeCompactText,
  workerBadgeLabel,
  workerBadgeRest,
  WORKER_BADGE_SEPARATOR,
  workerBadgeScope,
  workerBadgeTask,
  workerBadgeText,
  workerBadgeTip,
  workerBadgeTone,
} from './centralActivity';
import type { McpActivityOutcome, McpTaskState } from '@/types';

const task = (over: Partial<{ taskId: string; state: McpTaskState; title: string }> = {}) => ({
  taskId: 'T12',
  state: 'running' as McpTaskState,
  title: 'fix the flaky queue test',
  ...over,
});
const GLOBAL = { kind: 'global', scopeRef: null } as const;
const ROOM = { kind: 'room', scopeRef: 'room-1' } as const;
const PROJECT = { kind: 'project', scopeRef: '/Users/me/agent-manager' } as const;

describe('the parts of the worker badge', () => {
  it('splits the badge into the scope, the separator that goes with it, and the task that never goes', () => {
    const parts = workerBadgeScope(GLOBAL) + WORKER_BADGE_SEPARATOR + workerBadgeTask(task());

    expect(workerBadgeTask(task())).toBe('T12 · running');
    expect(workerBadgeRest(task())).toBe(' · T12 · running');
    expect(parts).toBe(workerBadgeText(task(), GLOBAL));
  });
});

describe('workerBadgeText', () => {
  it('reads ← ★ global · T12 · running for a global central’s running task', () => {
    expect(workerBadgeText(task(), GLOBAL)).toBe('← ★ global · T12 · running');
  });

  it('names the room of a room central, and the folder of a project central', () => {
    expect(workerBadgeText(task({ state: 'blocked' }), ROOM, 'Backend')).toBe('← ★ room Backend · T12 · blocked');
    expect(workerBadgeText(task({ state: 'stalled' }), PROJECT)).toBe('← ★ project agent-manager · T12 · stalled');
  });

  it('says plain ★ room when the room’s name is not known', () => {
    expect(workerBadgeText(task(), ROOM)).toBe('← ★ room · T12 · running');
  });

  it('says ★ central when the central is not known (its list has not arrived, or it has gone)', () => {
    expect(workerBadgeText(task({ state: 'sent' }), undefined)).toBe('← ★ central · T12 · sent');
  });

  it.each([
    ['queued', 'queued'],
    ['sent', 'sent'],
    ['running', 'running'],
    ['blocked', 'blocked'],
    ['stalled', 'stalled'],
  ] as const)('says the state of a %s task as its own word', (state, word) => {
    expect(workerBadgeText(task({ state }), GLOBAL)).toBe(`← ★ global · T12 · ${word}`);
  });

  it('is its scope and its rest, joined', () => {
    expect(workerBadgeScope(ROOM, 'Backend') + workerBadgeRest(task({ state: 'blocked' }))).toBe(
      workerBadgeText(task({ state: 'blocked' }), ROOM, 'Backend'),
    );
    expect(workerBadgeScope(GLOBAL)).toBe('← ★ global');
    expect(workerBadgeRest(task())).toBe(' · T12 · running');
  });

  it('carries the task id as it came (T<n>)', () => {
    expect(workerBadgeText(task({ taskId: 'T7' }), GLOBAL)).toBe('← ★ global · T7 · running');
  });
});

describe('workerBadgeCompactText', () => {
  it('is the task id alone, for a card with no room for words', () => {
    expect(workerBadgeCompactText(task({ taskId: 'T3' }))).toBe('T3');
  });
});

describe('workerBadgeTone', () => {
  it('is pending until the session has taken the prompt', () => {
    expect(workerBadgeTone('queued')).toBe('pending');
    expect(workerBadgeTone('sent')).toBe('pending');
  });

  it('is running while it works', () => {
    expect(workerBadgeTone('running')).toBe('running');
  });

  it('is attention when it waits on a person or on a fault, so it stands out on a card', () => {
    expect(workerBadgeTone('blocked')).toBe('attention');
    expect(workerBadgeTone('stalled')).toBe('attention');
  });
});

describe('workerBadgeLabel', () => {
  it('spells the whole badge out for a screen reader, with the scope in words', () => {
    expect(workerBadgeLabel(task(), GLOBAL)).toBe('Task T12 from the global central: running');
    expect(workerBadgeLabel(task({ state: 'blocked' }), ROOM, 'Backend')).toBe('Task T12 from the room Backend central: blocked');
    expect(workerBadgeLabel(task(), undefined)).toBe('Task T12 from a central session: running');
  });
});

describe('workerBadgeTip', () => {
  it('names the task and its state in the label', () => {
    expect(workerBadgeTip(task(), GLOBAL).label).toBe('Task T12 · running');
  });

  it('says which central sent it, what it asked, and what the state means', () => {
    const { description } = workerBadgeTip(task(), GLOBAL);

    expect(description).toContain('From the global central.');
    expect(description).toContain('“fix the flaky queue test”');
    expect(description).toContain(taskStateHint('running'));
  });

  it('names the room, and the whole folder of a project central', () => {
    expect(workerBadgeTip(task(), ROOM, 'Backend').description).toContain('From the room central for “Backend”.');
    expect(workerBadgeTip(task(), PROJECT).description).toContain('From the project central for /Users/me/agent-manager.');
  });

  it('leaves out the quoted title when the task has none', () => {
    expect(workerBadgeTip(task({ title: '' }), GLOBAL).description).not.toContain('“');
  });

  it('says it of an unknown central too', () => {
    expect(workerBadgeTip(task(), undefined).description).toContain('From a central session.');
  });
});

describe('taskStateHint', () => {
  it('has a sentence for every state', () => {
    for (const state of ['queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'failed', 'cancelled'] as const) {
      expect(taskStateHint(state).length).toBeGreaterThan(10);
    }
  });

  it('says a blocked task waits on a dialog, and a stalled one on a fault', () => {
    expect(taskStateHint('blocked')).toMatch(/dialog/i);
    expect(taskStateHint('stalled')).toMatch(/fault|rate limit|overload/i);
  });
});

describe('activityTime', () => {
  const at = new Date(2026, 9, 24, 14, 5, 9).getTime();

  it('is the clock time, with seconds, for a row of today', () => {
    const now = new Date(2026, 9, 24, 18, 0, 0).getTime();

    expect(activityTime(at, now).text).toBe('14:05:09');
  });

  it('adds the day for an older row', () => {
    const now = new Date(2026, 9, 26, 9, 0, 0).getTime();

    expect(activityTime(at, now).text).toBe('Oct 24 14:05');
  });

  it('treats a row from just before midnight as yesterday’s, not today’s', () => {
    const late = new Date(2026, 9, 23, 23, 59, 59).getTime();
    const now = new Date(2026, 9, 24, 0, 0, 1).getTime();

    expect(activityTime(late, now).text).toBe('Oct 23 23:59');
  });

  it('pads single digits', () => {
    const early = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const now = new Date(2026, 0, 2, 23, 0, 0).getTime();

    expect(activityTime(early, now).text).toBe('03:04:05');
  });

  it('gives the full date and time in a title, for hover', () => {
    const now = new Date(2026, 9, 24, 18, 0, 0).getTime();

    expect(activityTime(at, now).title).toContain('2026');
  });

  it('does not fail for a time that is not a date', () => {
    expect(activityTime(Number.NaN, 0).text).toBe('—');
  });
});

describe('activityOutcomeLabel / activityOutcomeTone', () => {
  it('names a call’s outcome as it is', () => {
    expect(activityOutcomeLabel('ok')).toBe('ok');
    expect(activityOutcomeLabel('refused')).toBe('refused');
    expect(activityOutcomeLabel('failed')).toBe('failed');
  });

  it('names a task’s new state as its own word', () => {
    for (const state of ['queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'cancelled'] as const) {
      expect(activityOutcomeLabel(state)).toBe(state);
    }
  });

  it('colours by meaning: done is good, a refusal is a warning, a failure is an error', () => {
    expect(activityOutcomeTone('ok')).toBe('success');
    expect(activityOutcomeTone('done')).toBe('success');
    expect(activityOutcomeTone('refused')).toBe('warning');
    expect(activityOutcomeTone('blocked')).toBe('warning');
    expect(activityOutcomeTone('stalled')).toBe('warning');
    expect(activityOutcomeTone('failed')).toBe('danger');
    expect(activityOutcomeTone('running')).toBe('info');
    expect(activityOutcomeTone('queued')).toBe('neutral');
    expect(activityOutcomeTone('sent')).toBe('neutral');
    expect(activityOutcomeTone('cancelled')).toBe('neutral');
  });

  it('has a tone for every outcome there is', () => {
    const all: McpActivityOutcome[] = ['ok', 'refused', 'failed', 'queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'cancelled'];
    for (const outcome of all) expect(activityOutcomeTone(outcome)).toBeTruthy();
  });
});

describe('activityTargetLabel', () => {
  const sessions = new Map([
    ['w1', { title: 'Backend worker', projectName: 'api' }],
    ['w2', { title: '', projectName: 'web' }],
    ['w3', { title: '', projectName: '' }],
  ]);

  it('is the session’s name, as the cards say it', () => {
    expect(activityTargetLabel('w1', sessions)).toEqual({ text: 'Backend worker', known: true });
    expect(activityTargetLabel('w2', sessions)).toEqual({ text: 'web', known: true });
    expect(activityTargetLabel('w3', sessions)).toEqual({ text: 'Unnamed', known: true });
  });

  it('is a short id for a session that is not on the board any more (ended and removed, or re-keyed)', () => {
    expect(activityTargetLabel('0123456789abcdef', sessions)).toEqual({ text: '01234567', known: false });
  });

  it('is a dash when the row had no target', () => {
    expect(activityTargetLabel(null, sessions)).toEqual({ text: '—', known: false });
  });
});
