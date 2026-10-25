// test/mcp/tools.queueWriteDefault.test.ts — the queue write tools as the registry offers them: over the server's own
// queue store (server/mcp/queueWiring.ts), which imports the database and the WebSocket manager and so is loaded on the
// first write, not when the tools are listed. queueWiring is mocked here: no test opens SQLite or a socket.
import { describe, expect, it, vi } from 'vitest';
import { automationOf, fakeQueueStore, itemWith, NOW, queueOf, type FakeQueueStore } from './queueFixtures.js';
import { presence, worker } from './queueToolFixtures.js';
import { makeCtx, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const wiring = vi.hoisted(() => ({ loads: 0, failNext: false, store: null as unknown }));
vi.mock('../../server/mcp/queueWiring.js', () => {
  wiring.loads += 1;
  return {
    serverQueueStore: () => {
      if (wiring.failNext) {
        wiring.failNext = false;
        throw new Error('the database did not open');
      }
      return wiring.store;
    },
  };
});

const ctxFor = () => makeCtx({ sessions: [worker('s1')], routes: presence('device-1') });

describe('the registered queue write tools', () => {
  it('are locked as the server is (Ruling 42): what starts an unattended run is DENIED before the store is even loaded', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['queue_set_item_enabled', { id: 's1', itemId: 1, enabled: true }],
      ['queue_fire_now', { id: 's1', itemId: 1 }],
      ['queue_set_auto_send', { id: 's1', autoSend: true }],
      ['queue_set_automation', { id: 's1', autoResume: true }],
    ];

    for (const [name, args] of calls) {
      const refusal = await runRefused(name, args, ctxFor().ctx);
      expect(refusal.code, name).toBe('DENIED');
    }

    expect(wiring.loads).toBe(0);
  });

  it('load the server’s queue store on the first write, not before, and keep it for the writes after', async () => {
    // Importing the registry (the harness does) listed every tool; nothing has been written yet.
    expect(wiring.loads).toBe(0);
    // Each holds an automation record: with none stored, pausing is refused (Ruling 52).
    const first: FakeQueueStore = fakeQueueStore({ s1: { items: queueOf(1), automation: automationOf() } });
    wiring.store = first;

    await run('queue_add_item', { id: 's1', text: 'through the server store' }, ctxFor().ctx);

    expect(wiring.loads).toBe(1);
    expect(first.writes).toHaveLength(1);
    expect(first.writes[0]).toMatchObject({ sessionId: 's1', originClientId: 'mcp:central-1' });
    expect(itemWith(first.writes[0].items, NOW)).toMatchObject({ text: 'through the server store', disabled: true });

    // A store the tools were asked for again would be this one; they keep the first.
    const second: FakeQueueStore = fakeQueueStore({ s1: { items: queueOf(1), automation: automationOf() } });
    wiring.store = second;
    await run('queue_set_paused', { id: 's1', paused: true }, ctxFor().ctx);

    expect(first.writes).toHaveLength(2);
    expect(second.writes).toHaveLength(0);
  });
});

describe('a store that fails to load', () => {
  it('fails the write, and is tried again by the next one rather than remembered as failed', async () => {
    vi.resetModules();
    wiring.loads = 0;
    wiring.failNext = true;
    const store = fakeQueueStore({ s1: { items: queueOf(1) } });
    wiring.store = store;
    const harness = await import('./toolHarness.js');
    const ctx = harness.makeCtx({ sessions: [worker('s1')], routes: presence('device-1') }).ctx;

    await expect(harness.run('queue_add_item', { id: 's1', text: 'first try' }, ctx)).rejects.toThrow(/did not open/);
    expect(store.writes).toHaveLength(0);

    await harness.run('queue_add_item', { id: 's1', text: 'second try' }, ctx);
    expect(store.writes).toHaveLength(1);
  });
});
