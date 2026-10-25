// test/mcp/tools.queueWriteEndpoint.test.ts — the queue write tools over the real /mcp endpoint, as the SDK's own
// client sees them: `tools/list` (every schema must serialise, with the limits a client reads), and `tools/call` through
// the whole path (argument check, runTool, the steering rails, the activity log). The build offers P2 tools only once
// `MCP_MAX_PHASE` is 2, so this file pins it to 2: the check holds before and after the switch.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { connect, harness, runCleanups } from './endpointHarness.js';
import { automationOf, fakeQueueStore, item, itemWith, NOW } from './queueFixtures.js';
import { presence, RESUME_ROUTE, toolsOver, WRITES, worker } from './queueToolFixtures.js';
import { fakeClient, makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
vi.mock('../../server/mcp/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/mcp/registry.js')>()),
  MCP_MAX_PHASE: 2,
}));

afterEach(runCleanups);

/** An endpoint offering the queue write tools over a fake store, to a global central, with a real activity log. */
async function started(writer: string | null = 'device-1', opts: { unlocked?: boolean } = {}) {
  const sessions: Session[] = [makeSession('card-1', { terminalId: 'term-card' }), worker('s1'), worker('s2', { handsOff: true })];
  const store = fakeQueueStore({
    s1: { items: [item(1, { position: 0, beforeChain: [{ id: 10, text: 'a step' }] })], automation: automationOf() },
  });
  const t = testDeliver({ sessions: () => sessions });
  const h = await harness(
    {},
    {
      deps: {
        tools: () => [...toolsOver(store, opts)],
        sessions: () => sessions,
        rooms: () => [],
        client: () => fakeClient({ ...presence(writer), ...RESUME_ROUTE }),
        deliver: t.deliver,
      },
    },
  );
  const central = h.registry.mint(globalInput());
  const { client } = await connect(h, central.token);
  return { client, store, activity: t.activity, central };
}

describe('tools/list', () => {
  it('offers the 15 queue writes, each annotated by its risk, each with an input and an output schema', async () => {
    const { client } = await started();

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...WRITES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('tells a client each limit in the schema: 64 KiB of text, places from 0, a loop of 1 s to 30 days, 1 to 10 retries', async () => {
    const { client } = await started();
    const { tools } = await client.listTools();
    const props = (name: string) =>
      (tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] }).properties;
    const required = (name: string) => (tools.find((t) => t.name === name)?.inputSchema as { required?: string[] }).required ?? [];

    expect(props('queue_add_item').text).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 * 1024 });
    expect(props('queue_add_item').position).toMatchObject({ type: 'integer', minimum: 0 });
    expect(required('queue_add_item').sort()).toEqual(['id', 'text']);
    expect(props('queue_set_item_schedule').intervalMs).toMatchObject({ type: 'integer', minimum: 1_000, maximum: 30 * 24 * 3_600_000 });
    expect(props('queue_set_item_schedule').type).toMatchObject({ enum: ['once', 'loop', 'schedule'] });
    expect(props('queue_set_item_schedule').runAt).toMatchObject({ type: 'string' });
    expect(props('queue_set_item_schedule').excludeWindows).toMatchObject({ type: 'array', maxItems: 10 });
    expect(props('queue_add_step').chain).toMatchObject({ enum: ['before', 'after'] });
    expect(props('queue_set_automation').resumeMaxRetries).toMatchObject({ minimum: 1, maximum: 10 });
    expect(required('queue_set_automation')).toEqual(['id']);
  });
});

describe('tools/call', () => {
  it('queue_add_item: answers { ok, data } with the prompt fenced, stores it paused as mcp:<central>, and logs it', async () => {
    const { client, store, activity, central } = await started();

    const result = await client.callTool({ name: 'queue_add_item', arguments: { id: 's1', text: 'run the tests' } });

    const body = result.structuredContent as { ok: boolean; data: { item: { disabled: boolean; text: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.item.disabled).toBe(true);
    expect(body.data.item.text).toMatch(/^<untrusted source="session:s1" kind="queue-item">run the tests<\/untrusted>$/);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ sessionId: 's1', originClientId: `mcp:${central.centralId}` });
    expect(itemWith(store.writes[0].items, NOW)).toMatchObject({ text: 'run the tests', disabled: true });
    expect(activity.listActivity()).toEqual([
      expect.objectContaining({ centralId: central.centralId, tool: 'queue_add_item', risk: 'steers', targetSessionId: 's1', outcome: 'ok' }),
    ]);
  });

  it('a refused write comes back as { ok: false, code } and is in the log with its reason', async () => {
    const { client, store, activity } = await started();

    const result = await client.callTool({ name: 'queue_edit_item', arguments: { id: 's2', itemId: 1, text: 'x' } });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'HANDS_OFF' });
    expect(store.calls).toEqual([]);
    expect(activity.listActivity()).toEqual([
      expect.objectContaining({ tool: 'queue_edit_item', targetSessionId: 's2', outcome: 'refused', detail: { code: 'HANDS_OFF' } }),
    ]);
  });

  it('what Ruling 42 locks comes back as { ok: false, code: DENIED } with the hint, and is logged', async () => {
    const { client, store, activity } = await started();
    const hint = 'Only you can turn this on in AASC; a central can do it only in a session it opened itself';

    const fire = await client.callTool({ name: 'queue_fire_now', arguments: { id: 's1', itemId: 1 } });
    const enable = await client.callTool({ name: 'queue_set_item_enabled', arguments: { id: 's1', itemId: 1, enabled: true } });
    const autoSend = await client.callTool({ name: 'queue_set_auto_send', arguments: { id: 's1', autoSend: true } });
    const autoEnter = await client.callTool({ name: 'queue_set_automation', arguments: { id: 's1', autoEnter: true } });

    for (const result of [fire, enable, autoSend, autoEnter]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'DENIED', hint });
    }
    expect(store.calls).toEqual([]);
    expect(activity.listActivity().map((r) => [r.tool, r.outcome, r.detail])).toEqual([
      ['queue_set_automation', 'refused', { code: 'DENIED' }],
      ['queue_set_auto_send', 'refused', { code: 'DENIED' }],
      ['queue_set_item_enabled', 'refused', { code: 'DENIED' }],
      ['queue_fire_now', 'refused', { code: 'DENIED' }],
    ]);
  });

  it('what stays allowed still goes through: turning a prompt off, pausing, turning auto-send off', async () => {
    const { client, store } = await started();

    const off = await client.callTool({ name: 'queue_set_item_enabled', arguments: { id: 's1', itemId: 1, enabled: false } });
    const pause = await client.callTool({ name: 'queue_set_paused', arguments: { id: 's1', paused: true } });
    const autoSendOff = await client.callTool({ name: 'queue_set_auto_send', arguments: { id: 's1', autoSend: false } });

    for (const result of [off, pause, autoSendOff]) expect(result.structuredContent).toMatchObject({ ok: true });
    expect(store.writes).toHaveLength(3);
  });

  it('queue_fire_now with the lock let through (a central’s own worker, in P4) and no window open is NO_WINDOW, and logged', async () => {
    const { client, store, activity } = await started(null, { unlocked: true });

    const result = await client.callTool({ name: 'queue_fire_now', arguments: { id: 's1', itemId: 1 } });

    expect(result.structuredContent).toMatchObject({ ok: false, code: 'NO_WINDOW' });
    expect(store.calls).toEqual([]);
    expect(activity.listActivity()[0]).toMatchObject({ tool: 'queue_fire_now', outcome: 'refused', detail: { code: 'NO_WINDOW' } });
  });

  it('arguments the schema refuses are INVALID before any tool runs, and are logged too', async () => {
    const { client, store, activity } = await started();

    const noText = await client.callTool({ name: 'queue_add_item', arguments: { id: 's1' } });
    const badTime = await client.callTool({
      name: 'queue_set_item_schedule',
      arguments: { id: 's1', itemId: 1, type: 'schedule', runAt: 'tomorrow morning' },
    });

    expect(noText.structuredContent).toMatchObject({ ok: false, code: 'INVALID' });
    expect(badTime.structuredContent).toMatchObject({ ok: false, code: 'INVALID' });
    expect(JSON.stringify(badTime.structuredContent)).not.toContain('tomorrow morning');
    expect(store.calls).toEqual([]);
    expect(activity.listActivity().map((r) => [r.tool, r.outcome])).toEqual([
      ['queue_set_item_schedule', 'refused'],
      ['queue_add_item', 'refused'],
    ]);
  });

  it('queue_set_automation answers the switches with the resume prompt fenced', async () => {
    // A new resume prompt is locked until P4 (Ruling 43): let through, as for a central's own worker.
    const { client, store } = await started('device-1', { unlocked: true });

    const result = await client.callTool({ name: 'queue_set_automation', arguments: { id: 's1', resumePrompt: 'carry on', autoEnter: false } });

    const body = result.structuredContent as { ok: boolean; data: { automation: { autoEnter: boolean; resumePrompt: string } } };
    expect(body.ok).toBe(true);
    expect(body.data.automation.autoEnter).toBe(false);
    expect(body.data.automation.resumePrompt).toContain('kind="queue-resume-prompt"');
    expect(store.rows.get('s1')?.automation).toMatchObject({ autoEnter: false, resumePrompt: 'carry on' });
  });
});
