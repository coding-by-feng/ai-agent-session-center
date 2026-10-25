// test/mcp/tools.core.test.ts — Task 8's acceptance: the 27 read tools of P1, called the way a central calls
// them: through the real MCP server (server/mcp/server.ts) over an in-memory transport, with the fake /api
// client, the real registry and the real event hub. The first ten tests are the brief's own; the rest check
// registration, the scope rule across every tool, and that no tool changes what it reads.
//
// The finer behaviour of each tool is in tools.{define,sessions,conversation,agents,terminals,requests,
// system,central}.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, MCP_MAX_PHASE } from '../../server/mcp/registry.js';
import { buildMcpServer, type McpDeps } from '../../server/mcp/server.js';
import { toolsByToolset } from '../../server/mcp/tools/index.js';
import type { CentralKind } from '../../server/mcp/types.js';
import { sessionUpdate, fakeBus } from './centralFixtures.js';
import {
  envelope,
  fakeClient,
  makeCentral,
  makeCtx,
  makeRoom,
  makeSession,
  NOW,
  ok,
  run,
  runRefused,
  type Answer,
} from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

// ---------------------------------------------------------------------------
// A central connected to the real server
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface World {
  sessions?: Session[];
  rooms?: Room[];
  routes?: Record<string, Answer>;
  registry?: CentralRegistry;
}

interface ToolAnswer {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: { ok: boolean; data?: Record<string, unknown>; code?: string; message?: string; hint?: string };
}

async function connectAs(kind: CentralKind, scopeRef: string | null, world: World = {}, cli: 'claude' | 'codex' = 'claude') {
  const registry = world.registry ?? createCentralRegistry();
  const record = registry.mint({ kind, scopeRef, cli, permissionMode: null });
  const api = fakeClient(world.routes);
  const bus = fakeBus();
  const deps: McpDeps = {
    registry,
    client: () => api,
    sessions: () => world.sessions ?? [],
    rooms: () => world.rooms ?? [],
    events: createEventHub(bus.subscribe),
    now: () => NOW,
  };
  const server = buildMcpServer(record, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'core-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
  return { client, api, bus, record, registry, call };
}

const text = (a: ToolAnswer): string => a.content.map((c) => c.text).join('\n');

/**
 * Lets a call that is on its way reach its tool, under fake timers, without moving the clock: `vi.waitFor`
 * would advance it by its poll interval, and a test about the 50 s limit must not.
 */
async function untilListening(bus: ReturnType<typeof fakeBus>, listeners = 1): Promise<void> {
  for (let i = 0; i < 100 && bus.listenerCount() !== listeners; i += 1) await vi.advanceTimersByTimeAsync(0);
  expect(bus.listenerCount()).toBe(listeners);
}

// ---------------------------------------------------------------------------
// The brief's ten
// ---------------------------------------------------------------------------

describe('Task 8: the read tools, through the MCP server', () => {
  const s1 = makeSession('s1', { title: 'Fix login', status: 'working', lastActivityAt: NOW - 1_000 });
  const s2 = makeSession('s2', { title: 'Docs', status: 'idle', lastActivityAt: NOW - 2_000 });
  const s3 = makeSession('s3', { title: 'Elsewhere', status: 'idle', projectPath: '/b/other' });
  const sessions = [s1, s2, s3];
  const rooms = [makeRoom('r1', ['s1', 's2'], 'Backend'), makeRoom('r2', ['s3'], 'Other')];

  it('session_list returns cards in scope only', async () => {
    const { call } = await connectAs('room', 'r1', { sessions, rooms });

    const answer = await call('session_list');
    const data = answer.structuredContent.data as { sessions: Array<{ id: string; shortId: string }> };

    expect(answer.isError).toBeFalsy();
    expect(answer.structuredContent.ok).toBe(true);
    expect(data.sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(text(answer)).toContain('Fix login');
    expect(JSON.stringify(answer)).not.toContain('Elsewhere');
    expect(JSON.stringify(answer)).not.toContain('s3');
  });

  it('session_get refuses a session out of scope', async () => {
    const { call } = await connectAs('room', 'r1', { sessions, rooms });

    const answer = await call('session_get', { id: 's3' });

    expect(answer.isError).toBe(true);
    expect(answer.structuredContent).toMatchObject({ ok: false, code: 'NOT_IN_SCOPE' });
    expect(JSON.stringify(answer)).not.toContain('Elsewhere');
    expect(JSON.stringify(answer)).not.toContain('/b/other');
  });

  it('chat_read calls GET /sessions/<id>/chat with before/after/limit', async () => {
    const empty = envelope({ entries: [], before: 'b', after: 'a', cli: 'claude', hasMore: false });
    const { call, api } = await connectAs('global', null, { sessions, rooms, routes: { 'GET /sessions/s1/chat': empty } });

    await call('chat_read', { id: 's1', before: 'cur-9', limit: 25 });
    await call('chat_read', { id: 's1', after: 'cur-8', limit: 5 });

    expect(api.calls).toEqual([
      { method: 'GET', path: '/sessions/s1/chat', query: { before: 'cur-9', limit: 25 } },
      { method: 'GET', path: '/sessions/s1/chat', query: { after: 'cur-8', limit: 5 } },
    ]);
  });

  it('chat_last_answer fences the answer', async () => {
    const page = envelope({
      entries: [{ kind: 'assistant', key: '1:0', timestamp: NOW - 5_000, text: 'Done: the login form works.' }],
      before: 'b',
      after: 'a',
      cli: 'claude',
      hasMore: false,
    });
    const { call } = await connectAs('global', null, { sessions, rooms, routes: { 'GET /sessions/s1/chat': page } });

    const answer = await call('chat_last_answer', { id: 's1' });

    expect(text(answer)).toContain('<untrusted source="session:s1" kind="answer">Done: the login form works.</untrusted>');
    expect(answer.structuredContent.data?.answer).toBe('<untrusted source="session:s1" kind="answer">Done: the login form works.</untrusted>');
  });

  it('terminal_output fences and strips ANSI', async () => {
    const raw = '\x1b[31mred\x1b[0m alert\r\n\x1b]0;title\x07\x1b[2Kplain\r\n';
    const withTerminal = [makeSession('s1', { terminalId: 't1' })];
    const routes = { 'GET /terminals/t1/output': ok({ ok: true, output: Buffer.from(raw).toString('base64') }) };
    const { call } = await connectAs('global', null, { sessions: withTerminal, routes });

    const answer = await call('terminal_output', { id: 's1' });

    expect(answer.structuredContent.data?.output).toBe('<untrusted source="session:s1" kind="terminal">red alert\nplain</untrusted>');
    expect(text(answer)).toContain('red alert\nplain');
    expect(JSON.stringify(answer)).not.toMatch(/\\u001b|\\x1b/);
  });

  it('session_wait returns the first matching session_update or times out at ≤ 50 s', async () => {
    const working = [makeSession('s1', { status: 'working' }), makeSession('s2', { status: 'working' })];
    const { call, bus } = await connectAs('global', null, { sessions: working });
    vi.useFakeTimers();

    const first = call('session_wait', { ids: ['s1', 's2'], until: 'waiting', timeoutSeconds: 50 });
    await untilListening(bus);
    bus.emit(sessionUpdate({ ...working[1], status: 'working' }));
    bus.emit(sessionUpdate({ ...working[1], status: 'waiting' }));
    const matched = await first;

    expect(matched.structuredContent.data).toMatchObject({ timedOut: false, how: 'update', until: 'waiting' });
    expect((matched.structuredContent.data?.matched as Array<{ id: string }>).map((m) => m.id)).toEqual(['s2']);

    const second = call('session_wait', { ids: ['s1'], until: 'waiting', timeoutSeconds: 50 });
    await untilListening(bus);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(bus.listenerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const timedOut = await second;

    expect(timedOut.structuredContent.data).toMatchObject({ timedOut: true, how: null, matched: [] });
    expect(bus.listenerCount()).toBe(0);

    const tooLong = await call('session_wait', { ids: ['s1'], timeoutSeconds: 51 });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.structuredContent.code).toBe('INVALID');
  });

  it('request_list lists sessions with pendingRequest in scope', async () => {
    const request = { id: 'req-1', kind: 'permission', cli: 'claude', tool: 'Bash', input: { command: 'npm test' }, raisedAt: NOW - 4_000, source: 'permission_request' } as const;
    const asking = [
      makeSession('s1', { status: 'approval', pendingRequest: request }),
      makeSession('s2', { status: 'approval', pendingRequest: { ...request, id: 'req-2' }, projectPath: '/b/other' }),
    ];
    const { call } = await connectAs('room', 'r1', { sessions: asking, rooms: [makeRoom('r1', ['s1'])] });

    const answer = await call('request_list');
    const data = answer.structuredContent.data as { count: number; requests: Array<{ id: string; guessed: boolean; request: { requestId: string } | null }> };

    expect(data.count).toBe(1);
    expect(data.requests[0]).toMatchObject({ id: 's1', guessed: false, request: { requestId: 'req-1' } });
    expect(JSON.stringify(answer)).not.toContain('req-2');
  });

  it('scope_get describes the central', async () => {
    const { call, record } = await connectAs('room', 'r1', { sessions, rooms });

    const answer = await call('scope_get');

    expect(answer.structuredContent.data).toMatchObject({
      centralId: record.centralId,
      kind: 'room',
      scopeRef: 'r1',
      scopeName: 'Backend',
      toolsets: record.toolsets,
      inScopeCount: 2,
      liveCount: 2,
    });
    expect(JSON.stringify(answer)).not.toContain(record.token);
  });

  it('central_list lists registry records without tokens', async () => {
    const registry = createCentralRegistry();
    const others = [registry.mint({ kind: 'room', scopeRef: 'r1', cli: 'codex', permissionMode: null }), registry.mint({ kind: 'project', scopeRef: '/a/proj', cli: 'claude', permissionMode: null })];
    const { call, record } = await connectAs('global', null, { sessions, rooms, registry });

    const answer = await call('central_list');
    const data = answer.structuredContent.data as { count: number; centrals: Array<Record<string, unknown>> };
    const everything = JSON.stringify(answer);

    expect(data.count).toBe(3);
    expect(data.centrals.map((c) => c.centralId)).toEqual([others[0].centralId, others[1].centralId, record.centralId]);
    for (const c of data.centrals) expect(Object.keys(c)).not.toContain('token');
    for (const r of [record, ...others]) expect(everything).not.toContain(r.token);
    expect(everything).not.toMatch(/aasc_mcp_/);
  });

  it('aasc_config output carries no secrets', async () => {
    const config = {
      port: 3333,
      hookDensity: 'medium',
      enabledClis: ['claude'],
      localIP: '192.168.1.5',
      passwordEnabled: true,
      apiToken: 'aasc_mcp_0123456789abcdef0123456789abcdef0123456789a',
      ttsKey: `AIza${'0'.repeat(35)}`,
      nested: { secret: 'shh', ok: 1 },
    };
    const { call } = await connectAs('global', null, { routes: { 'GET /config': ok(config) } });

    const answer = await call('aasc_config');
    const everything = JSON.stringify(answer);

    // `passwordEnabled` is a yes/no about a password, not the password: it stays. The values under the other keys go.
    expect(answer.structuredContent.data).toEqual({
      config: { port: 3333, hookDensity: 'medium', enabledClis: ['claude'], localIP: '192.168.1.5', passwordEnabled: true, nested: { ok: 1 } },
    });
    for (const leak of ['apiToken', 'aasc_mcp_', 'ttsKey', 'AIza', '"secret"', 'shh']) {
      expect(everything, leak).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const P1_TOOLS = [
  // sessions (4)
  'session_list', 'session_get', 'session_source', 'session_wait',
  // conversation (11)
  'chat_read', 'chat_last_answer', 'chat_transcript', 'changes_list', 'changes_diff', 'context_breakdown',
  'subagents_list', 'subagent_transcript', 'team_get', 'terminal_list', 'terminal_output',
  // prompts (1), requests (1)
  'command_list', 'request_list',
  // system (10)
  'aasc_presence', 'aasc_plan_usage', 'aasc_plan_usage_refresh', 'aasc_health', 'aasc_config', 'aasc_codex_models',
  'aasc_folders', 'aasc_workspace', 'scope_get', 'central_list',
];

/** The toolsets Task 8 fills; Task 9 files the others (queue, rooms, resources, history, notes, agenda, cloud, ...). */
const TASK_8_TOOLSETS = ['sessions', 'conversation', 'prompts', 'requests', 'system'];

describe('registration', () => {
  it('files the 27 tools the catalog lists for P1, by toolset: 4 sessions, 11 conversation, 1 prompts, 1 requests, 10 system', () => {
    // The phase 1 tools: a later phase's tools (send, delegate, answer...) are filed in the same toolsets.
    const names = (set: keyof typeof toolsByToolset) => toolsByToolset[set].filter((t) => t.phase === 1).map((t) => t.name);

    expect(names('sessions')).toEqual(P1_TOOLS.slice(0, 4));
    expect(names('conversation')).toEqual(P1_TOOLS.slice(4, 15));
    expect(names('prompts')).toEqual(['command_list']);
    expect(names('requests')).toEqual(['request_list']);
    expect(names('system')).toEqual(P1_TOOLS.slice(17));
    const task8 = allTools().filter((t) => t.phase === 1 && TASK_8_TOOLSETS.includes(t.toolset));
    expect(task8.map((t) => t.name).sort()).toEqual([...P1_TOOLS].sort());
    expect(task8).toHaveLength(27);
  });

  it('declares every phase 1 tool a read, in phase 1', () => {
    for (const tool of allTools().filter((t) => t.phase === 1)) {
      expect(tool.risk, tool.name).toBe('read');
      expect(tool.phase, tool.name).toBeLessThanOrEqual(MCP_MAX_PHASE);
    }
  });

  it('gives every tool, of any phase, a title and a description a model can read, with no secret in either', () => {
    for (const tool of allTools()) {
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.description, tool.name).not.toMatch(/aasc_mcp_|Bearer|Authorization/i);
    }
  });

  it('offers a global Claude central every registered tool of this build’s phase, each annotated by its risk, each with a schema a client can read', async () => {
    const { client } = await connectAs('global', null);

    const { tools } = await client.listTools();

    const offered = allTools().filter((t) => t.phase <= MCP_MAX_PHASE);
    expect(tools.map((t) => t.name)).toEqual(offered.map((t) => t.name));
    for (const tool of tools) {
      const risk = offered.find((t) => t.name === tool.name)?.risk;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(risk === 'read');
      expect(tool.annotations?.destructiveHint, tool.name).toBe(risk === 'destructive');
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it('tells a client each limit in the schema: waits up to 50 s, 8 sessions, pages up to 200, 2000 lines', async () => {
    const { client } = await connectAs('global', null);
    const { tools } = await client.listTools();
    const schema = (name: string) =>
      tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] };

    expect(schema('session_wait').properties.timeoutSeconds).toMatchObject({ minimum: 1, maximum: 50, default: 30 });
    expect(schema('session_wait').properties.ids).toMatchObject({ minItems: 1, maxItems: 8 });
    expect(schema('session_wait').required ?? []).toEqual(['ids']);
    expect(schema('chat_read').properties.limit).toMatchObject({ minimum: 1, maximum: 200 });
    expect(schema('chat_transcript').properties.last).toMatchObject({ minimum: 1, maximum: 500 });
    expect(schema('terminal_output').properties.lines).toMatchObject({ minimum: 1, maximum: 2_000 });
    expect(schema('changes_diff').properties.fileIndex).toMatchObject({ minimum: 0 });
    expect(schema('session_get').required).toEqual(['id']);
    expect(schema('command_list').required).toEqual(['agent']);
    expect(schema('subagent_transcript').properties.agentId).toHaveProperty('pattern');
    expect(schema('session_list').required ?? []).toEqual([]);
    for (const tool of tools) {
      for (const [field, spec] of Object.entries(schema(tool.name).properties ?? {})) {
        expect(spec.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it('offers a Codex central of any kind the 27 tools of Task 8 and the queue’s 3, which sit in its core toolsets; a room central also the room list, a project central also the 5 resource and 6 history tools', async () => {
    const asGlobal = await connectAs('global', null, {}, 'codex');
    const asRoom = await connectAs('room', 'r1', {}, 'codex');
    const asProject = await connectAs('project', '/a/proj', {}, 'codex');

    // Its phase 1 tools: the later phases' tools of the same toolsets (send, delegate, the queue's writes) come on top.
    const phase1 = new Set(allTools().filter((t) => t.phase === 1).map((t) => t.name));
    for (const [central, count] of [[asGlobal, 30], [asRoom, 31], [asProject, 41]] as const) {
      const names = (await central.client.listTools()).tools.map((t) => t.name).filter((name) => phase1.has(name));
      expect(names, central.record.kind).toHaveLength(count);
      expect(P1_TOOLS.every((name) => names.includes(name)), central.record.kind).toBe(true);
    }
  });

  it('takes a session by id or short id in every tool that takes a session', () => {
    const takesSession = allTools().filter((t) => P1_TOOLS.includes(t.name) && ('id' in t.input || 'ids' in t.input));

    expect(takesSession.map((t) => t.name).sort()).toEqual(
      [
        'session_get', 'session_source', 'session_wait', 'chat_read', 'chat_last_answer', 'chat_transcript', 'changes_list',
        'changes_diff', 'context_breakdown', 'subagents_list', 'subagent_transcript', 'terminal_output',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The scope rule across every tool that names a session
// ---------------------------------------------------------------------------

describe('scope', () => {
  const inside = makeSession('in-1', { terminalId: 't-in', teamId: 'team-in' });
  const outside = makeSession('out-1', { projectPath: '/b/other', title: 'TOP SECRET', terminalId: 't-out', teamId: 'team-out' });
  const rooms = [makeRoom('r1', ['in-1']), makeRoom('r2', ['out-1'])];
  const centralFor = () => makeCentral('room', 'r1');

  const perSession: Array<[string, Record<string, unknown>]> = [
    ['session_get', { id: 'out-1' }],
    ['session_source', { id: 'out-1' }],
    ['session_wait', { ids: ['in-1', 'out-1'] }],
    ['chat_read', { id: 'out-1' }],
    ['chat_last_answer', { id: 'out-1' }],
    ['chat_transcript', { id: 'out-1' }],
    ['changes_list', { id: 'out-1' }],
    ['changes_diff', { id: 'out-1', fileIndex: 0 }],
    ['context_breakdown', { id: 'out-1' }],
    ['subagents_list', { id: 'out-1' }],
    ['subagent_transcript', { id: 'out-1', agentId: 'a-1' }],
    ['terminal_output', { id: 'out-1' }],
    ['team_get', { teamId: 'team-out' }],
    ['command_list', { agent: 'claude', folder: '/b/other' }],
  ];

  it.each(perSession)('%s refuses what is out of scope, says nothing about it, and never calls a route', async (name, args) => {
    const { ctx, client } = makeCtx({ central: centralFor(), sessions: [inside, outside], rooms });

    const err = await runRefused(name, args, ctx);

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(`${err.message} ${err.hint ?? ''}`).not.toMatch(/TOP SECRET|out-1|\/b\/other|team-out/);
    expect(client.calls).toEqual([]);
  });

  it('keeps every list free of what is out of scope', async () => {
    const routes: Record<string, Answer> = {
      'GET /terminals': ok({ terminals: [{ terminalId: 't-in', sessionId: 'in-1', workingDir: '/a/proj', createdAt: 1 }, { terminalId: 't-out', sessionId: 'out-1', workingDir: '/b/other', createdAt: 2 }] }),
      'GET /workspace/load': ok({ version: 1, sessions: [{ originalSessionId: 'in-1', title: 'ok', sshConfig: { host: 'localhost', workingDir: '/a/proj' } }, { originalSessionId: 'out-1', title: 'TOP SECRET', sshConfig: { host: 'localhost', workingDir: '/b/other' } }], rooms: [{ id: 'r1', name: 'Mine', sessionIds: ['in-1'] }, { id: 'r2', name: 'Theirs', sessionIds: ['out-1'] }] }),
    };
    const asking = [{ ...inside, status: 'approval' as const }, { ...outside, status: 'approval' as const }];
    const { ctx } = makeCtx({ central: centralFor(), sessions: asking, rooms, routes });

    for (const name of ['session_list', 'request_list', 'terminal_list', 'aasc_workspace', 'scope_get', 'central_list']) {
      const result = await run(name, {}, ctx);
      const everything = `${JSON.stringify(result)}`;
      expect(everything, name).not.toMatch(/TOP SECRET|out-1|t-out|Theirs|\/b\/other/);
    }
  });
});

// ---------------------------------------------------------------------------
// Every tool answers, and none changes what it reads
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

describe('every tool', () => {
  const frozenSession = deepFreeze(
    makeSession('s1', {
      title: 'Frozen',
      status: 'waiting',
      terminalId: 't1',
      teamId: 'team-1',
      teamRole: 'leader',
      planUsage: { cli: 'claude', asOf: NOW, windows: [{ minutes: 300, usedPercent: 10, resetsAt: NOW + 60_000 }] },
      subagents: [{ agentId: 'a-1', agentType: 'Explore', description: 'x', descriptionConfirmed: true, status: 'working', startedAt: 1, endedAt: null, lastActivityAt: 2, toolCount: 1, currentTool: null, currentTarget: null }],
      central: { centralId: 'central-1', kind: 'global', scopeRef: null },
    }),
  );
  const frozenRooms = deepFreeze([makeRoom('r1', ['s1'], 'Backend')]);
  const empty = envelope({ entries: [], before: 'b', after: 'a', cli: 'claude', hasMore: false });
  const routes: Record<string, Answer> = {
    'GET /sessions/s1/source': ok({ source: 'terminal' }),
    'GET /sessions/s1/chat': empty,
    'GET /sessions/s1/transcript': envelope([]),
    'GET /sessions/s1/changes': envelope({ files: [], total: { added: 0, removed: 0 }, cli: 'claude' }),
    'GET /sessions/s1/changes/0': envelope({ path: 'a.ts', added: 1, removed: 0, lastAt: 1, hunks: [] }),
    'GET /sessions/s1/context-breakdown': envelope({ total: 1 }),
    'GET /sessions/s1/subagents/a-1/transcript': envelope({ task: 't', entries: [], start: 0, hasEarlier: false }),
    'GET /teams/team-1/config': ok({ teamName: 'T', config: null }),
    'GET /terminals': ok({ terminals: [] }),
    'GET /terminals/t1/output': ok({ ok: true, output: Buffer.from('hi').toString('base64') }),
    'GET /commands': ok({ entries: [] }),
    'GET /presence': ok({ ok: true, data: { devices: [] } }),
    'POST /plan-usage/sync': envelope({ cli: 'claude', checkedAt: 1, asOf: 1, changed: false }),
    'GET /health-check': ok({ status: 'ok', uptime: 5 }),
    'GET /hooks/status': ok({ installed: false, density: 'off', clis: {} }),
    'GET /mq-stats': ok({ running: true }),
    'GET /hook-stats': ok({ totalHooks: 0, hooksPerMin: 0, events: {} }),
    'GET /config': ok({ port: 3333 }),
    'GET /codex/models': ok({ models: [], source: 'memory-cache', stale: false }),
    'GET /folders': envelope({ path: '/h', home: '/h', parent: null, folders: [], truncated: false }),
    'GET /workspace/load': ok({ version: 1, sessions: [], rooms: [] }),
  };
  const args: Record<string, Record<string, unknown>> = {
    session_get: { id: 's1' },
    session_source: { id: 's1' },
    session_wait: { ids: ['s1'], until: 'waiting', timeoutSeconds: 1 },
    chat_read: { id: 's1' },
    chat_last_answer: { id: 's1' },
    chat_transcript: { id: 's1' },
    changes_list: { id: 's1' },
    changes_diff: { id: 's1', fileIndex: 0 },
    context_breakdown: { id: 's1' },
    subagents_list: { id: 's1' },
    subagent_transcript: { id: 's1', agentId: 'a-1' },
    team_get: { teamId: 'team-1' },
    terminal_output: { id: 's1' },
    command_list: { agent: 'claude' },
    aasc_plan_usage_refresh: { cli: 'claude' },
  };

  it.each(P1_TOOLS)('%s answers a summary and plain data, and changes nothing it reads', async (name) => {
    const { ctx } = makeCtx({ sessions: [frozenSession], rooms: frozenRooms, routes });

    const result = await run(name, args[name] ?? {}, ctx);

    expect(result.summary.trim().length, name).toBeGreaterThan(0);
    expect(result.data, name).toBeDefined();
    expect(() => JSON.stringify(result.data), name).not.toThrow();
    expect(JSON.parse(JSON.stringify(result.data)), name).toEqual(result.data);
  });

  it('never repeats an argument back inside a refusal', async () => {
    const { ctx } = makeCtx({ sessions: [frozenSession], rooms: frozenRooms, routes });
    const needle = 'UNIQUE-NEEDLE-12345';
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['session_get', { id: needle }],
      ['chat_read', { id: needle }],
      ['terminal_output', { id: needle }],
      ['team_get', { teamId: needle }],
      ['session_wait', { ids: [needle] }],
      ['subagent_transcript', { id: needle, agentId: 'a-1' }],
    ];

    for (const [name, a] of attempts) {
      const err = await runRefused(name, a, ctx);
      expect(`${err.message} ${err.hint ?? ''}`, name).not.toContain(needle);
    }
  });
});
