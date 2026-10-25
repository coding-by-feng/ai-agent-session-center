// test/mcp/activityTaskNumber.test.ts — the activity log's highest task id (server/mcp/activity.ts `maxTaskNumber`),
// which a new server run counts its task ids on from (Ruling 49). On an in-memory SQLite database (`node:sqlite`).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createActivityLog, type ActivityInput } from '../../server/mcp/activity.js';
import { NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const row = (taskId: string | null): ActivityInput => ({
  centralId: 'central-1',
  tool: 'task',
  risk: 'steers',
  taskId,
  summary: 'T queued',
  outcome: 'queued',
  at: NOW,
});

describe('maxTaskNumber', () => {
  it('ids continue after the highest logged task id: it is read as a number, not as text', () => {
    const activity = createActivityLog({ db: () => new DatabaseSync(':memory:'), now: () => NOW, pruneEveryMs: null });
    for (const id of ['T9', 'T41', 'T100', 'T7', null]) activity.logActivity(row(id));

    expect(activity.maxTaskNumber()).toBe(100);
  });

  it('is 0 for a log with no task rows, and leaves out a task id that is not T<n>', () => {
    const db = new DatabaseSync(':memory:');
    const activity = createActivityLog({ db: () => db, now: () => NOW, pruneEveryMs: null });
    expect(activity.maxTaskNumber()).toBe(0);

    for (const id of [null, 'X12', 'Tabc', 't5']) activity.logActivity(row(id));

    expect(activity.maxTaskNumber()).toBe(0);
  });
});
