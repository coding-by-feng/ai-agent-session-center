/**
 * What mcpStore holds beside the centrals (P2): the tasks the centrals handed out (`tasks`, by task id) and the
 * activity log's rows (`activity`, newest first, capped per central). Both are fed by the socket (`mcp_task_update`,
 * `mcp_activity`, sent to this Mac's windows only) and by a read (GET /api/mcp/tasks when the socket connects,
 * GET /api/mcp/activity when a central's panel opens: the reads are in mcpStore.read.test.ts).
 *
 * Reducers never change what they were given or what they held: a new Map or array each time, so subscribers
 * see a change, and rows keep only the public fields (a token a bad server sent along is never held).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ACTIVITY_MAX,
  TASKS_MAX,
  isOpenTask,
  openTaskFor,
  parseActivityRow,
  parseTaskView,
  useMcpStore,
} from './mcpStore';
import type { McpActivityRow, McpTaskView } from '@/types';

const task = (over: Partial<McpTaskView> = {}): McpTaskView => ({
  taskId: 'T1',
  centralId: 'c1',
  sessionId: 'w1',
  state: 'running',
  title: 'fix the flaky queue test',
  createdAt: 1_000,
  sentAt: 1_100,
  updatedAt: 2_000,
  error: null,
  answerChars: null,
  ...over,
});

const row = (over: Partial<McpActivityRow> = {}): McpActivityRow => ({
  id: 1,
  at: 1_700_000_000_000,
  centralId: 'c1',
  centralSessionId: 'central-card',
  tool: 'prompt_send',
  risk: 'steers',
  targetSessionId: 'w1',
  taskId: null,
  summary: 'Sent a prompt to 1 session',
  outcome: 'ok',
  detail: null,
  ...over,
});

const INITIAL = {
  centrals: new Map(),
  available: null,
  passwordEnabled: null,
  revision: 0,
  tasks: new Map<string, McpTaskView>(),
  activity: [] as McpActivityRow[],
  taskRevision: 0,
};

beforeEach(() => {
  useMcpStore.setState(INITIAL);
});

// ---------------------------------------------------------------------------

describe('parseTaskView', () => {
  it('keeps a well-formed task, as a copy', () => {
    const source = task({ state: 'done', answerChars: 120, error: null });

    const parsed = parseTaskView(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
  });

  it('is null for what is not a task', () => {
    for (const bad of [undefined, null, 'T1', 7, [], {}]) expect(parseTaskView(bad)).toBeNull();
  });

  it.each([
    ['no task id', { taskId: '' }],
    ['a task id that is not text', { taskId: 1 }],
    ['no central', { centralId: '' }],
    ['no session', { sessionId: '' }],
    ['a state it does not know', { state: 'galloping' }],
    ['a title that is not text', { title: 3 }],
    ['a creation time that is not a number', { createdAt: 'yesterday' }],
    ['a creation time that is not finite', { createdAt: Number.POSITIVE_INFINITY }],
    ['a send time that is neither a number nor null', { sentAt: 'now' }],
    ['an update time that is not a number', { updatedAt: null }],
    ['an error that is neither text nor null', { error: 5 }],
    ['an answer length that is neither a number nor null', { answerChars: 'long' }],
  ])('refuses %s', (_name, over) => {
    expect(parseTaskView({ ...task(), ...over })).toBeNull();
  });

  it('keeps whether the answer was cut at the ledger’s 20 000 characters, and drops a value that is not a boolean', () => {
    expect(parseTaskView(task({ state: 'done', answerChars: 20_000, answerTruncated: true }))?.answerTruncated).toBe(true);
    expect(parseTaskView(task({ state: 'done', answerTruncated: false }))?.answerTruncated).toBe(false);
    const odd = parseTaskView({ ...task(), answerTruncated: 'yes' });
    expect(odd).not.toBeNull();
    expect(odd).not.toHaveProperty('answerTruncated');
  });

  it('accepts every state a task can have', () => {
    for (const state of ['queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'failed', 'cancelled'] as const) {
      expect(parseTaskView(task({ state }))?.state).toBe(state);
    }
  });

  it('keeps only the public fields: an answer, a prompt key, a terminal or a token a bad server sent along is not held', () => {
    const parsed = parseTaskView({
      ...task(),
      answer: 'the whole answer',
      promptKey: 'mcp-abc-task-T1',
      terminalId: 'term-secret',
      token: 'aasc_mcp_SECRET',
    });

    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ['answerChars', 'centralId', 'createdAt', 'error', 'sentAt', 'sessionId', 'state', 'taskId', 'title', 'updatedAt'],
    );
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });
});

describe('parseActivityRow', () => {
  it('keeps a well-formed row, as a copy', () => {
    const source = row({ detail: { code: 'HANDS_OFF', n: 2, ok: false, none: null } });

    const parsed = parseActivityRow(source);

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(parsed?.detail).not.toBe(source.detail);
  });

  it('is null for what is not a row', () => {
    for (const bad of [undefined, null, 'row', 3, [], {}]) expect(parseActivityRow(bad)).toBeNull();
  });

  it.each([
    ['no id', { id: 'x' }],
    ['an id that is not finite', { id: Number.NaN }],
    ['no time', { at: undefined }],
    ['no central', { centralId: '' }],
    ['a central session that is neither text nor null', { centralSessionId: 4 }],
    ['no tool', { tool: 2 }],
    ['a risk it does not know', { risk: 'spicy' }],
    ['a target that is neither text nor null', { targetSessionId: {} }],
    ['a task id that is neither text nor null', { taskId: 1 }],
    ['no summary', { summary: null }],
    ['an outcome it does not know', { outcome: 'meh' }],
    ['a detail that is not an object', { detail: 'text' }],
    ['a detail that is a list', { detail: [1, 2] }],
  ])('refuses %s', (_name, over) => {
    expect(parseActivityRow({ ...row(), ...over })).toBeNull();
  });

  it('accepts every outcome: a call’s, and every state a task can move to', () => {
    for (const outcome of ['ok', 'refused', 'failed', 'queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'cancelled'] as const) {
      expect(parseActivityRow(row({ outcome }))?.outcome).toBe(outcome);
    }
  });

  it('accepts every risk a tool can carry', () => {
    for (const risk of ['read', 'write', 'steers', 'ask', 'destructive', 'outward'] as const) {
      expect(parseActivityRow(row({ risk }))?.risk).toBe(risk);
    }
  });

  it('keeps only flat values of a detail, and drops what is nested', () => {
    const parsed = parseActivityRow({ ...row(), detail: { code: 'BUSY', nested: { deep: 1 }, list: [1], n: 1 } });

    expect(parsed?.detail).toEqual({ code: 'BUSY', n: 1 });
  });

  it('keeps only the public fields: a token a bad server sent along is not held', () => {
    const parsed = parseActivityRow({ ...row(), token: 'aasc_mcp_SECRET', detailJson: '{"token":"x"}' });

    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ['at', 'centralId', 'centralSessionId', 'detail', 'id', 'outcome', 'risk', 'summary', 'targetSessionId', 'taskId', 'tool'],
    );
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });
});

// ---------------------------------------------------------------------------

describe('isOpenTask / openTaskFor', () => {
  it('calls a task open until it is done, failed or cancelled', () => {
    for (const state of ['queued', 'sent', 'running', 'blocked', 'stalled'] as const) {
      expect(isOpenTask(task({ state }))).toBe(true);
    }
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      expect(isOpenTask(task({ state }))).toBe(false);
    }
  });

  it('finds the open task of a session', () => {
    const tasks = new Map([['T1', task()]]);

    expect(openTaskFor(tasks, 'w1')).toBe(tasks.get('T1'));
  });

  it('finds none for a session with no task, or with only ended ones', () => {
    const tasks = new Map([
      ['T1', task({ sessionId: 'w1', state: 'done' })],
      ['T2', task({ taskId: 'T2', sessionId: 'w2', state: 'failed' })],
    ]);

    expect(openTaskFor(tasks, 'w1')).toBeUndefined();
    expect(openTaskFor(tasks, 'w2')).toBeUndefined();
    expect(openTaskFor(tasks, 'nobody')).toBeUndefined();
  });

  it('takes the latest when a session somehow has two open (a stale one beside the live one)', () => {
    const tasks = new Map([
      ['T1', task({ taskId: 'T1', updatedAt: 1_000 })],
      ['T2', task({ taskId: 'T2', updatedAt: 3_000, state: 'blocked' })],
      ['T3', task({ taskId: 'T3', updatedAt: 2_000 })],
    ]);

    expect(openTaskFor(tasks, 'w1')?.taskId).toBe('T2');
  });

  it('is stable: the same Map gives the very same object (a selector may return it)', () => {
    const tasks = new Map([['T1', task()]]);

    expect(openTaskFor(tasks, 'w1')).toBe(openTaskFor(tasks, 'w1'));
  });
});

// ---------------------------------------------------------------------------

describe('applyTaskUpdate', () => {
  it('holds the task by its id', () => {
    useMcpStore.getState().applyTaskUpdate(task());

    expect(useMcpStore.getState().tasks.get('T1')).toEqual(task());
  });

  it('replaces the task with its change', () => {
    useMcpStore.getState().applyTaskUpdate(task({ state: 'sent', updatedAt: 1_500 }));
    useMcpStore.getState().applyTaskUpdate(task({ state: 'running', updatedAt: 2_000 }));

    expect(useMcpStore.getState().tasks.size).toBe(1);
    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('running');
  });

  it('follows the worker through a re-key (the change carries its new session id)', () => {
    useMcpStore.getState().applyTaskUpdate(task({ sessionId: 'term-1', updatedAt: 1_500 }));
    useMcpStore.getState().applyTaskUpdate(task({ sessionId: 'claude-uuid', updatedAt: 2_000 }));

    expect(useMcpStore.getState().tasks.get('T1')?.sessionId).toBe('claude-uuid');
  });

  it('keeps a task that ended, so the store mirrors the feed', () => {
    useMcpStore.getState().applyTaskUpdate(task({ state: 'done', answerChars: 40, updatedAt: 3_000 }));

    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('done');
  });

  it('ignores a change older than the one held (the feed may deliver out of order)', () => {
    useMcpStore.getState().applyTaskUpdate(task({ state: 'done', updatedAt: 3_000 }));
    useMcpStore.getState().applyTaskUpdate(task({ state: 'running', updatedAt: 2_000 }));

    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('done');
  });

  it('takes a change with the same time (it is the same change twice, or a later one in the same millisecond)', () => {
    useMcpStore.getState().applyTaskUpdate(task({ state: 'running', updatedAt: 2_000 }));
    useMcpStore.getState().applyTaskUpdate(task({ state: 'blocked', updatedAt: 2_000 }));

    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('blocked');
  });

  it('ignores what is not a task, and keeps what it held', () => {
    useMcpStore.getState().applyTaskUpdate(task());
    const revision = useMcpStore.getState().taskRevision;

    useMcpStore.getState().applyTaskUpdate({ taskId: 'T2' });
    useMcpStore.getState().applyTaskUpdate(undefined);
    useMcpStore.getState().applyTaskUpdate('T3');

    expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1']);
    expect(useMcpStore.getState().taskRevision).toBe(revision);
  });

  it('never changes the map it replaces (a new Map each time, so subscribers see a change)', () => {
    useMcpStore.getState().applyTaskUpdate(task());
    const before = useMcpStore.getState().tasks;

    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2' }));

    expect(useMcpStore.getState().tasks).not.toBe(before);
    expect([...before.keys()]).toEqual(['T1']);
  });

  it('never changes the task it was given', () => {
    const given = task();
    const copy = { ...given };

    useMcpStore.getState().applyTaskUpdate(given);
    useMcpStore.getState().applyTaskUpdate({ ...given, state: 'done', updatedAt: 9_000 });

    expect(given).toEqual(copy);
    expect(useMcpStore.getState().tasks.get('T1')).not.toBe(given);
  });

  it('keeps the tasks of other sessions as they were', () => {
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', sessionId: 'w1' }));
    const other = useMcpStore.getState().tasks.get('T1');
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2' }));

    expect(useMcpStore.getState().tasks.get('T1')).toBe(other);
  });

  describe('the cap', () => {
    it('holds at most TASKS_MAX tasks, dropping the oldest that have ended', () => {
      for (let i = 1; i <= TASKS_MAX + 20; i += 1) {
        useMcpStore.getState().applyTaskUpdate(task({ taskId: `T${i}`, sessionId: `w${i}`, state: 'done', updatedAt: i }));
      }

      const { tasks } = useMcpStore.getState();
      expect(tasks.size).toBe(TASKS_MAX);
      expect(tasks.has('T1')).toBe(false);
      expect(tasks.has('T20')).toBe(false);
      expect(tasks.has('T21')).toBe(true);
      expect(tasks.has(`T${TASKS_MAX + 20}`)).toBe(true);
    });

    it('never drops a task that is still open, however old', () => {
      useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T-old-open', sessionId: 'w-old', state: 'running', updatedAt: 1 }));
      for (let i = 1; i <= TASKS_MAX + 5; i += 1) {
        useMcpStore.getState().applyTaskUpdate(task({ taskId: `T${i}`, sessionId: `w${i}`, state: 'done', updatedAt: 1_000 + i }));
      }

      const { tasks } = useMcpStore.getState();
      expect(tasks.has('T-old-open')).toBe(true);
      expect(tasks.size).toBeLessThanOrEqual(TASKS_MAX);
    });
  });
});

// ---------------------------------------------------------------------------

describe('applyTasks (the tasks in flight, as the server lists them)', () => {
  it('holds the list by task id', () => {
    useMcpStore.getState().applyTasks([task({ taskId: 'T1' }), task({ taskId: 'T2', sessionId: 'w2' })]);

    expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1', 'T2']);
  });

  it('drops an open task the list no longer has (it ended while the window was not listening)', () => {
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'running' }));
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2', state: 'blocked' }));

    useMcpStore.getState().applyTasks([task({ taskId: 'T2', sessionId: 'w2', state: 'blocked', updatedAt: 2_000 })]);

    expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T2']);
  });

  it('keeps a task that ended, which the list (open tasks only) never has', () => {
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'done', updatedAt: 3_000 }));

    useMcpStore.getState().applyTasks([]);

    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('done');
  });

  it('takes the list’s version of an open task, unless the one held is newer', () => {
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T1', state: 'blocked', updatedAt: 5_000 }));
    useMcpStore.getState().applyTaskUpdate(task({ taskId: 'T2', sessionId: 'w2', state: 'sent', updatedAt: 1_000 }));

    useMcpStore.getState().applyTasks([
      task({ taskId: 'T1', state: 'running', updatedAt: 4_000 }),
      task({ taskId: 'T2', sessionId: 'w2', state: 'running', updatedAt: 2_000 }),
    ]);

    expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('blocked');
    expect(useMcpStore.getState().tasks.get('T2')?.state).toBe('running');
  });

  it('drops malformed entries without losing the good ones', () => {
    useMcpStore.getState().applyTasks([task({ taskId: 'T1' }), { taskId: 'broken' }, null]);

    expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1']);
  });

  it('ignores a payload that is not a list, and keeps what it held', () => {
    useMcpStore.getState().applyTaskUpdate(task());
    const revision = useMcpStore.getState().taskRevision;

    useMcpStore.getState().applyTasks({ tasks: [] });
    useMcpStore.getState().applyTasks(undefined);

    expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1']);
    expect(useMcpStore.getState().taskRevision).toBe(revision);
  });

  it('never changes the map it replaces', () => {
    useMcpStore.getState().applyTaskUpdate(task());
    const before = useMcpStore.getState().tasks;

    useMcpStore.getState().applyTasks([]);

    expect(useMcpStore.getState().tasks).not.toBe(before);
    expect([...before.keys()]).toEqual(['T1']);
  });
});

// ---------------------------------------------------------------------------

describe('applyActivityRow', () => {
  it('puts a new row first', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 1 }));
    useMcpStore.getState().applyActivityRow(row({ id: 2 }));

    expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([2, 1]);
  });

  it('keeps the newest first even when rows arrive out of order', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 5 }));
    useMcpStore.getState().applyActivityRow(row({ id: 3 }));
    useMcpStore.getState().applyActivityRow(row({ id: 9 }));

    expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([9, 5, 3]);
  });

  it('holds a row once, however often it arrives (a read and the socket may both bring it)', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 4, summary: 'first' }));
    useMcpStore.getState().applyActivityRow(row({ id: 4, summary: 'again' }));

    expect(useMcpStore.getState().activity).toHaveLength(1);
  });

  it('keeps the row it holds when the same id comes again: a row never changes', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 4, summary: 'as written' }));
    useMcpStore.getState().applyActivityRow(row({ id: 4, summary: 'as rewritten' }));
    useMcpStore.getState().applyActivityRows([row({ id: 4, summary: 'as rewritten again' })]);

    expect(useMcpStore.getState().activity.map((r) => r.summary)).toEqual(['as written']);
  });

  it('ignores what is not a row, and keeps what it held', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 1 }));
    const before = useMcpStore.getState().activity;

    useMcpStore.getState().applyActivityRow({ id: 2 });
    useMcpStore.getState().applyActivityRow(undefined);

    expect(useMcpStore.getState().activity).toBe(before);
  });

  it('never changes the array it replaces (a new array each time, so subscribers see a change)', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 1 }));
    const before = useMcpStore.getState().activity;

    useMcpStore.getState().applyActivityRow(row({ id: 2 }));

    expect(useMcpStore.getState().activity).not.toBe(before);
    expect(before.map((r) => r.id)).toEqual([1]);
  });

  it('never changes the row it was given', () => {
    const given = row({ id: 7, detail: { code: 'BUSY' } });
    const copy = JSON.parse(JSON.stringify(given));

    useMcpStore.getState().applyActivityRow(given);
    useMcpStore.getState().activity[0].detail!.code = 'tampered';

    expect(given).toEqual(copy);
  });

  it('holds at most ACTIVITY_MAX rows, the newest', () => {
    for (let i = 1; i <= ACTIVITY_MAX + 25; i += 1) useMcpStore.getState().applyActivityRow(row({ id: i }));

    const { activity } = useMcpStore.getState();
    expect(activity).toHaveLength(ACTIVITY_MAX);
    expect(activity[0].id).toBe(ACTIVITY_MAX + 25);
    expect(activity[activity.length - 1].id).toBe(26);
  });
});

describe('applyActivityRows (a read of the log)', () => {
  it('merges the rows with the ones held, newest first, each once', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 10 }));
    useMcpStore.getState().applyActivityRow(row({ id: 12 }));

    useMcpStore.getState().applyActivityRows([row({ id: 12 }), row({ id: 11 }), row({ id: 9 })]);

    expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([12, 11, 10, 9]);
  });

  it('drops malformed rows without losing the good ones', () => {
    useMcpStore.getState().applyActivityRows([row({ id: 1 }), { id: 2 }, null, row({ id: 3 })]);

    expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([3, 1]);
  });

  it('ignores a payload that is not a list, and keeps what it held', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 1 }));
    const before = useMcpStore.getState().activity;

    useMcpStore.getState().applyActivityRows({ rows: [] });
    useMcpStore.getState().applyActivityRows(undefined);

    expect(useMcpStore.getState().activity).toBe(before);
  });

  it('keeps the newest ACTIVITY_MAX of a long read', () => {
    useMcpStore.getState().applyActivityRows(Array.from({ length: ACTIVITY_MAX + 40 }, (_v, i) => row({ id: i + 1 })));

    const { activity } = useMcpStore.getState();
    expect(activity).toHaveLength(ACTIVITY_MAX);
    expect(activity[0].id).toBe(ACTIVITY_MAX + 40);
  });

  it('never changes the array it replaces', () => {
    useMcpStore.getState().applyActivityRow(row({ id: 1 }));
    const before = useMcpStore.getState().activity;

    useMcpStore.getState().applyActivityRows([row({ id: 2 })]);

    expect(useMcpStore.getState().activity).not.toBe(before);
    expect(before.map((r) => r.id)).toEqual([1]);
  });
});

// The store holds every central's rows, and the panel of one central filters them. A cap shared by all centrals
// would let a busy one push a quiet one's rows out, and the quiet one's panel would say "No activity yet".
describe('the activity cap is per central', () => {
  const rowsOf = (centralId: string) => useMcpStore.getState().activity.filter((r) => r.centralId === centralId);
  /** `count` rows of a central, ids `from` to `from + count - 1`. */
  const rowsFor = (centralId: string, from: number, count: number) =>
    Array.from({ length: count }, (_v, i) => row({ id: from + i, centralId }));

  it("a busy central does not evict a quiet central's rows", () => {
    // A writes ACTIVITY_MAX rows with the dashboard open; then B's panel opens and its (older) 50 rows are read.
    useMcpStore.getState().applyActivityRows(rowsFor('A', 1_000, ACTIVITY_MAX));

    useMcpStore.getState().applyActivityRows(rowsFor('B', 1, 50));

    expect(rowsOf('B')).toHaveLength(50);
    expect(rowsOf('A')).toHaveLength(ACTIVITY_MAX);
  });

  it('a busy central’s new rows push out its own oldest, never the quiet central’s', () => {
    useMcpStore.getState().applyActivityRows(rowsFor('B', 1, 3));

    for (let i = 0; i < ACTIVITY_MAX + 10; i += 1) useMcpStore.getState().applyActivityRow(row({ id: 100 + i, centralId: 'A' }));

    expect(rowsOf('B').map((r) => r.id)).toEqual([3, 2, 1]);
    expect(rowsOf('A')).toHaveLength(ACTIVITY_MAX);
    expect(rowsOf('A')[0].id).toBe(100 + ACTIVITY_MAX + 9);
    expect(rowsOf('A')[ACTIVITY_MAX - 1].id).toBe(110);
  });

  it('keeps the newest ACTIVITY_MAX rows of each central of one long read', () => {
    useMcpStore.getState().applyActivityRows([
      ...rowsFor('A', 1_000, ACTIVITY_MAX + 20),
      ...rowsFor('B', 1, ACTIVITY_MAX + 5),
    ]);

    expect(rowsOf('A')).toHaveLength(ACTIVITY_MAX);
    expect(rowsOf('B')).toHaveLength(ACTIVITY_MAX);
    // Each keeps its newest: the oldest 20 of A and the oldest 5 of B are the ones cut.
    expect(rowsOf('A')[ACTIVITY_MAX - 1].id).toBe(1_020);
    expect(rowsOf('B')[ACTIVITY_MAX - 1].id).toBe(6);
  });

  it('still lists every central’s rows together, newest first', () => {
    useMcpStore.getState().applyActivityRows([
      row({ id: 5, centralId: 'A' }),
      row({ id: 9, centralId: 'B' }),
      row({ id: 7, centralId: 'A' }),
    ]);

    expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([9, 7, 5]);
  });
});

describe('parseTaskView: how it was routed (P4-21 f)', () => {
  const route = { by: 'auto', decision: 'reuse', reasons: ['same project', 'idle'] } as const;

  it('copies the route and the session it was re-routed from', () => {
    const parsed = parseTaskView(task({ route, retargetedFrom: 'w0' }));
    expect(parsed?.route).toEqual(route);
    expect(parsed?.retargetedFrom).toBe('w0');
  });

  it('copies a route that is null (the central named the session) and no re-route', () => {
    const parsed = parseTaskView(task({ route: null, retargetedFrom: null }));
    expect(parsed?.route).toBeNull();
    expect(parsed?.retargetedFrom).toBeNull();
  });

  it('copies the reasons: the task shares nothing with what it was read from', () => {
    const source = { ...task(), route: { ...route, reasons: [...route.reasons] as string[] } };
    const parsed = parseTaskView(source);
    source.route.reasons.push('changed after');
    expect(parsed?.route?.reasons).toEqual(['same project', 'idle']);
  });

  it('leaves them out when a server older than P4 sends none', () => {
    const parsed = parseTaskView(task());
    expect(parsed).not.toHaveProperty('route');
    expect(parsed).not.toHaveProperty('retargetedFrom');
  });

  it('drops a route that is not well formed, and keeps the task', () => {
    for (const bad of [
      'auto',
      { by: 'human', decision: 'reuse', reasons: [] },
      { by: 'auto', decision: 'teleport', reasons: [] },
      { by: 'auto', decision: 'create', reasons: 'because' },
      { by: 'auto', decision: 'create', reasons: [1] },
      { by: 'auto', decision: 'create' },
    ]) {
      const parsed = parseTaskView({ ...task(), route: bad });
      expect(parsed?.taskId).toBe('T1');
      expect(parsed).not.toHaveProperty('route');
    }
  });

  it('drops a retargetedFrom that is not text or null', () => {
    const parsed = parseTaskView({ ...task(), retargetedFrom: 7 });
    expect(parsed?.taskId).toBe('T1');
    expect(parsed).not.toHaveProperty('retargetedFrom');
  });

  it('keeps no other field of the route: a token a bad server sent along is never held', () => {
    const parsed = parseTaskView({ ...task(), route: { ...route, token: 'secret' } });
    expect(parsed?.route).toEqual(route);
  });
});

describe('activity rows of a central that has gone (P4-21 c)', () => {
  const central = (centralId: string) => ({
    centralId,
    kind: 'global',
    scopeRef: null,
    cli: 'claude',
    sessionId: null,
    toolsets: [],
    createdAt: 1,
    workerCount: 0,
  });

  it('are dropped when a list of centrals no longer holds it, and the others stay', () => {
    useMcpStore.getState().applyCentrals([central('c1'), central('c2')]);
    useMcpStore.getState().applyActivityRows([row({ id: 1, centralId: 'c1' }), row({ id: 2, centralId: 'c2' })]);

    useMcpStore.getState().applyCentrals([central('c1')]);

    expect(useMcpStore.getState().activity.map((r) => r.centralId)).toEqual(['c1']);
  });

  it('are all dropped for an empty list', () => {
    useMcpStore.getState().applyCentrals([central('c1')]);
    useMcpStore.getState().applyActivityRows([row({ id: 1, centralId: 'c1' })]);

    useMcpStore.getState().applyCentrals([]);

    expect(useMcpStore.getState().activity).toEqual([]);
  });

  it('keep their array when nothing has gone (no change for subscribers to see)', () => {
    useMcpStore.getState().applyCentrals([central('c1')]);
    useMcpStore.getState().applyActivityRows([row({ id: 1, centralId: 'c1' })]);
    const before = useMcpStore.getState().activity;

    useMcpStore.getState().applyCentrals([central('c1'), central('c2')]);

    expect(useMcpStore.getState().activity).toBe(before);
  });

  it('are not dropped by a payload that is not a list', () => {
    useMcpStore.getState().applyCentrals([central('c1')]);
    useMcpStore.getState().applyActivityRows([row({ id: 1, centralId: 'c1' })]);

    useMcpStore.getState().applyCentrals('nonsense');

    expect(useMcpStore.getState().activity).toHaveLength(1);
  });
});
