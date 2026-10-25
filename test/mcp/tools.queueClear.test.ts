// test/mcp/tools.queueClear.test.ts — `queue_clear` (server/mcp/tools/queueClear.ts, Ruling P5-10): a destructive tool
// that takes every prompt out of a session's queue, and only the prompts the person was shown. The steering rails come
// first; an empty queue needs no card; anything else always asks, a central's own worker included. After the allow the
// gate asks `confirm` again, and a queue that changed (a prompt added, one sent, one rewritten or switched) runs nothing.
// The gate is driven through runTool over a real confirmation book and a fake queue store; the window-save stopgap
// (Ruling 54) is driven over the real server queue store with the database and the socket mocked. Nothing reaches a
// route, SQLite or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { changedRefusal, createConfirmBook, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { QueueStore } from '../../server/mcp/queueOps.js';
import { recordQueuePut } from '../../server/mcp/queuePutRefusals.js';
import { serverQueueStore } from '../../server/mcp/queueWiring.js';
import { allTools, confirmRuleViolations, type ConfirmAsk, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { createQueueClearTool, queueClearTool } from '../../server/mcp/tools/queueClear.js';
import { RAILS } from '../../server/mcp/tools/queueWriteKit.js';
import { systemWriteTools } from '../../server/mcp/tools/systemWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { automationOf, fakeQueueStore, item, type FakeQueueStore } from './queueFixtures.js';
import { presence, worker } from './queueToolFixtures.js';
import { fakeClient, makeCentral, makeCtx, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** The live store's pieces (queueWiring.ts), mocked: rows in memory, no socket. */
const live = vi.hoisted(() => ({
  rows: new Map<string, { sessionId: string; items: unknown[]; automation: unknown; updatedAt: number }>(),
  upserts: [] as string[],
  sent: [] as unknown[],
}));
vi.mock('../../server/db.js', () => ({
  getSessionQueue: (sessionId: string) => live.rows.get(sessionId) ?? null,
  upsertSessionQueue: (sessionId: string, items: unknown[], automation: unknown) => {
    live.upserts.push(sessionId);
    const record = { sessionId, items, automation: automation ?? null, updatedAt: 9 };
    live.rows.set(sessionId, record);
    return record;
  },
}));
vi.mock('../../server/sessionStore.js', () => ({ resolveSessionId: (id: string) => id }));
vi.mock('../../server/wsManager.js', () => ({ broadcast: (m: unknown) => live.sent.push(m) }));

/** Three prompts, two on; the first has a second line the card never shows. */
const threeRows = () => ({
  s1: {
    items: [
      item(1, { position: 0, text: 'Run the tests\nthen paste every failure here in full' }),
      item(2, { position: 1, disabled: true, text: 'Write the summary' }),
      item(3, { position: 2, type: 'loop', intervalMs: 60_000, text: 'Check the build' }),
    ],
    automation: automationOf(),
  },
});

const books: ConfirmBook[] = [];

/** The Mac's window is open: a person can answer the card there, and it runs the queue. */
const macOpen = (): Record<string, Answer> => ({
  'GET /presence': ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } }),
});

interface WorldOptions {
  rows?: Parameters<typeof fakeQueueStore>[0];
  /** Replaces the fake store (the stopgap test passes the server's own). */
  store?: QueueStore;
  sessions?: (centralId: string) => Session[];
}

/** A global central calling `queue_clear` through the real gate, the window open, over `store`. */
function world(o: WorldOptions = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const card = makeSession('card-1', {
    terminalId: 'term-card',
    central: { centralId: central.centralId, kind: 'global', scopeRef: null },
  });
  const sessions: Session[] = o.sessions?.(central.centralId) ?? [card, worker('s1'), worker('s2', { handsOff: true }), worker('s3')];
  const fake: FakeQueueStore = fakeQueueStore(o.rows ?? threeRows());
  const store = o.store ?? fake;
  const tool = createQueueClearTool({ store: async () => store });
  const t = testDeliver({
    sessions: () => sessions,
    controller: (id) => (id === 's3' ? { clientId: 'device-1', lastActivityAt: NOW - 5_000 } : null),
  });
  const book = createConfirmBook();
  books.push(book);
  const client = fakeClient(macOpen());
  const deps: McpDeps = {
    registry,
    client: () => client,
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
    confirms: book,
    tools: () => [tool, ...systemWriteTools],
  };
  const call = (args: Record<string, unknown>) =>
    runTool(tool, args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
  return { call, book, fake, tool, rows: () => t.activity.listActivity().reverse() };
}

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

afterEach(() => {
  for (const b of books.splice(0)) b.close();
  live.rows.clear();
  live.upserts.length = 0;
  live.sent.length = 0;
});

describe('queue_clear', () => {
  it('asks with the count, the switched-on count and the first lines, then clears once allowed', async () => {
    const w = world();

    const call = w.call({ id: 's1' });
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    const card = w.book.pending()[0];
    expect(card).toMatchObject({
      tool: 'queue_clear',
      risk: 'destructive',
      summary: 'clear the queue of session s1: 3 prompts (2 switched on)',
      targetSessionId: 's1',
    });
    expect(card.detail).toBe('- Run the tests\n- Write the summary\n- Check the build');
    // Nothing is written until the person allows it.
    expect(w.fake.writes).toEqual([]);

    w.book.answer(card.cardId, 'allow');
    const result = (await call) as { data: Record<string, unknown>; summary: string };

    expect(w.fake.writes).toHaveLength(1);
    expect(w.fake.writes[0]).toMatchObject({ sessionId: 's1', items: [], originClientId: expect.stringMatching(/^mcp:/) });
    // The switches stay as stored.
    expect(w.fake.writes[0].automation).toEqual(automationOf());
    expect(result.data).toEqual({ id: 's1', shortId: 's1', cleared: 3, queue: { count: 0, enabled: 0 }, windowOpen: true, allowedByPerson: { answeredOn: 'mac' } });
    expect(result.summary).toContain('Cleared 3 prompts from the queue of session s1.');
    const done = w.rows().find((r) => (r as { tool?: string; outcome?: string }).tool === 'queue_clear' && (r as { outcome?: string }).outcome === 'ok');
    expect(done).toMatchObject({ targetSessionId: 's1' });
  });

  it('a prompt added after the card is not removed', async () => {
    const w = world();

    const call = w.call({ id: 's1' });
    const failed = failureOf(call);
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    // The window adds a prompt while the card waits.
    const row = w.fake.rows.get('s1');
    w.fake.rows.set('s1', { items: [...(row?.items ?? []), item(NOW, { position: 3, text: 'the new one' })], automation: row?.automation ?? null });
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    const err = await failed;
    expect({ code: err.code, message: err.message, hint: err.hint }).toEqual({
      code: changedRefusal().code,
      message: changedRefusal().message,
      hint: changedRefusal().hint,
    });
    expect(w.fake.writes).toEqual([]);
    expect(w.fake.rows.get('s1')?.items).toHaveLength(4);
  });

  it('a prompt rewritten or switched on after the card is CHANGED too: the person saw its first line and the count', async () => {
    for (const change of [{ text: 'Delete the branch' }, { disabled: false }]) {
      const w = world();
      const failed = failureOf(w.call({ id: 's1' }));
      await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
      const row = w.fake.rows.get('s1');
      const items = (row?.items ?? []).map((i) => ((i as { id?: number }).id === 2 ? { ...i, ...change } : i));
      w.fake.rows.set('s1', { items, automation: row?.automation ?? null });
      w.book.answer(w.book.pending()[0].cardId, 'allow');

      expect((await failed).message).toBe(changedRefusal().message);
      expect(w.fake.writes).toEqual([]);
    }
  });

  it('a chain step added, rewritten or removed while the card waits is CHANGED, and so is a timing change', async () => {
    const withSteps = () => ({
      s1: {
        items: [
          item(1, { position: 0, text: 'Run the tests', beforeChain: [{ id: 11, text: 'cd packages/app' }], afterChain: [] }),
          item(2, { position: 1, type: 'loop', intervalMs: 60_000, nextFireAt: 5_000, text: 'Check the build' }),
        ],
        automation: automationOf(),
      },
    });
    const edits: Array<[string, (items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>]> = [
      ['a step added', (items) => items.map((i) => (i.id === 1 ? { ...i, afterChain: [{ id: 12, text: 'git push --force' }] } : i))],
      ['a step rewritten', (items) => items.map((i) => (i.id === 1 ? { ...i, beforeChain: [{ id: 11, text: 'rm -rf node_modules' }] } : i))],
      ['a step removed', (items) => items.map((i) => (i.id === 1 ? { ...i, beforeChain: [] } : i))],
      ['an interval changed', (items) => items.map((i) => (i.id === 2 ? { ...i, intervalMs: 1_000 } : i))],
      ['a run time changed', (items) => items.map((i) => (i.id === 2 ? { ...i, type: 'schedule', runAt: 9_000, nextFireAt: 9_000 } : i))],
    ];
    for (const [name, edit] of edits) {
      const w = world({ rows: withSteps() });
      const failed = failureOf(w.call({ id: 's1' }));
      await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
      const row = w.fake.rows.get('s1');
      w.fake.rows.set('s1', { items: edit((row?.items ?? []) as Array<Record<string, unknown>>), automation: row?.automation ?? null });
      w.book.answer(w.book.pending()[0].cardId, 'allow');

      expect((await failed).message, name).toBe(changedRefusal().message);
      expect(w.fake.writes, name).toEqual([]);
    }
  });

  it('the card says how many chain steps a prompt has: "(+N chain steps)" on its row, nothing on one with none', async () => {
    const rows = {
      s1: {
        items: [
          item(1, { position: 0, text: 'Run the tests', beforeChain: [{ id: 11, text: 'a' }], afterChain: [{ id: 12, text: 'b' }, { id: 13, text: 'c' }] }),
          item(2, { position: 1, text: 'One step only', afterChain: [{ id: 14, text: 'd' }] }),
          item(3, { position: 2, text: 'Plain' }),
        ],
        automation: automationOf(),
      },
    };
    const h = makeCtx({ sessions: [worker('s1')] });
    const tool = createQueueClearTool({ store: async () => fakeQueueStore(rows) });

    const ask = (await tool.confirm?.({ id: 's1' }, h.ctx)) as ConfirmAsk;

    expect(ask.detail).toBe('- Run the tests (+3 chain steps)\n- One step only (+1 chain step)\n- Plain');
  });

  it('run refuses when the queue it is about to clear differs from the one the person approved, even if its own read looks fine', async () => {
    const store = fakeQueueStore(threeRows());
    let allowed = false;
    const h = makeCtx({ sessions: [worker('s1')], allowedByPerson: () => allowed });
    const tool = createQueueClearTool({ store: async () => store });
    const ask = (await tool.confirm?.({ id: 's1' }, h.ctx)) as ConfirmAsk;
    expect(ask.fingerprint).toEqual(expect.any(String));
    // Between the recheck and run's read the queue gains a prompt (an `await` here would be where I/O is added later).
    const row = store.rows.get('s1');
    store.rows.set('s1', { items: [...(row?.items ?? []), item(NOW, { position: 3, text: 'the new one' })], automation: row?.automation ?? null });
    allowed = true;

    const err = await failureOf(tool.run({ id: 's1' }, h.ctx));

    expect(err.code).toBe('INVALID');
    expect(err.message).toBe('The queue changed since the person was asked.');
    expect(store.writes).toEqual([]);
    expect(store.rows.get('s1')?.items).toHaveLength(4);
  });

  it('run clears the queue the person approved: the digest confirm made in this call is the one run checks', async () => {
    const store = fakeQueueStore(threeRows());
    const h = makeCtx({ sessions: [worker('s1')], allowedByPerson: () => true });
    const tool = createQueueClearTool({ store: async () => store });
    await tool.confirm?.({ id: 's1' }, h.ctx);

    const result = (await tool.run({ id: 's1' }, h.ctx)) as { data: { cleared: number } };

    expect(result.data.cleared).toBe(3);
    expect(store.writes).toHaveLength(1);
  });

  it('a run marked allowed that no confirm of this call preceded clears nothing', async () => {
    const store = fakeQueueStore(threeRows());
    const h = makeCtx({ sessions: [worker('s1')], allowedByPerson: () => true });
    const tool = createQueueClearTool({ store: async () => store });

    const err = await failureOf(tool.run({ id: 's1' }, h.ctx));

    expect(err.code).toBe('INVALID');
    expect(store.writes).toEqual([]);
  });

  it('an empty queue answers cleared 0 with no card and no write', async () => {
    const w = world({ rows: { s1: { items: [], automation: automationOf() } } });

    const result = (await w.call({ id: 's1' })) as { data: Record<string, unknown>; summary: string };

    expect(w.book.pending()).toEqual([]);
    expect(w.fake.writes).toEqual([]);
    expect(result.data).toMatchObject({ id: 's1', cleared: 0, queue: { count: 0, enabled: 0 } });
    expect(result.summary).toContain('already empty');
  });

  it('the steering rails apply before any card (hands-off, 60 s)', async () => {
    const w = world();

    const handsOff = await failureOf(w.call({ id: 's2' }));
    const driven = await failureOf(w.call({ id: 's3' }));

    expect(handsOff.code).toBe('HANDS_OFF');
    expect(driven.code).toBe('HUMAN_ACTIVE');
    expect(w.book.pending()).toEqual([]);
    // Refused before the queue is read.
    expect(w.fake.calls).toEqual([]);
  });

  it('a central’s write to a queue whose last window save was refused is refused', async () => {
    live.rows.set('s1', { sessionId: 's1', items: threeRows().s1.items, automation: automationOf(), updatedAt: 1 });
    recordQueuePut('s1', false, 'win-1');
    const w = world({ store: serverQueueStore() });

    const failed = failureOf(w.call({ id: 's1' }));
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    const err = await failed;
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toContain('last save from the AASC window failed');
    expect(live.upserts).toEqual([]);
    expect(live.sent).toEqual([]);
    recordQueuePut('s1', true, 'win-1');
  });

  it('the detail lists first lines, not whole prompts: each cut at 80 characters, the whole within 2 000', async () => {
    const long = `${'a'.repeat(120)}\nthe second line`;
    const many = Array.from({ length: 60 }, (_, i) => item(i + 1, { position: i, text: i === 0 ? long : `prompt ${i + 1} ${'b'.repeat(60)}` }));
    const h = makeCtx({ sessions: [worker('s1')] });
    const tool = createQueueClearTool({ store: async () => fakeQueueStore({ s1: { items: many } }) });

    const ask = (await tool.confirm?.({ id: 's1' }, h.ctx)) as ConfirmAsk;

    const detail = ask.detail ?? '';
    expect(detail.length).toBeLessThanOrEqual(2_000);
    const lines = detail.split('\n');
    expect(lines[0]).toBe(`- ${'a'.repeat(79)}…`);
    expect(detail).not.toContain('the second line');
    for (const line of lines.slice(0, -1)) expect(line.length).toBeLessThanOrEqual(2 + 80);
    expect(lines.at(-1)).toMatch(/^… and \d+ more$/);
    const shown = lines.length - 1;
    expect(Number(/(\d+) more/.exec(lines.at(-1) ?? '')?.[1])).toBe(60 - shown);
  });

  it('a central’s own idle worker still asks: the exemption names restart and close only', async () => {
    const central = makeCentral();
    const registry = createWorkerRegistry();
    registry.add({ centralId: central.centralId, terminalId: 'term-s1', openedAt: NOW - 60_000, folder: '/a/proj', cli: 'claude' });
    const h = makeCtx({ central, sessions: [worker('s1', { status: 'idle' })], workers: registry });
    expect(h.ctx.workers.isOwn(central.centralId, h.sessions[0])).toBe(true);
    const tool = createQueueClearTool({ store: async () => fakeQueueStore(threeRows()) });

    const ask = await tool.confirm?.({ id: 's1' }, h.ctx);

    expect(ask).toMatchObject({ summary: 'clear the queue of session s1: 3 prompts (2 switched on)', targetSessionId: 's1' });
    expect((ask as ConfirmAsk).fingerprint).toEqual(expect.any(String));
  });

  it('a run the person did not allow clears nothing, even when the queue filled after confirm said no card', async () => {
    const store = fakeQueueStore(threeRows());
    const h = makeCtx({ sessions: [worker('s1')], routes: presence('device-1') });
    const tool = createQueueClearTool({ store: async () => store });

    const err = await failureOf(tool.run({ id: 's1' }, h.ctx));

    expect(err.code).toBe('INVALID');
    expect(store.writes).toEqual([]);
  });

  it('the fingerprint is AASC-made and short, and an unknown session is NOT_FOUND before the queue is read', async () => {
    const big = Array.from({ length: 200 }, (_, i) => item(NOW + i, { position: i }));
    const store = fakeQueueStore({ s1: { items: big } });
    const h = makeCtx({ sessions: [worker('s1')] });
    const tool = createQueueClearTool({ store: async () => store });

    const ask = (await tool.confirm?.({ id: 's1' }, h.ctx)) as ConfirmAsk;
    expect((ask.fingerprint ?? '').length).toBeLessThanOrEqual(200);
    expect(ask.fingerprint).not.toContain('item ');

    store.calls.length = 0;
    const err = await failureOf(Promise.resolve(tool.confirm?.({ id: 'nobody-424242' }, h.ctx)));
    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint ?? ''}`).not.toContain('424242');
    expect(store.calls).toEqual([]);
  });

  it('loads whichever queue module is imported first (queue.ts → queueClear.ts → queueWriteKit.ts → queue.ts)', async () => {
    vi.resetModules();
    const kit = await import('../../server/mcp/tools/queueWriteKit.js');
    const clear = await import('../../server/mcp/tools/queueClear.js');
    const queue = await import('../../server/mcp/tools/queue.js');

    // Under a cycle an export read too early is undefined (vitest) or a ReferenceError (Node): neither may show.
    expect(kit.RAILS).toBe(RAILS);
    expect(clear.queueClearTool.description).toContain(RAILS);
    expect(clear.queueClearTool.description).not.toContain('undefined');
    expect(queue.queueTools).toContain(clear.queueClearTool);
  });

  it('loads when queueClear.ts is imported first, before queue.ts and the kit (the cycle cannot bite)', async () => {
    vi.resetModules();
    const clear = await import('../../server/mcp/tools/queueClear.js');
    const queue = await import('../../server/mcp/tools/queue.js');
    const kit = await import('../../server/mcp/tools/queueWriteKit.js');

    expect(clear.queueClearTool).toBeDefined();
    expect(clear.queueClearTool.description).toContain(kit.RAILS);
    expect(queue.queueTools).toContain(clear.queueClearTool);
    expect(queue.queueTools.every((t) => t !== undefined)).toBe(true);

    // And the tool still works over the kit it loads when it runs.
    const h = makeCtx({ sessions: [worker('s1')] });
    const ask = (await clear.createQueueClearTool({ store: async () => fakeQueueStore(threeRows()) }).confirm?.({ id: 's1' }, h.ctx)) as ConfirmAsk;
    expect(ask.summary).toBe('clear the queue of session s1: 3 prompts (2 switched on)');
  });

  it('is a destructive phase-5 queue tool with a confirm, and its description says the rules', () => {
    const registered = allTools().find((t) => t.name === 'queue_clear') as ToolDef;
    expect(registered).toBe(queueClearTool);
    expect(registered).toMatchObject({ toolset: 'queue', risk: 'destructive', phase: 5 });
    expect(registered.confirm).toBeTypeOf('function');
    expect(registered.description).toContain('always waits for the person to allow it');
    expect(registered.description).toContain('your own workers too');
    expect(registered.description).toContain('cleared: 0');
    expect(registered.description).toContain(RAILS);
    expect(confirmRuleViolations([registered])).toEqual([]);
  });
});
