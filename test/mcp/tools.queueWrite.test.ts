// test/mcp/tools.queueWrite.test.ts — the queue toolset's P2 writes (server/mcp/tools/queueWrite*.ts): the 15 tools a
// central uses to change a session's shared prompt queue. Each names a session (scope-checked, then the steering rails
// of `ctx.mayDrive`), changes the stored queue in one read-modify-write under the origin `mcp:<centralId>`, and answers
// with the changed item (its text fenced as untrusted data) and a note for the activity log.
//
// The store is a fake; `GET /presence` says whether a window is open to run the queue. The refusal log is in
// tools.queueWriteLogged.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { blocksIn, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { automationOf, fakeQueueStore, item, itemWith, NOW, queueOf } from './queueFixtures.js';
import { accepts, CASES, queueWorld, RESUME_ROUTE, standardRows, STARTS, toolsOver, WRITES, worker } from './queueToolFixtures.js';
import { fail, makeCentral, makeRoom, ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const SECRET = 'my bank password is hunter2';
const NEEDLE = 424_242;

interface ItemData {
  id: number;
  position: number;
  disabled: boolean;
  type: string;
  text: string;
  beforeCount: number;
  afterCount: number;
  beforeSteps: Array<{ id: number; text: string }>;
}
interface Answer {
  id: string;
  shortId: string;
  item: ItemData;
  queue: { count: number; enabled: number };
  windowOpen: boolean | null;
  [key: string]: unknown;
}

describe('the tools', () => {
  it('are the 15 queue writes the catalog gives P2, in the queue toolset, none of them a read', () => {
    const tools = toolsOver(fakeQueueStore());

    expect(tools.map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const tool of tools) {
      expect(tool.toolset, tool.name).toBe('queue');
      expect(tool.phase, tool.name).toBe(2);
      expect(tool.risk, tool.name).not.toBe('read');
    }
  });

  it('carry the catalog’s risks: steers for what queues, enables or fires work, write for what only removes, reorders or pauses', () => {
    const risks = Object.fromEntries(toolsOver(fakeQueueStore()).map((t) => [t.name, t.risk]));

    expect(risks).toEqual({
      queue_add_item: 'steers',
      queue_edit_item: 'steers',
      queue_remove_item: 'write',
      queue_move_item: 'write',
      queue_set_item_enabled: 'steers',
      queue_set_item_schedule: 'steers',
      queue_fire_now: 'steers',
      queue_add_step: 'steers',
      queue_edit_step: 'steers',
      queue_remove_step: 'write',
      queue_move_step: 'write',
      queue_set_paused: 'write',
      queue_set_auto_send: 'steers',
      queue_set_automation: 'steers',
      queue_resume_after_cancel: 'steers',
    });
  });

  it('are in the registry beside the three P1 reads and P5’s queue_clear, once each', () => {
    const queue = allTools().filter((t) => t.toolset === 'queue').map((t) => t.name);

    expect(queue).toHaveLength(19);
    expect(new Set(queue).size).toBe(19);
    expect(queue).toEqual(expect.arrayContaining(['queue_get', 'queue_list_all', 'queue_sent', 'queue_clear', ...WRITES]));
  });

  it('each name a session first, and take every item and step by its number', () => {
    const tools = toolsOver(fakeQueueStore());

    for (const [name, args] of CASES) {
      expect(accepts(tools, name, args), name).toBe(true);
      const { id: _id, ...withoutSession } = args;
      expect(accepts(tools, name, withoutSession), `${name} without a session`).toBe(false);
    }
    expect(accepts(tools, 'queue_edit_item', { id: 's1', itemId: '1', text: 'x' })).toBe(false);
    expect(accepts(tools, 'queue_edit_item', { id: 's1', itemId: 1.5, text: 'x' })).toBe(false);
  });

  it('refuse, as the endpoint’s argument check does, a text over 64 KiB, a negative position and a blank id', () => {
    const tools = toolsOver(fakeQueueStore());

    expect(accepts(tools, 'queue_add_item', { id: 's1', text: 'x'.repeat(64 * 1024 + 1) })).toBe(false);
    expect(accepts(tools, 'queue_add_item', { id: 's1', text: 'ok', position: -1 })).toBe(false);
    expect(accepts(tools, 'queue_add_item', { id: '', text: 'ok' })).toBe(false);
    expect(accepts(tools, 'queue_move_item', { id: 's1', itemId: 1, position: -1 })).toBe(false);
  });
});

describe('every tool, on an ordinary queue with a window open', () => {
  it.each(CASES)('%s answers, writes once under the central’s origin, and gives the log one note', async (name, args) => {
    const w = queueWorld({ rows: standardRows(), routes: RESUME_ROUTE, unlocked: STARTS.has(name) });

    const result = await w.call(name, args);

    if (name === 'queue_resume_after_cancel') {
      expect(w.store.writes).toHaveLength(0);
      expect(w.client.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /sessions/s1/queue/resume');
    } else {
      expect(w.store.writes).toHaveLength(1);
      expect(w.store.writes[0]).toMatchObject({ sessionId: 's1', originClientId: 'mcp:central-1' });
      expect(w.store.calls).toEqual(['read s1', 'write s1']);
    }
    expect(result.activity).toHaveLength(1);
    expect(result.activity?.[0]).toMatchObject({ targetSessionId: 's1' });
    expect(result.data).toMatchObject({ id: 's1', shortId: 's1' });
    expect(result.summary.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe('queue_add_item', () => {
  it('adds the prompt last, with the client’s id and position scheme', async () => {
    const w = queueWorld({ rows: { s1: { items: queueOf(5, 6) } } });

    const answer = (await w.call('queue_add_item', { id: 's1', text: 'run the tests' })).data as Answer;

    const stored = w.store.rows.get('s1')?.items ?? [];
    expect(stored).toHaveLength(3);
    expect(stored[2]).toEqual({ id: NOW, sessionId: 's1', text: 'run the tests', position: 2, createdAt: NOW, disabled: true });
    expect(answer.item).toMatchObject({ id: NOW, position: 2, type: 'once' });
  });

  it('adds are disabled: the prompt is stored paused, and the answer says a person turns it on', async () => {
    const w = queueWorld();

    const result = await w.call('queue_add_item', { id: 's1', text: 'run the tests' });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], NOW).disabled).toBe(true);
    expect((result.data as Answer).item.disabled).toBe(true);
    expect(result.summary).toMatch(/added paused/i);
    expect(result.summary).toContain('turn it on in AASC');
    expect(result.summary).toContain('runs once a human enables it');
    expect(outsideFences(result.summary)).not.toContain('run the tests');
  });

  it('adds it paused whatever else the call says: there is no argument that adds it on', async () => {
    const w = queueWorld();

    await w.call('queue_add_item', { id: 's1', text: 'go', enabled: true, disabled: false });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], NOW).disabled).toBe(true);
  });

  it('puts it at a position when told', async () => {
    const w = queueWorld({ rows: { s1: { items: queueOf(5, 6) } } });

    await w.call('queue_add_item', { id: 's1', text: 'first now', position: 0 });

    expect((w.store.rows.get('s1')?.items ?? []).map((i) => (i as { text: string }).text)).toEqual(['first now', 'item 5', 'item 6']);
  });

  it('counts the queue in the answer', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(5, { position: 0 }), item(6, { position: 1, disabled: true })] } } });

    const answer = (await w.call('queue_add_item', { id: 's1', text: 'x' })).data as Answer;

    expect(answer.queue).toEqual({ count: 3, enabled: 1 });
  });

  it('refuses blank text and a shell line, writing nothing and not repeating the text', async () => {
    const w = queueWorld();

    for (const text of ['   ', '!rm -rf ~']) {
      const err = await w.refused('queue_add_item', { id: 's1', text });
      expect(err.code, text).toBe('INVALID');
      expect(`${err.message} ${err.hint}`).not.toContain('rm -rf');
    }
    expect(w.store.writes).toEqual([]);
  });
});

describe('queue_edit_item', () => {
  it('replaces the text of one prompt and keeps the rest of it', async () => {
    const w = queueWorld({ rows: standardRows() });

    const answer = (await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'new words' })).data as Answer;

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ text: 'new words', beforeChain: [{ id: 10, text: 'first step' }] });
    expect(answer.item).toMatchObject({ id: 1, beforeCount: 1 });
  });

  it('is NOT_FOUND for a prompt that is not in the queue, writing nothing and not repeating the id', async () => {
    const w = queueWorld({ rows: standardRows() });

    const err = await w.refused('queue_edit_item', { id: 's1', itemId: NEEDLE, text: 'x' });

    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint}`).not.toContain(String(NEEDLE));
    expect(w.store.writes).toEqual([]);
  });
});

describe('queue_remove_item', () => {
  it('removes the prompt and says how many are left, without echoing its text', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1, { text: SECRET }), item(2, { position: 1 })] } } });

    const result = await w.call('queue_remove_item', { id: 's1', itemId: 1 });

    expect((w.store.rows.get('s1')?.items ?? []).map((i) => (i as { id: number }).id)).toEqual([2]);
    expect(result.data).toMatchObject({ removed: { itemId: 1 }, queue: { count: 1, enabled: 1 } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('queue_move_item', () => {
  it('moves the prompt, answering where it was and where it went', async () => {
    // A paused one: moving a prompt that is on is locked (Ruling 53, tools.queueWriteLockMore.test.ts).
    const w = queueWorld({ rows: { s1: { items: [...queueOf(1, 2), item(3, { position: 2, disabled: true })] } } });

    const answer = (await w.call('queue_move_item', { id: 's1', itemId: 3, position: 0 })).data as Answer & { moved: { from: number; to: number } };

    expect((w.store.rows.get('s1')?.items ?? []).map((i) => (i as { id: number }).id)).toEqual([3, 1, 2]);
    expect(answer.moved).toEqual({ from: 2, to: 0 });
    expect(answer.item).toMatchObject({ id: 3, position: 0 });
  });
});

describe('queue_set_item_enabled', () => {
  // Turning a prompt ON is locked until P4 (tools.queueWriteLock.test.ts); here the lock is let through, as it will be
  // for a central's own worker, to check what the op does.
  it('turns a prompt off and on', async () => {
    const w = queueWorld({ rows: standardRows(), unlocked: true });

    const off = await w.call('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: false });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).disabled).toBe(true);
    expect((off.data as Answer).item.disabled).toBe(true);

    const on = await w.call('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).not.toHaveProperty('disabled');
    expect((on.data as Answer).item.disabled).toBe(false);
    expect(on.summary).toMatch(/on its own/);
  });
});

describe('queue_set_item_schedule', () => {
  it('makes a loop, a schedule from an ISO time, and a once item', async () => {
    const w = queueWorld({ rows: standardRows() });

    await w.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'loop', intervalMs: 600_000, firstFireOfDay: '07:30', excludeWindows: [{ start: '22:00', end: '06:00' }] });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({
      type: 'loop',
      intervalMs: 600_000,
      nextFireAt: NOW + 600_000,
      firstFireOfDay: '07:30',
      excludeWindows: [{ id: NOW, startHHMM: '22:00', endHHMM: '06:00' }],
    });

    const when = new Date(NOW + 3_600_000).toISOString();
    await w.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: when });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ type: 'schedule', runAt: NOW + 3_600_000, nextFireAt: NOW + 3_600_000 });

    const once = (await w.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'once' })).data as Answer;
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ type: 'once', nextFireAt: 0 });
    expect(once.item.type).toBe('once');
  });

  it('reads a time with no zone as the Mac’s own, and refuses one that is not an ISO time', async () => {
    const w = queueWorld({ rows: standardRows() });
    const local = new Date(NOW + 7_200_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const written = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;

    await w.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: written });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).runAt).toBe(new Date(written).getTime());
    for (const runAt of ['tomorrow', '12', '2026-13-45T99:00', '']) {
      expect(accepts(w.tools, 'queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt }), runAt).toBe(false);
    }
  });

  it('refuses a time that has passed, and timing that does not fit its type, naming fields and never values', async () => {
    const w = queueWorld({ rows: standardRows() });

    const past = await w.refused('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: new Date(NOW - 60_000).toISOString() });
    const noInterval = await w.refused('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'loop' });
    const stray = await w.refused('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'once', intervalMs: 60_000 });

    expect([past.code, noInterval.code, stray.code]).toEqual(['INVALID', 'INVALID', 'INVALID']);
    expect(w.store.writes).toEqual([]);
  });

  it('is limited, at the argument check, to a loop of one second to 30 days and quiet hours that are clock times', () => {
    const w = queueWorld();
    const base = { id: 's1', itemId: 1, type: 'loop' };

    expect(accepts(w.tools, 'queue_set_item_schedule', { ...base, intervalMs: 999 })).toBe(false);
    expect(accepts(w.tools, 'queue_set_item_schedule', { ...base, intervalMs: 30 * 24 * 3_600_000 + 1 })).toBe(false);
    expect(accepts(w.tools, 'queue_set_item_schedule', { ...base, intervalMs: 60_000, firstFireOfDay: '7:30' })).toBe(false);
    expect(accepts(w.tools, 'queue_set_item_schedule', { ...base, intervalMs: 60_000, excludeWindows: [{ start: '25:00', end: '01:00' }] })).toBe(false);
    expect(accepts(w.tools, 'queue_set_item_schedule', { ...base, intervalMs: 60_000, firstFireOfDay: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⚡ NOW and the window
// ---------------------------------------------------------------------------

describe('queue_fire_now', () => {
  it('flags the prompt for the window to start, and says so', async () => {
    const w = queueWorld({ unlocked: true, rows: standardRows() });

    const result = await w.call('queue_fire_now', { id: 's1', itemId: 2 });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 2).forceStart).toBe(true);
    expect(result.summary).toMatch(/window/i);
    expect((result.data as Answer & { resumed: boolean }).resumed).toBe(false);
  });

  it('on a prompt partway through its chain says it released the step that waits', async () => {
    const w = queueWorld({ unlocked: true, rows: { s1: { items: [item(1, { execState: 'before', execStepIdx: 0, beforeChain: [{ id: 10, text: 'a' }] })] } } });

    const result = await w.call('queue_fire_now', { id: 's1', itemId: 1 });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ forceStart: true, execState: 'before', execStepIdx: 0 });
    expect((result.data as Answer & { resumed: boolean }).resumed).toBe(true);
    expect(result.summary).toMatch(/partway|step/i);
  });

  it('fire_now without a writer is NO_WINDOW, and nothing is read or written', async () => {
    const w = queueWorld({ unlocked: true, rows: standardRows(), writer: null });

    const err = await w.refused('queue_fire_now', { id: 's1', itemId: 1 });

    expect(err.code).toBe('NO_WINDOW');
    expect(err.hint).toMatch(/open/i);
    expect(w.store.calls).toEqual([]);
  });

  it('is refused when the presence of windows cannot be read: it is not sent into the dark', async () => {
    const w = queueWorld({ unlocked: true, rows: standardRows(), routes: { 'GET /presence': fail(500, 'boom') } });

    const err = await w.refused('queue_fire_now', { id: 's1', itemId: 1 });

    expect(err.code).toBe('UPSTREAM');
    expect(w.store.calls).toEqual([]);
  });

  it.each([
    ['an approval', { status: 'approval' }],
    ['a question', { status: 'input' }],
    ['a permission request', { pendingRequest: { id: 'r1', kind: 'permission', cli: 'claude', tool: 'Bash' } }],
    ['a plan', { pendingRequest: { id: 'r2', kind: 'plan', cli: 'claude', tool: 'ExitPlanMode' } }],
  ])('refuses a session that waits on %s: typed there, the prompt’s Enter would answer it', async (_what, over) => {
    const w = queueWorld({ unlocked: true, sessions: [worker('s1', over as never)], rows: standardRows() });

    const err = await w.refused('queue_fire_now', { id: 's1', itemId: 1 });

    expect(err.code).toBe('BUSY');
    expect(err.hint).toContain('request_answer');
    expect(w.store.calls).toEqual([]);
  });

  it('does not hold back the other writes for a session that waits on an answer: the scheduler sends only when it is ready', async () => {
    const w = queueWorld({ unlocked: true, sessions: [worker('s1', { status: 'approval' })], rows: standardRows() });

    await expect(w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' })).resolves.toBeDefined();
    await expect(w.call('queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true })).resolves.toBeDefined();
  });

  it('refuses a paused prompt and a paused queue, writing nothing', async () => {
    const paused = queueWorld({ unlocked: true, rows: { s1: { items: [item(1, { disabled: true })] } } });
    const held = queueWorld({ unlocked: true, rows: { s1: { items: [item(1)], automation: automationOf({ paused: true }) } } });

    const a = await paused.refused('queue_fire_now', { id: 's1', itemId: 1 });
    const b = await held.refused('queue_fire_now', { id: 's1', itemId: 1 });

    expect([a.code, b.code]).toEqual(['INVALID', 'INVALID']);
    expect(paused.store.writes).toEqual([]);
    expect(held.store.writes).toEqual([]);
  });

  it('is NOT_FOUND for a prompt that is not there', async () => {
    const w = queueWorld({ unlocked: true, rows: standardRows() });

    expect((await w.refused('queue_fire_now', { id: 's1', itemId: NEEDLE })).code).toBe('NOT_FOUND');
  });
});

describe('the window', () => {
  const writes: Array<[string, Record<string, unknown>]> = CASES.filter(([name]) => name !== 'queue_fire_now');

  it.each(writes)('%s succeeds with no window open, and says the queue runs when the AASC window is open', async (name, args) => {
    const w = queueWorld({ rows: standardRows(), routes: RESUME_ROUTE, writer: null, unlocked: STARTS.has(name) });

    const result = await w.call(name, args);

    expect(result.summary).toContain('runs when the AASC window is open');
    expect((result.data as Answer).windowOpen).toBe(false);
  });

  it('says nothing about the window when one is open', async () => {
    const w = queueWorld({ rows: standardRows() });

    const result = await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(result.summary).not.toMatch(/AASC window/);
    expect((result.data as Answer).windowOpen).toBe(true);
  });

  it('still writes when presence cannot be read, saying only that the queue runs when the window is open', async () => {
    const w = queueWorld({ rows: standardRows(), routes: { 'GET /presence': fail(500, 'boom') } });

    const result = await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(w.store.writes).toHaveLength(1);
    expect((result.data as Answer).windowOpen).toBeNull();
    expect(result.summary).toContain('runs when the AASC window is open');
    expect(result.summary).not.toMatch(/none is open|no AASC window/i);
  });
});

// ---------------------------------------------------------------------------
// Chain steps
// ---------------------------------------------------------------------------

describe('chain steps', () => {
  it('queue_add_step adds a step to the chain named, at the end or at a position', async () => {
    const w = queueWorld({ rows: standardRows() });

    const first = (await w.call('queue_add_step', { id: 's1', itemId: 1, chain: 'before', text: 'second step' })).data as Answer & { stepId: number };
    await w.call('queue_add_step', { id: 's1', itemId: 1, chain: 'before', text: 'zeroth step', position: 0 });

    const stored = itemWith(w.store.rows.get('s1')?.items ?? [], 1);
    expect((stored.beforeChain as Array<{ text: string }>).map((s) => s.text)).toEqual(['zeroth step', 'first step', 'second step']);
    expect(first.stepId).toBe(NOW);
    expect(first.item.beforeCount).toBe(2);
  });

  it('queue_edit_step changes a step’s text and queue_remove_step takes one out', async () => {
    const w = queueWorld({ rows: standardRows() });

    await w.call('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: 'changed' });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).beforeChain).toEqual([{ id: 10, text: 'changed' }]);

    await w.call('queue_remove_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10 });
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).not.toHaveProperty('beforeChain');
  });

  it('queue_move_step moves a step within its chain, answering from and to', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1, { disabled: true, afterChain: [{ id: 20, text: 'a' }, { id: 21, text: 'b' }] })] } } });

    const answer = (await w.call('queue_move_step', { id: 's1', itemId: 1, chain: 'after', stepId: 21, position: 0 })).data as Answer & { moved: { from: number; to: number } };

    expect((itemWith(w.store.rows.get('s1')?.items ?? [], 1).afterChain as Array<{ id: number }>).map((s) => s.id)).toEqual([21, 20]);
    expect(answer.moved).toEqual({ from: 1, to: 0 });
  });

  it('refuse a step that is not there, and a change to the steps of a prompt that is partway through its chain', async () => {
    const w = queueWorld({ rows: standardRows() });
    // A running chain is a prompt that is on, whose steps are locked (Ruling 43): let through, to check the op's BUSY.
    const running = queueWorld({ unlocked: true, rows: { s1: { items: [item(1, { execState: 'before', execStepIdx: 0, beforeChain: [{ id: 10, text: 'a' }] })] } } });

    expect((await w.refused('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: NEEDLE, text: 'x' })).code).toBe('NOT_FOUND');
    expect((await running.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'before', text: 'x' })).code).toBe('BUSY');
    expect((await running.refused('queue_remove_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10 })).code).toBe('BUSY');
    expect((await running.refused('queue_move_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, position: 0 })).code).toBe('BUSY');
    await expect(running.call('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: 'fine' })).resolves.toBeDefined();
  });

  it('refuse a blank step and a shell line', async () => {
    const w = queueWorld({ rows: standardRows() });

    expect((await w.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: '  ' })).code).toBe('INVALID');
    expect((await w.refused('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: '!ls' })).code).toBe('INVALID');
  });

  it('accept only the chains before and after', () => {
    const w = queueWorld();

    expect(accepts(w.tools, 'queue_add_step', { id: 's1', itemId: 1, chain: 'middle', text: 'x' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

describe('automation', () => {
  const stored = (w: ReturnType<typeof queueWorld>) => w.store.rows.get('s1')?.automation as Record<string, unknown>;

  // Resuming the queue, auto-send on and the looser automation rules are locked until P4 (Rulings 42 and 43,
  // tools.queueWriteLock*.test.ts); where a test here needs them, the lock is let through to check what the op does.
  // With no record stored a central changes no switch (Ruling 52), so these queues store one.
  it('queue_set_paused pauses and resumes the queue, keeping the other switches', async () => {
    const w = queueWorld({ unlocked: true, rows: { s1: { items: queueOf(1), automation: automationOf({ autoSend: false }) } } });

    const paused = await w.call('queue_set_paused', { id: 's1', paused: true });
    expect(stored(w)).toMatchObject({ paused: true, autoSend: false });
    expect(paused.summary).toMatch(/paused/);
    expect((paused.data as { automation: { paused: boolean } }).automation.paused).toBe(true);

    await w.call('queue_set_paused', { id: 's1', paused: false });
    expect(stored(w)).toMatchObject({ paused: false, autoSend: false });
  });

  it('queue_set_auto_send turns the session’s auto-send on and off', async () => {
    const w = queueWorld({ unlocked: true, rows: { s1: { items: queueOf(1), automation: automationOf() } } });

    await w.call('queue_set_auto_send', { id: 's1', autoSend: false });
    expect(stored(w)).toEqual(automationOf({ autoSend: false }));

    await w.call('queue_set_auto_send', { id: 's1', autoSend: true });
    expect(stored(w)).toEqual(automationOf());
  });

  it('queue_set_automation sets the other fields it is given', async () => {
    const w = queueWorld({ unlocked: true, rows: { s1: { items: queueOf(1), automation: automationOf({ paused: true }) } } });

    const result = await w.call('queue_set_automation', {
      id: 's1',
      autoEnter: false,
      idleGuard: false,
      skipWhenPrompting: false,
      autoResume: false,
      resumeMaxRetries: 5,
      resumePrompt: 'carry on please',
      loopExcludeWindows: [{ start: '23:00', end: '06:30' }],
    });

    expect(stored(w)).toMatchObject({
      paused: true,
      autoEnter: false,
      idleGuard: false,
      skipWhenPrompting: false,
      autoResume: false,
      resumeMaxRetries: 5,
      resumePrompt: 'carry on please',
      loopExcludeWindows: [{ id: NOW, startHHMM: '23:00', endHHMM: '06:30' }],
    });
    const data = result.data as { automation: { resumePrompt: string | null; loopExcludeWindows: unknown[] } };
    expectFenced(data.automation.resumePrompt, 'queue-resume-prompt', 'session:s1');
    expect(data.automation.loopExcludeWindows).toEqual([{ start: '23:00', end: '06:30' }]);
    expect(outsideFences(result.summary)).not.toContain('carry on please');
  });

  it('queue_set_automation refuses a call that changes nothing, a retry count outside 1 to 10, and a shell line', async () => {
    const w = queueWorld({ unlocked: true, rows: { s1: { items: queueOf(1), automation: automationOf() } } });

    expect((await w.refused('queue_set_automation', { id: 's1' })).code).toBe('INVALID');
    expect((await w.refused('queue_set_automation', { id: 's1', resumePrompt: '!rm -rf ~' })).code).toBe('INVALID');
    expect(accepts(w.tools, 'queue_set_automation', { id: 's1', resumeMaxRetries: 11 })).toBe(false);
    expect(accepts(w.tools, 'queue_set_automation', { id: 's1', resumeMaxRetries: 0 })).toBe(false);
    expect(w.store.writes).toEqual([]);
  });

  it('queue_resume_after_cancel asks the route to release the hold, and says whether there was one', async () => {
    const held = queueWorld({ unlocked: true, routes: { 'POST /sessions/s1/queue/resume': ok({ ok: true, resumed: true }) } });
    const free = queueWorld({ unlocked: true, routes: { 'POST /sessions/s1/queue/resume': ok({ ok: true, resumed: false }) } });

    const a = await held.call('queue_resume_after_cancel', { id: 's1' });
    const b = await free.call('queue_resume_after_cancel', { id: 's1' });

    expect(held.client.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/sessions/s1/queue/resume' }]);
    expect(a.data).toMatchObject({ resumed: true });
    expect(b.data).toMatchObject({ resumed: false });
    expect(a.summary).not.toEqual(b.summary);
    expect(held.store.calls).toEqual([]);
  });

  it('queue_resume_after_cancel turns a failed route into the refusal its status asks for', async () => {
    const w = queueWorld({ unlocked: true, routes: { 'POST /sessions/s1/queue/resume': fail(404, 'Session not found') } });

    expect((await w.refused('queue_resume_after_cancel', { id: 's1' })).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// What every tool does about the session it is told to change
// ---------------------------------------------------------------------------

describe('the steering rails', () => {
  it.each(CASES)('%s refuses a hands-off session before it reads or writes anything', async (name, args) => {
    const w = queueWorld({ unlocked: true, sessions: [worker('s1', { handsOff: true })], rows: standardRows(), routes: RESUME_ROUTE });

    const err = await w.refused(name, args);

    expect(err.code).toBe('HANDS_OFF');
    expect(w.store.calls).toEqual([]);
    expect(w.client.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it.each(CASES)('%s refuses a session a person drove a moment ago', async (name, args) => {
    const w = queueWorld({
      unlocked: true,
      rows: standardRows(),
      routes: RESUME_ROUTE,
      controller: () => ({ clientId: 'device-1', lastActivityAt: NOW - 5_000 }),
    });

    const err = await w.refused(name, args);

    expect(err.code).toBe('HUMAN_ACTIVE');
    expect(w.store.calls).toEqual([]);
  });

  it.each(CASES)('%s refuses a session outside the central’s scope, saying no more', async (name, args) => {
    const w = queueWorld({
      unlocked: true,
      central: makeCentral('room', 'r1'),
      sessions: [worker('s1', { title: 'TOP SECRET' })],
      rooms: [makeRoom('r1', [])],
      rows: standardRows(),
      routes: RESUME_ROUTE,
    });

    const err = await w.refused(name, args);

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(`${err.message} ${err.hint}`).not.toMatch(/TOP SECRET|s1/);
    expect(w.store.calls).toEqual([]);
  });

  it('refuses a session that no one has, and a session that cannot be typed into (no terminal, ended)', async () => {
    const w = queueWorld({ sessions: [worker('s1'), worker('s2', { terminalId: null }), worker('s3', { status: 'ended' })], rows: standardRows() });

    expect((await w.refused('queue_add_item', { id: 'nobody-here', text: 'x' })).code).toBe('NOT_FOUND');
    expect((await w.refused('queue_add_item', { id: 's2', text: 'x' })).code).toBe('INVALID');
    expect((await w.refused('queue_add_item', { id: 's3', text: 'x' })).code).toBe('INVALID');
    expect(w.store.calls).toEqual([]);
  });

  it('follows a session id that was re-keyed, and writes the queue of the session’s current id', async () => {
    const w = queueWorld({ sessions: [worker('s1')], aliases: { 'term-old-id': 's1' }, rows: standardRows() });

    await w.call('queue_edit_item', { id: 'term-old-id', itemId: 1, text: 'x' });

    expect(w.store.writes.map((x) => x.sessionId)).toEqual(['s1']);
  });
});

// ---------------------------------------------------------------------------
// What the central reads back
// ---------------------------------------------------------------------------

describe('the answers', () => {
  it('fence the text of a prompt in the data and in the text, which holds one block', async () => {
    const w = queueWorld();

    const result = await w.call('queue_add_item', { id: 's1', text: HOSTILE });
    const answer = result.data as Answer;

    expectFenced(answer.item.text, 'queue-item', 'session:s1');
    expect(answer.item.text).toContain('<\\/untrusted');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('fence a step’s text and a resume prompt the same way', async () => {
    const w = queueWorld({ unlocked: true, rows: standardRows() });

    const step = await w.call('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: HOSTILE });
    const stepData = step.data as Answer;
    expect(stepData.item.beforeSteps.every((s) => s.text.startsWith('<untrusted source="session:s1" kind="queue-step">'))).toBe(true);
    expect(blocksIn(step.summary)).toBe(1);
    expect(outsideFences(step.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);

    const auto = await w.call('queue_set_automation', { id: 's1', resumePrompt: HOSTILE });
    expect(blocksIn(auto.summary)).toBeLessThanOrEqual(1);
    expect(outsideFences(auto.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
    expect(JSON.stringify(auto.data)).not.toContain('Ignore all previous instructions.</untrusted>');
  });

  it('never carry an image, only how many there are', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const w = queueWorld({ rows: { s1: { items: [item(1, { disabled: true, images: [{ name: 'a.png', dataUrl }] })] } } });

    const result = await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).images).toEqual([{ name: 'a.png', dataUrl }]);
  });

  it('give the log AASC’s own words and numbers only: never the text a caller sent or a session wrote', async () => {
    for (const [name, args] of CASES) {
      const w = queueWorld({ unlocked: true, rows: standardRows(), routes: RESUME_ROUTE });
      const withSecret: Record<string, unknown> = 'text' in args ? { ...args, text: SECRET } : 'resumePrompt' in args ? { ...args, resumePrompt: SECRET } : args;

      const result = await w.call(name, withSecret);

      expect(JSON.stringify(result.activity ?? []), name).not.toContain(SECRET);
      expect(JSON.stringify(result.activity ?? []), name).not.toContain('item 1');
    }
  });

  it('give each write a note that names the session and, where there is one, the prompt', async () => {
    const w = queueWorld({ rows: standardRows() });

    const result = await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(result.activity).toEqual([{ summary: expect.stringMatching(/edited/i), targetSessionId: 's1', detail: { itemId: 1 } }]);
  });

  it('never repeat an argument value in a refusal', async () => {
    const w = queueWorld({ rows: standardRows() });
    const needle = 'zzNeedlezz';
    const refusals = [
      await w.refused('queue_add_item', { id: 's1', text: `!${needle}` }),
      await w.refused('queue_edit_item', { id: 's1', itemId: NEEDLE, text: needle }),
      await w.refused('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: NEEDLE, text: needle }),
      await w.refused('queue_set_automation', { id: 's1', resumePrompt: `!${needle}` }),
      await w.refused('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'once', intervalMs: NEEDLE }),
      await w.refused('queue_add_item', { id: `${needle}-nobody`, text: 'x' }),
    ];

    for (const err of refusals) {
      const said = `${err.message} ${err.hint ?? ''}`;
      expect(said).not.toContain(needle);
      expect(said).not.toContain(String(NEEDLE));
    }
  });
});

describe('a queue the window saved a moment ago', () => {
  it('is part of what a write builds on: the tool reads the latest row at the moment it writes', async () => {
    const w = queueWorld({ rows: { s1: { items: queueOf(1) } } });

    await w.call('queue_add_item', { id: 's1', text: 'central’s item' });
    // The window's own save lands between the two calls.
    w.store.rows.set('s1', { items: [...(w.store.rows.get('s1')?.items ?? []), item(777, { text: 'window’s edit', position: 2 })], automation: null });
    await w.call('queue_add_item', { id: 's1', text: 'central’s second item' });

    const texts = (w.store.rows.get('s1')?.items ?? []).map((i) => (i as { text: string }).text);
    expect(texts).toEqual(['item 1', 'central’s item', 'window’s edit', 'central’s second item']);
  });
});

describe('presence', () => {
  it('is not read for a call that is refused', async () => {
    const w = queueWorld({ sessions: [worker('s1', { handsOff: true })], rows: standardRows() });

    await w.refused('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(w.client.calls).toEqual([]);
  });

  it('is read once for a write, after the write', async () => {
    const w = queueWorld({ rows: standardRows() });

    await w.call('queue_edit_item', { id: 's1', itemId: 1, text: 'x' });

    expect(w.client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /presence']);
  });
});
