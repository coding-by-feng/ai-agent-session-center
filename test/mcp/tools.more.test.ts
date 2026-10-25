// test/mcp/tools.more.test.ts — Task 9's acceptance: the 31 read tools of P1 that follow Task 8's 27 (queue, rooms,
// resources, skill notes, saved prompts, history, notes, agenda, cloud). The first block is the brief's table, one row
// per tool asserting the method, path, query (and, for the cloud, the headers and body) it calls; then the three named
// tests the brief asks for, registration, and what holds for every one of them. The finer behaviour of each toolset is
// in tools.{queue,rooms,resources,library,history,historySearch,notes,cloud,cloudProjects}.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCentralRegistry, defaultToolsets } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, MCP_MAX_PHASE, toolsFor } from '../../server/mcp/registry.js';
import { buildMcpServer, type McpDeps } from '../../server/mcp/server.js';
import { toolsByToolset } from '../../server/mcp/tools/index.js';
import type { CentralKind } from '../../server/mcp/types.js';
import { fakeBus } from './centralFixtures.js';
import { ACCOUNT, BACKEND, CLOUD_HEADERS, NOTES_HEADERS, PROJECT_ID, connectedStatus, statusCall } from './cloudFixtures.js';
import { pagedRoute, pagedSessions, row } from './historyFixtures.js';
import { deepFreeze, everything } from './readFixtures.js';
import {
  envelope, fakeClient, makeCentral, makeCtx, makeRoom, makeSession, NOW, ok, run, runRefused,
  type Answer, type ApiCall,
} from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const RES = 'a1b2c3d4e5f60718';
const MEDIA = 'a'.repeat(32);

const s1 = makeSession('s1', { title: 'Fix login' });
const s2 = makeSession('s2', { title: 'Docs' });
const outside = makeSession('out-1', { projectPath: '/b/other', title: 'TOP SECRET' });
const rooms = [makeRoom('r1', ['s1', 's2']), makeRoom('r2', ['out-1'])];

// ---------------------------------------------------------------------------
// The table: one row per tool
// ---------------------------------------------------------------------------

interface Case {
  tool: string;
  args: Record<string, unknown>;
  routes: Record<string, Answer>;
  calls: ApiCall[];
}

const detail = { summary: { id: RES, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', name: 'x', path: '~/x', fileCount: 1, bytes: 1 }, findings: [] };
const bound = (route: string, answer: Answer): Record<string, Answer> => ({ 'GET /resources/cloud/status': connectedStatus, [route]: answer });
const get = (path: string, extra: Partial<ApiCall> = {}): ApiCall => ({ method: 'GET', path, ...extra });

const CASES: Case[] = [
  // queue
  { tool: 'queue_get', args: { id: 's1' }, routes: { 'GET /sessions/s1/queue': ok({ sessionId: 's1', items: [], automation: null, updatedAt: 0 }) }, calls: [get('/sessions/s1/queue')] },
  { tool: 'queue_list_all', args: {}, routes: { 'GET /queues': ok({ queues: [] }) }, calls: [get('/queues')] },
  { tool: 'queue_sent', args: { id: 's1' }, routes: { 'GET /sessions/s1/queue/sent': ok({ success: true, sent: [] }) }, calls: [get('/sessions/s1/queue/sent')] },
  // rooms
  { tool: 'room_list', args: {}, routes: { 'GET /rooms': ok({ ok: true, rooms: [], revision: 1 }) }, calls: [get('/rooms')] },
  // resources
  { tool: 'resource_list', args: {}, routes: { 'GET /resources': envelope({ state: 'ready', resources: [] }) }, calls: [get('/resources')] },
  { tool: 'resource_get', args: { id: RES }, routes: { [`GET /resources/item/${RES}`]: envelope(detail) }, calls: [get(`/resources/item/${RES}`)] },
  { tool: 'resource_read_file', args: { id: RES, file: 'SKILL.md' }, routes: { [`GET /resources/item/${RES}/file`]: envelope({ path: 'SKILL.md', bytes: 1, content: 'x' }) }, calls: [get(`/resources/item/${RES}/file`, { query: { path: 'SKILL.md' } })] },
  { tool: 'resource_compare', args: { id: RES }, routes: { [`GET /resources/item/${RES}/compare`]: envelope({ left: { label: 'a', path: 'a' }, right: { label: 'b', path: 'b' }, files: [] }) }, calls: [get(`/resources/item/${RES}/compare`, { query: { against: 'repo' } })] },
  { tool: 'resource_usage', args: {}, routes: { 'GET /resources/usage': envelope({ windowDays: 90, byId: {} }) }, calls: [get('/resources/usage')] },
  // skill notes and saved prompts
  { tool: 'skillnote_list', args: {}, routes: { 'GET /skill-notes/favorites': ok({ source: 'none', entries: [] }) }, calls: [get('/skill-notes/favorites')] },
  { tool: 'snippet_list', args: {}, routes: { 'GET /snippets': ok({ success: true, revision: 1, snippets: [] }) }, calls: [get('/snippets')] },
  // history
  { tool: 'history_list', args: {}, routes: { 'GET /db/sessions': pagedSessions([]) }, calls: [get('/db/sessions', { query: { archived: 'all' } })] },
  { tool: 'history_get', args: { id: 'h1' }, routes: { 'GET /db/sessions/h1': ok({ session: row('h1', '/a/proj') }) }, calls: [get('/db/sessions/h1')] },
  { tool: 'history_search', args: { query: 'x' }, routes: { 'GET /db/search': ok({ results: [], total: 0, page: 1, pageSize: 50 }) }, calls: [get('/db/search', { query: { query: 'x' } })] },
  { tool: 'history_prompts', args: {}, routes: { 'GET /db/prompts': pagedRoute('prompts', []) }, calls: [get('/db/prompts', { query: { kind: 'mine' } })] },
  { tool: 'history_projects', args: {}, routes: { 'GET /db/projects': ok([]) }, calls: [get('/db/projects')] },
  { tool: 'history_known_projects', args: {}, routes: { 'GET /known-projects': ok({ paths: [] }) }, calls: [get('/known-projects')] },
  // notes and agenda
  { tool: 'note_list', args: { sessionId: 's1' }, routes: { 'GET /db/sessions/s1/notes': ok([]) }, calls: [get('/db/sessions/s1/notes')] },
  { tool: 'note_media_get', args: { id: MEDIA }, routes: { [`GET /note-media/${MEDIA}/meta`]: ok({ sessionId: 's1', mime: 'image/png', bytes: 1 }) }, calls: [get(`/note-media/${MEDIA}/meta`)] },
  { tool: 'agenda_list', args: {}, routes: { 'GET /agenda': ok({ ok: true, data: [] }) }, calls: [get('/agenda')] },
  // cloud
  { tool: 'cloud_status', args: {}, routes: { 'GET /resources/cloud/status': connectedStatus }, calls: [statusCall] },
  { tool: 'cloud_sync_status', args: {}, routes: bound('GET /resources/cloud/sync-status', envelope({ items: [], waiting: 0 })), calls: [statusCall, get('/resources/cloud/sync-status', { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_resource_list', args: {}, routes: bound('GET /resources/cloud/resources', envelope({ items: [], nextCursor: null })), calls: [statusCall, get('/resources/cloud/resources', { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_project_list', args: {}, routes: bound('GET /resources/cloud/projects', envelope({ items: [], nextCursor: null })), calls: [statusCall, get('/resources/cloud/projects', { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_project_get', args: { id: PROJECT_ID }, routes: bound(`GET /resources/cloud/projects/${PROJECT_ID}`, envelope({ id: PROJECT_ID, name: 'p' })), calls: [statusCall, get(`/resources/cloud/projects/${PROJECT_ID}`, { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_project_local', args: { id: PROJECT_ID }, routes: bound(`GET /resources/cloud/projects/${PROJECT_ID}/local`, envelope({ state: 'missing', branch: null, openUrl: null, localProjectId: null })), calls: [statusCall, get(`/resources/cloud/projects/${PROJECT_ID}/local`, { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_project_candidates', args: {}, routes: bound('GET /resources/cloud/projects/candidates', envelope({ items: [] })), calls: [statusCall, get('/resources/cloud/projects/candidates', { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_project_accounts', args: {}, routes: bound('GET /resources/cloud/projects/github-accounts', envelope({ installed: false, accounts: [] })), calls: [statusCall, get('/resources/cloud/projects/github-accounts', { headers: CLOUD_HEADERS })] },
  { tool: 'cloud_notes_status', args: {}, routes: { 'GET /resources/cloud/skill-notes/status': envelope({ connection: { backendOrigin: BACKEND, accountId: ACCOUNT, generation: 3 }, state: 'connected' }) }, calls: [get('/resources/cloud/skill-notes/status')] },
  {
    tool: 'cloud_aliases_status',
    args: { keys: ['claude:brainstorming'] },
    routes: { 'GET /resources/cloud/status': connectedStatus, 'POST /resources/cloud/aliases/status': envelope({ enabled: false, connection: null, cached: false, statuses: [] }) },
    calls: [statusCall, { method: 'POST', path: '/resources/cloud/aliases/status', body: { keys: ['claude:brainstorming'] }, headers: NOTES_HEADERS }],
  },
  { tool: 'remote_access_get', args: {}, routes: { 'GET /resources/cloud/remote-access': envelope({ tailscale: {}, publish: {}, phones: [], port: 3333 }) }, calls: [get('/resources/cloud/remote-access')] },
];

const THE_31 = CASES.map((c) => c.tool);

describe('the 31 read tools: the route each one calls', () => {
  it.each(CASES)('$tool calls exactly its route', async ({ tool, args, routes, calls }) => {
    const { ctx, client } = makeCtx({ sessions: [s1, s2], rooms, routes });

    await run(tool, args, ctx);

    expect(client.calls).toEqual(calls);
  });

  it('has a row for every one of the 31', () => {
    expect(new Set(THE_31).size).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// The three tests the brief names
// ---------------------------------------------------------------------------

describe('named in the brief', () => {
  it('queue_list_all drops out-of-scope sessions', async () => {
    const queue = (id: string, text: string) => ({ sessionId: id, items: [{ id: 1, sessionId: id, text, position: 0, createdAt: 1 }], automation: null, updatedAt: 1 });
    const { ctx } = makeCtx({
      central: makeCentral('room', 'r1'), sessions: [s1, s2, outside], rooms,
      routes: { 'GET /queues': ok({ queues: [queue('s1', 'mine'), queue('s2', 'also mine'), queue('out-1', 'TOP SECRET plan')] }) },
    });

    const result = await run('queue_list_all', {}, ctx);

    expect((result.data as { queues: Array<{ id: string }> }).queues.map((q) => q.id).sort()).toEqual(['s1', 's2']);
    expect(everything(result)).not.toMatch(/TOP SECRET|out-1/);
  });

  it('history_prompts excludes harness rows', async () => {
    const prompt = (id: number, text: string) => ({ id, session_id: 's1', text, timestamp: id, project_name: 'proj', project_path: '/a/proj', session_title: 't' });
    const rows = [prompt(1, 'fix the login'), prompt(2, '<task-notification>done</task-notification>'), prompt(3, '  <system-reminder>x'), prompt(4, '/plan it')];
    const { ctx } = makeCtx({ routes: { 'GET /db/prompts': ok({ prompts: rows, total: 4, page: 1, pageSize: 50 }) } });

    const result = await run('history_prompts', {}, ctx);

    expect((result.data as { prompts: Array<{ id: number }> }).prompts.map((p) => p.id)).toEqual([1, 4]);
    expect(everything(result)).not.toMatch(/task-notification|system-reminder/);
  });

  it('cloud tools are absent for a Codex central (the toolset is off by default), and present for a Claude one', async () => {
    const cloudNames = toolsByToolset.cloud.filter((t) => t.phase <= MCP_MAX_PHASE).map((t) => t.name);
    for (const kind of ['global', 'room', 'project'] as const) {
      const codex = createCentralRegistry().mint({ kind, scopeRef: kind === 'global' ? null : 'x', cli: 'codex', permissionMode: null });
      const claude = createCentralRegistry().mint({ kind, scopeRef: kind === 'global' ? null : 'x', cli: 'claude', permissionMode: null });

      expect(toolsFor(codex, MCP_MAX_PHASE).map((t) => t.name).filter((n) => cloudNames.includes(n)), `codex ${kind}`).toEqual([]);
      expect(toolsFor(claude, MCP_MAX_PHASE).map((t) => t.name).filter((n) => cloudNames.includes(n)), `claude ${kind}`).toEqual(cloudNames);
      expect(defaultToolsets(kind, 'codex')).not.toContain('cloud');
    }
  });
});

// ---------------------------------------------------------------------------
// The scope rule across the tools that name a session
// ---------------------------------------------------------------------------

describe('scope', () => {
  const central = () => makeCentral('room', 'r1');

  it.each([
    ['queue_get', { id: 'out-1' }],
    ['queue_sent', { id: 'out-1' }],
    ['note_list', { sessionId: 'out-1' }],
  ])('%s refuses what is out of scope, says nothing about it, and never calls a route', async (name, args) => {
    const { ctx, client } = makeCtx({ central: central(), sessions: [s1, s2, outside], rooms });

    const err = await runRefused(name, args, ctx);

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(`${err.message} ${err.hint ?? ''}`).not.toMatch(/TOP SECRET|out-1|\/b\/other/);
    expect(client.calls).toEqual([]);
  });

  it('keeps every list free of what is out of scope', async () => {
    const queue = { sessionId: 'out-1', items: [{ id: 1, text: 'TOP SECRET plan', position: 0, createdAt: 1 }], automation: null, updatedAt: 1 };
    const routes: Record<string, Answer> = {
      'GET /queues': ok({ queues: [queue] }),
      'GET /rooms': ok({ ok: true, rooms: [makeRoom('r1', ['s1', 's2']), makeRoom('r2', ['out-1'], 'Theirs')], revision: 1 }),
    };
    const { ctx } = makeCtx({ central: central(), sessions: [s1, s2, outside], rooms, routes });

    for (const name of ['queue_list_all', 'room_list']) {
      expect(everything(await run(name, {}, ctx)), name).not.toMatch(/TOP SECRET|out-1|Theirs/);
    }
  });
});

// ---------------------------------------------------------------------------
// Through the MCP server
// ---------------------------------------------------------------------------

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function connect(kind: CentralKind, scopeRef: string | null, cli: 'claude' | 'codex', routes: Record<string, Answer> = {}) {
  const registry = createCentralRegistry();
  const record = registry.mint({ kind, scopeRef, cli, permissionMode: null });
  const api = fakeClient(routes);
  const deps: McpDeps = { registry, client: () => api, sessions: () => [s1], rooms: () => rooms, events: createEventHub(fakeBus().subscribe), now: () => NOW };
  const server = buildMcpServer(record, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'more-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, api };
}

describe('through the MCP server', () => {
  it('lists no cloud tool to a Codex central, and refuses a call to one as not found without touching a route', async () => {
    const { client, api } = await connect('global', null, 'codex');

    const { tools } = await client.listTools();
    const answer = (await client.callTool({ name: 'cloud_status', arguments: {} })) as unknown as { isError?: boolean; structuredContent: { code?: string } };

    expect(tools.map((t) => t.name).filter((n) => n.startsWith('cloud_') || n === 'remote_access_get')).toEqual([]);
    expect(tools.map((t) => t.name)).toContain('queue_get');
    expect(answer.isError).toBe(true);
    expect(answer.structuredContent.code).toBe('NOT_FOUND');
    expect(api.calls).toEqual([]);
  });

  it('lists every one of the 31 to a Claude central, each read-only, the cloud ones marked open-world', async () => {
    const { client } = await connect('global', null, 'claude');

    const { tools } = await client.listTools();

    for (const name of THE_31) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(true);
      expect(tool?.annotations?.openWorldHint, name).toBe(toolsByToolset.cloud.some((t) => t.name === name));
      expect(tool?.outputSchema, name).toBeDefined();
    }
  });

  it('calls a queue tool end to end: the fenced answer comes back as the text and as structured data', async () => {
    const { client } = await connect('global', null, 'claude', {
      'GET /sessions/s1/queue': ok({ sessionId: 's1', items: [{ id: 1, text: 'Run the tests', position: 0, createdAt: 1 }], automation: null, updatedAt: 1 }),
    });

    const answer = (await client.callTool({ name: 'queue_get', arguments: { id: 's1' } })) as unknown as {
      content: Array<{ text: string }>;
      structuredContent: { ok: boolean; data: { count: number; items: Array<{ text: string }> } };
    };

    expect(answer.structuredContent.ok).toBe(true);
    expect(answer.structuredContent.data.count).toBe(1);
    expect(answer.structuredContent.data.items[0].text).toContain('<untrusted source="session:s1" kind="queue-item">Run the tests</untrusted>');
    expect(answer.content[0].text).toContain('<untrusted source="session:s1" kind="queue">');
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registration of the 31', () => {
  // The 31 are the phase 1 reads: a later phase's tools (the queue's writes, say) are filed in the same toolsets.
  const names = (set: keyof typeof toolsByToolset) => toolsByToolset[set].filter((t) => t.phase === 1).map((t) => t.name);

  it('files each under the toolset the catalog gives it', () => {
    expect(names('queue')).toEqual(['queue_get', 'queue_list_all', 'queue_sent']);
    expect(names('rooms')).toEqual(['room_list']);
    expect(names('resources')).toEqual(['resource_list', 'resource_get', 'resource_read_file', 'resource_compare', 'resource_usage']);
    expect(names('skillNotes')).toEqual(['skillnote_list']);
    expect(names('snippets')).toEqual(['snippet_list']);
    expect(names('history')).toEqual(['history_list', 'history_get', 'history_search', 'history_prompts', 'history_projects', 'history_known_projects']);
    expect(names('notes')).toEqual(['note_list', 'note_media_get']);
    expect(names('agenda')).toEqual(['agenda_list']);
    expect(names('cloud')).toEqual([
      'cloud_status', 'cloud_sync_status', 'cloud_resource_list', 'cloud_project_list', 'cloud_project_get', 'cloud_project_local',
      'cloud_project_candidates', 'cloud_project_accounts', 'cloud_notes_status', 'cloud_aliases_status', 'remote_access_get',
    ]);
    expect(THE_31.slice().sort()).toEqual(
      [...names('queue'), ...names('rooms'), ...names('resources'), ...names('skillNotes'), ...names('snippets'), ...names('history'), ...names('notes'), ...names('agenda'), ...names('cloud')].sort(),
    );
    expect(allTools().filter((t) => t.phase === 1)).toHaveLength(58);
  });

  it('declares each a read in phase 1, with a title and a description that says what is fenced where text is returned', () => {
    for (const tool of allTools().filter((t) => THE_31.includes(t.name))) {
      expect(tool.risk, tool.name).toBe('read');
      expect(tool.phase, tool.name).toBe(1);
      expect(tool.title.length, tool.name).toBeGreaterThan(3);
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.description, tool.name).not.toMatch(/aasc_mcp_|Bearer|Authorization/i);
    }
  });

  it('tells a client each limit in the schema', async () => {
    const { client } = await connect('global', null, 'claude');
    const { tools } = await client.listTools();
    const props = (name: string) => (tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, Record<string, unknown>>; required?: string[] }).properties;

    expect(props('queue_sent').limit).toMatchObject({ minimum: 1, maximum: 300 });
    expect(props('resource_list').limit).toMatchObject({ minimum: 1, maximum: 200 });
    expect(props('resource_get').id).toHaveProperty('pattern');
    expect(props('history_list').pageSize).toMatchObject({ minimum: 1, maximum: 100 });
    expect(props('history_search').pageSize).toMatchObject({ minimum: 1, maximum: 50 });
    expect(props('cloud_resource_list').limit).toMatchObject({ minimum: 1, maximum: 100 });
    expect(props('cloud_aliases_status').keys).toMatchObject({ minItems: 1, maxItems: 100 });
    for (const name of THE_31) {
      for (const [field, spec] of Object.entries(props(name) ?? {})) expect(spec.description, `${name}.${field}`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// What holds for every one of them
// ---------------------------------------------------------------------------

describe('every one of the 31', () => {
  it.each(CASES)('$tool answers a summary and plain data, and changes nothing it reads', async ({ tool, args, routes }) => {
    const frozenSessions = deepFreeze([makeSession('s1', { title: 'Frozen', terminalId: 't1' }), makeSession('s2')]);
    const frozenRooms = deepFreeze([makeRoom('r1', ['s1', 's2'], 'Backend')]);
    const { ctx } = makeCtx({ sessions: frozenSessions, rooms: frozenRooms, routes });

    const result = await run(tool, args, ctx);

    expect(result.summary.trim().length, tool).toBeGreaterThan(0);
    expect(result.data, tool).toBeDefined();
    expect(JSON.parse(JSON.stringify(result.data)), tool).toEqual(result.data);
    expect(result.summary, tool).not.toMatch(/aasc_mcp_|Bearer /);
  });

  it('never repeats an argument back inside a refusal', async () => {
    const needle = 'UNIQUE-NEEDLE-12345';
    const { ctx } = makeCtx({
      central: makeCentral('project', '/a/proj'), sessions: [s1], rooms,
      routes: { 'GET /db/sessions': pagedSessions([]) },
    });
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['queue_get', { id: needle }],
      ['queue_sent', { id: needle }],
      ['note_list', { sessionId: needle }],
      ['history_list', { project: `/elsewhere/${needle}` }],
      ['history_list', { project: `${needle}` }],
      ['history_list', { dateFrom: needle }],
      ['history_prompts', { dateTo: needle }],
      ['history_prompts', { project: `/elsewhere/${needle}` }],
      ['history_prompts', { project: `${needle}` }],
    ];

    for (const [name, args] of attempts) {
      const err = await runRefused(name, args, ctx);
      expect(`${err.message} ${err.hint ?? ''}`, `${name} ${JSON.stringify(args)}`).not.toContain(needle);
    }
  });
});
