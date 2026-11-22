// test/mcp/tools.queueAskEnable.test.ts — queue_ask_enable (Nov 22 2026): the way a central turns a queued prompt ON in a
// session it did not open. The unattended lock (Ruling 42) still refuses queue_set_item_enabled there; this tool asks the
// person on a card first, and turns the prompt on only in a run the person allowed. The rails still apply.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemWith, NOW } from './queueFixtures.js';
import { callOn, presence, standardRows, worker } from './queueToolFixtures.js';
import { fakeQueueStore } from './queueFixtures.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { queueAskEnableTool } from '../../server/mcp/tools/queueAskEnable.js';
import { confirmRuleViolations } from '../../server/mcp/registry.js';
import { ToolError } from '../../server/mcp/types.js';
import { makeCtx } from './toolHarness.js';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false }));
vi.mock('../../server/logger.js', () => ({ default: log }));
afterEach(() => vi.restoreAllMocks());

function world(opts: { allowed?: boolean; own?: boolean; session?: Parameters<typeof worker>[1] } = {}) {
  const store = fakeQueueStore(standardRows());
  const tool = queueAskEnableTool({ store: async () => store });
  const workers = createWorkerRegistry({ controller: () => null });
  if (opts.own) workers.add({ centralId: 'central-1', terminalId: 'term-s1', openedAt: NOW - 60_000, folder: '/a/proj', cli: 'claude' });
  const h = makeCtx({ sessions: [worker('s1', opts.session)], workers, routes: presence('device-1'), allowedByPerson: () => opts.allowed === true });
  const failure = async (fn: () => unknown): Promise<ToolError> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ToolError) return err;
      throw err;
    }
    throw new Error('a ToolError was expected');
  };
  return { store, tool, ctx: h.ctx, failure, run: (args: Record<string, unknown>) => callOn([tool], 'queue_ask_enable', args, h.ctx) };
}

describe('queue_ask_enable', () => {
  it('waits for the person (risk ask) and so defines its card', () => {
    const { tool } = world();
    expect(tool.risk).toBe('ask');
    expect(confirmRuleViolations([tool])).toEqual([]);
  });

  it('asks the person with the prompt and how often it runs, about that session, with a fingerprint', async () => {
    const { tool, ctx, store } = world();
    store.rows.set('s1', { ...store.rows.get('s1')!, items: [{ ...itemWith(store.rows.get('s1')!.items, 1), type: 'loop', intervalMs: 300_000 }] });
    const ask = await tool.confirm!({ id: 's1', itemId: 1 }, ctx);

    expect(ask).toMatchObject({ targetSessionId: 's1' });
    expect(ask?.summary).toMatch(/turn on a queued prompt/i);
    expect(ask?.summary).toMatch(/every 5 min/);
    expect(ask?.detail).toContain('item 1');
    expect(typeof ask?.fingerprint).toBe('string');
  });

  it('shows the chain steps that run with the prompt, and a step added after the card changes the fingerprint', async () => {
    const { tool, ctx, store } = world();
    const before = await tool.confirm!({ id: 's1', itemId: 1 }, ctx);
    expect(before?.detail).toContain('first step');

    const row = store.rows.get('s1')!;
    const changed = { ...itemWith(row.items, 1), afterChain: [{ id: 11, text: 'push to main' }] };
    store.rows.set('s1', { ...row, items: row.items.map((i) => (i.id === 1 ? changed : i)) });
    const after = await tool.confirm!({ id: 's1', itemId: 1 }, ctx);

    expect(after?.detail).toContain('push to main');
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
  });

  it('asks nothing in a session the central opened itself: there it may turn the prompt on as it is', async () => {
    const { tool, ctx } = world({ own: true });
    expect(await tool.confirm!({ id: 's1', itemId: 1 }, ctx)).toBeNull();
  });

  it('refuses a prompt that is not in the queue before any card opens', async () => {
    const w = world();
    expect((await w.failure(() => w.tool.confirm!({ id: 's1', itemId: 99 }, w.ctx))).code).toBe('NOT_FOUND');
  });

  it('turns the prompt on only in a run the person allowed', async () => {
    const refused = world();
    expect((await refused.failure(() => refused.run({ id: 's1', itemId: 1 }))).code).toBe('DENIED');
    expect(itemWith(refused.store.rows.get('s1')!.items, 1).disabled).toBe(true);

    const allowed = world({ allowed: true });
    await allowed.run({ id: 's1', itemId: 1 });
    expect(itemWith(allowed.store.rows.get('s1')!.items, 1).disabled).not.toBe(true);
  });

  it('keeps the rails after the person allowed: a hands-off session is still refused', async () => {
    const w = world({ allowed: true, session: { handsOff: true } });
    expect((await w.failure(() => w.run({ id: 's1', itemId: 1 }))).code).toBe('HANDS_OFF');
    expect(itemWith(w.store.rows.get('s1')!.items, 1).disabled).toBe(true);
  });
});
