// test/mcp/tools.deliver.endpoint.test.ts — P2's delivery tools through the real /mcp endpoint, the way a central meets
// them: the phase switch (MCP_MAX_PHASE is 4 since P4, so tools/list shows the P2 tools, P3's session_create and P4's
// routing tools to a central whose toolsets have them),
// and the activity log (a success and a refusal of a write each leave a row; a read leaves none). The deliver runtime
// is the real one on fakes (deliverFixtures.ts) and the /api client a mock: nothing reaches a terminal or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allTools, MCP_MAX_PHASE } from '../../server/mcp/registry.js';
import { CORE_TOOLSETS } from '../../server/mcp/types.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { promptRoutes, worker } from './deliverToolFixtures.js';
import { runCleanups } from './endpointHarness.js';
import { connectAs, freshWorld, startWorld } from './resourceWorld.js';
import { ok } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

afterEach(runCleanups);

/** The 11 tools P2's delivery chunk adds (the queue writes of the same phase are filed by their own chunk). */
const P2_DELIVERY = [
  'prompt_send',
  'prompt_status',
  'image_upload',
  'command_run',
  'task_delegate',
  'task_wait',
  'task_get',
  'task_list',
  'task_cancel',
  'request_answer',
  'snippet_use',
] as const;

const READS: ReadonlySet<string> = new Set(['prompt_status', 'task_wait', 'task_get', 'task_list']);

describe('the phase switch', () => {
  it('reaches phase 2, and files each delivery tool in phase 2 under the toolset the catalog gives it', () => {
    const byName = new Map(allTools().map((t) => [t.name, t]));

    expect(MCP_MAX_PHASE).toBe(6);
    const toolsets: Record<string, string> = {
      prompt_send: 'prompts', prompt_status: 'prompts', image_upload: 'prompts', command_run: 'prompts',
      task_delegate: 'tasks', task_wait: 'tasks', task_get: 'tasks', task_list: 'tasks', task_cancel: 'tasks',
      request_answer: 'requests', snippet_use: 'snippets',
    };
    for (const name of P2_DELIVERY) {
      expect(byName.get(name), name).toMatchObject({ phase: 2, toolset: toolsets[name] });
    }
  });

  it('phase switch exposes the P2 tools: tools/list shows a Claude central them beside the P1 ones, each annotated by its risk', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name);
    for (const name of P2_DELIVERY) expect(names, name).toContain(name);
    expect(names).toContain('session_list');
    for (const tool of tools.filter((t) => (P2_DELIVERY as readonly string[]).includes(t.name))) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(READS.has(tool.name));
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.description?.length, tool.name).toBeGreaterThan(60);
    }
  });

  it('shows a Codex central the delivery tools of its core toolsets, but not snippet_use (a saved prompt is a Claude toolset)', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ cli: 'codex' }));

    const names = (await client.listTools()).tools.map((t) => t.name);

    for (const name of P2_DELIVERY.filter((n) => n !== 'snippet_use')) expect(names, name).toContain(name);
    expect(names).not.toContain('snippet_use');
  });

  it('shows a central only the P2 tools of its own toolsets', async () => {
    const started = await startWorld();
    const sessionsOnly = await connectAs(started, globalInput({ toolsets: ['sessions'] }));
    const tasksOnly = await connectAs(started, roomInput('r1', { toolsets: ['tasks'] }));

    const none = (await sessionsOnly.client.listTools()).tools.map((t) => t.name);
    const tasks = (await tasksOnly.client.listTools()).tools.map((t) => t.name);

    for (const name of P2_DELIVERY) expect(none, name).not.toContain(name);
    // P4's two routing tools are filed under tasks too.
    expect(tasks).toEqual(['task_delegate', 'task_wait', 'task_get', 'task_list', 'task_cancel', 'project_resolve', 'task_route']);
  });

  it('tools/list includes session_create, project_resolve, task_route for a Claude central and stays core for Codex', async () => {
    const claude = await connectAs(await startWorld(), globalInput());
    // A world of its own: one global central per AASC.
    const codex = await connectAs(await startWorld(), globalInput({ cli: 'codex' }));
    const P4 = ['session_create', 'project_resolve', 'task_route'];
    const byName = new Map(allTools().map((t) => [t.name, t]));

    const claudeNames = (await claude.client.listTools()).tools.map((t) => t.name);
    const codexTools = (await codex.client.listTools()).tools;

    for (const name of P4) expect(claudeNames, name).toContain(name);
    expect(byName.get('session_create')).toMatchObject({ phase: 3, toolset: 'sessions', risk: 'write' });
    expect(byName.get('project_resolve')).toMatchObject({ phase: 4, toolset: 'tasks', risk: 'read' });
    expect(byName.get('task_route')).toMatchObject({ phase: 4, toolset: 'tasks', risk: 'read' });
    // A Codex central keeps the core toolsets: the three are in them, and nothing outside them comes along.
    for (const name of P4) expect(codexTools.map((t) => t.name), name).toContain(name);
    for (const tool of codexTools) expect(CORE_TOOLSETS, tool.name).toContain(byName.get(tool.name)?.toolset);
    expect(codexTools.length).toBeLessThan(claudeNames.length);
  });

  it('tells a client the limits in the schemas: 8 targets, 4 images, 50 s, the three answers, no allow_always', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());
    const { tools } = await client.listTools();
    const schema = (name: string) =>
      tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };

    expect(schema('prompt_send').required).toEqual(expect.arrayContaining(['to', 'text']));
    expect(JSON.stringify(schema('prompt_send').properties.to)).toMatch(/"maxItems":8/);
    expect(schema('prompt_send').properties.imageIds).toMatchObject({ maxItems: 4 });
    expect(schema('task_wait').properties.timeoutSec).toMatchObject({ minimum: 1, maximum: 50 });
    expect(schema('request_answer').properties.choice).toMatchObject({ enum: ['allow_once', 'deny', 'option'] });
    for (const tool of tools.filter((t) => (P2_DELIVERY as readonly string[]).includes(t.name))) {
      for (const [field, spec] of Object.entries(schema(tool.name).properties ?? {})) {
        expect(spec.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The activity log
// ---------------------------------------------------------------------------

/** s1 a worker a central may steer, s2 with no terminal, w3 hands-off; the route takes prompts for s1 and w3. */
function deliveryWorld() {
  const world = freshWorld();
  world.sessions.push(worker('w3', { handsOff: true }));
  Object.assign(world.routes, promptRoutes('s1', 'w3'), {
    'POST /sessions/s1/requests/req-1/answer': ok({ success: true, data: { accepted: true } }, 202),
  });
  return world;
}

describe('a write is in the activity log, whether it went through or was refused; a read is not', () => {
  it('a refusal and a success both produce activity rows, and a read produces none', async () => {
    const world = deliveryWorld();
    const t = testDeliver({ sessions: () => world.sessions });
    const started = await startWorld(world, { deliver: t.deliver });
    const { client, central } = await connectAs(started, globalInput());
    const SECRET = 'my-bank-password-hunter2';

    const sent = await client.callTool({ name: 'prompt_send', arguments: { to: 's1', text: `look at ${SECRET}` } });
    const noTerminal = await client.callTool({ name: 'prompt_send', arguments: { to: 's2', text: 'hello' } });
    const handsOff = await client.callTool({ name: 'prompt_send', arguments: { to: 'w3', text: 'hello' } });
    const shell = await client.callTool({ name: 'prompt_send', arguments: { to: 's1', text: '!ls' } });
    const missing = await client.callTool({ name: 'prompt_send', arguments: { to: 's1' } });
    await client.callTool({ name: 'task_list', arguments: {} });
    await client.callTool({ name: 'prompt_status', arguments: { id: 's1', key: 'mcp-someone-1' } });

    expect(sent.structuredContent).toMatchObject({ ok: true });
    expect(noTerminal).toMatchObject({ isError: true, structuredContent: { ok: false, code: 'INVALID' } });
    expect(handsOff).toMatchObject({ isError: true, structuredContent: { code: 'HANDS_OFF' } });
    expect(shell).toMatchObject({ isError: true, structuredContent: { code: 'INVALID' } });
    expect(missing).toMatchObject({ isError: true, structuredContent: { code: 'INVALID' } });
    const rows = t.activity.listActivity().reverse();
    expect(rows.map((r) => [r.tool, r.risk, r.outcome, r.targetSessionId])).toEqual([
      ['prompt_send', 'steers', 'ok', 's1'],
      ['prompt_send', 'steers', 'refused', 's2'],
      ['prompt_send', 'steers', 'refused', 'w3'],
      ['prompt_send', 'steers', 'refused', null],
      ['prompt_send', 'steers', 'refused', null],
    ]);
    expect(rows.every((r) => r.centralId === central.centralId)).toBe(true);
    expect(rows[1].detail).toMatchObject({ code: 'INVALID' });
    expect(rows[2].detail).toMatchObject({ code: 'HANDS_OFF' });
    // What the central sent is in no row.
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('logs a delegated task as a task_delegate row with its task id, beside the task’s own change of state', async () => {
    const world = deliveryWorld();
    const t = testDeliver({ sessions: () => world.sessions });
    t.ledgerDeps.setSession(world.sessions.find((s) => s.sessionId === 's1')!);
    const started = await startWorld(world, { deliver: t.deliver });
    const { client } = await connectAs(started, globalInput());

    const delegated = await client.callTool({ name: 'task_delegate', arguments: { to: 's1', task: 'fix the flaky test' } });
    const auto = await client.callTool({ name: 'task_delegate', arguments: { to: 'auto', task: 'x' } });

    expect(delegated.structuredContent).toMatchObject({ ok: true, data: { started: 1, tasks: [{ taskId: 'T1' }] } });
    // Auto routing is off in this build (Ruling P4-10): refused UNAVAILABLE, and logged so.
    expect(auto).toMatchObject({ isError: true, structuredContent: { code: 'UNAVAILABLE' } });
    const rows = t.activity.listActivity().reverse();
    expect(rows.find((r) => r.tool === 'task_delegate' && r.outcome === 'ok')).toMatchObject({
      risk: 'steers',
      targetSessionId: 's1',
      taskId: 'T1',
    });
    expect(rows.find((r) => r.tool === 'task' && r.taskId === 'T1')).toBeDefined();
    expect(rows.find((r) => r.tool === 'task_delegate' && r.outcome === 'refused')).toMatchObject({ detail: { code: 'UNAVAILABLE' } });
  });

  it('logs an answered request and a used saved prompt, each as a write of its own risk', async () => {
    const world = deliveryWorld();
    world.sessions[0] = { ...world.sessions[0], status: 'approval', pendingRequest: { id: 'req-1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request' } };
    world.routes['POST /snippets/1/use'] = ok({
      success: true,
      revision: 2,
      snippets: [{ id: 1, label: 'greet', text: 'hi', useCount: 1, lastUsedAt: 5, createdAt: 1 }],
    });
    const t = testDeliver({ sessions: () => world.sessions });
    const started = await startWorld(world, { deliver: t.deliver });
    const { client } = await connectAs(started, globalInput());

    const answered = await client.callTool({ name: 'request_answer', arguments: { id: 's1', requestId: 'req-1', choice: 'allow_once' } });
    const used = await client.callTool({ name: 'snippet_use', arguments: { id: 1 } });

    expect(answered.structuredContent).toMatchObject({ ok: true });
    expect(used.structuredContent).toMatchObject({ ok: true, data: { text: 'hi' } });
    const rows = t.activity.listActivity().reverse();
    expect(rows.map((r) => [r.tool, r.risk, r.outcome])).toEqual([
      ['request_answer', 'steers', 'ok'],
      ['snippet_use', 'write', 'ok'],
    ]);
    expect(rows[0].targetSessionId).toBe('s1');
  });

  it('request_answer on the caller’s own task is not a BUSY refusal: one answered row, saying why (K1)', async () => {
    const world = deliveryWorld();
    world.sessions[0] = {
      ...world.sessions[0],
      status: 'approval',
      pendingRequest: { id: 'req-1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request' },
    };
    const t = testDeliver({ sessions: () => world.sessions });
    const started = await startWorld(world, { deliver: t.deliver });
    const { client } = await connectAs(started, globalInput());
    await client.callTool({ name: 'task_delegate', arguments: { to: 's1', task: 'fix it' } });

    const answered = await client.callTool({ name: 'request_answer', arguments: { id: 's1', requestId: 'req-1', choice: 'allow_once' } });

    expect(answered.structuredContent).toMatchObject({ ok: true, data: { answered: true } });
    expect(started.api.calls.filter((c) => c.path === '/sessions/s1/requests/req-1/answer')).toHaveLength(1);
    const rows = t.activity.listActivity().reverse().filter((r) => r.tool === 'request_answer');
    expect(rows.map((r) => [r.outcome, r.detail?.code ?? null])).toEqual([['ok', null]]);
    expect(rows[0].summary).toMatch(/its own task T1/);
  });

  it('request_answer still finds the caller’s own task after the worker re-keyed, by its terminal (K1)', async () => {
    const world = deliveryWorld();
    const t = testDeliver({ sessions: () => world.sessions });
    const started = await startWorld(world, { deliver: t.deliver });
    const { client } = await connectAs(started, globalInput());
    await client.callTool({ name: 'task_delegate', arguments: { to: 's1', task: 'fix it' } });
    // The CLI gave the session its own id; the terminal (term-1) is the one the task was typed into.
    world.sessions[0] = {
      ...world.sessions[0],
      sessionId: 's1-cli',
      status: 'approval',
      pendingRequest: { id: 'req-1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request' },
    };
    world.routes['POST /sessions/s1-cli/requests/req-1/answer'] = ok({ success: true, data: { accepted: true } }, 202);

    const answered = await client.callTool({ name: 'request_answer', arguments: { id: 's1-cli', requestId: 'req-1', choice: 'allow_once' } });

    expect(answered.structuredContent).toMatchObject({ ok: true, data: { answered: true } });
    expect(started.api.calls.filter((c) => c.path === '/sessions/s1-cli/requests/req-1/answer')).toHaveLength(1);
    const rows = t.activity.listActivity().reverse().filter((r) => r.tool === 'request_answer');
    expect(rows.map((r) => [r.outcome, r.detail?.code ?? null])).toEqual([['ok', null]]);
    expect(rows[0].summary).toMatch(/its own task T1/);
  });

  it('refuses every delivery write, and still reads, when the server has no runtime to record them', async () => {
    const world = deliveryWorld();
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const sent = await client.callTool({ name: 'prompt_send', arguments: { to: 's1', text: 'hello' } });
    const read = await client.callTool({ name: 'task_list', arguments: {} });

    expect(sent).toMatchObject({ isError: true, structuredContent: { code: 'UNAVAILABLE' } });
    expect(started.api.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(read.isError).not.toBe(true);
  });
});
