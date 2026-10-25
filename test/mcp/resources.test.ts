// test/mcp/resources.test.ts — the 18 MCP resources through the real /mcp endpoint (server/mcp/resources.ts): what
// `resources/templates/list` and `resources/list` show a central, and what a read returns (the backing tool's fenced
// text and its data as JSON). The SDK's client talks real HTTP to the endpoint; the tools are the real ones, over a
// small world of sessions and a fake /api. What a central may not read, what a read runs with and completion of a
// session id are in resourceRefusals.test.ts.
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_TOOLSETS } from '../../server/mcp/types.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { runCleanups } from './endpointHarness.js';
import { expectFenced, outsideFences } from './readFixtures.js';
import {
  CATALOG_URIS,
  connectAs,
  freshWorld,
  MEDIA,
  RES,
  refused,
  startWorld,
  STATIC_URIS,
  textOf,
} from './resourceWorld.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

afterEach(runCleanups);

// ---------------------------------------------------------------------------
// resources/templates/list and resources/list
// ---------------------------------------------------------------------------

describe('resources/templates/list', () => {
  it('resources/templates/list has 18 entries', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ cli: 'claude' }));

    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resourceTemplates).toHaveLength(18);
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([...CATALOG_URIS]);
    expect(new Set(resourceTemplates.map((t) => t.name)).size).toBe(18);
    for (const t of resourceTemplates) {
      expect(t.title, t.uriTemplate).toBeTruthy();
      expect(t.description, t.uriTemplate).toBeTruthy();
    }
  });

  it('lists fewer for a Codex central, which has only the core toolsets: the toolset filter', async () => {
    const started = await startWorld();
    const codex = await connectAs(started, globalInput({ cli: 'codex' }));
    expect(codex.central.toolsets).toEqual([...CORE_TOOLSETS]);

    const { resourceTemplates } = await codex.client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);

    expect(uris).toHaveLength(12);
    for (const absent of [
      'aasc://rooms',
      'aasc://resources/{id}',
      'aasc://resources/{id}/file',
      'aasc://snippets',
      'aasc://history/{id}',
      'aasc://notes/media/{id}',
    ]) {
      expect(uris, absent).not.toContain(absent);
    }
    // What it keeps: the sessions, their conversation, queue and terminal, tasks, plan usage and the workspace.
    expect(uris).toEqual(
      expect.arrayContaining([
        'aasc://sessions',
        'aasc://sessions/{id}/answer',
        'aasc://sessions/{id}/queue',
        'aasc://tasks/{taskId}',
        'aasc://plan-usage',
        'aasc://workspace',
      ]),
    );
  });

  it('lists nothing, and answers without an error, for a central whose toolsets back no resource', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ toolsets: ['agenda'] }));

    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await client.listResources()).resources).toEqual([]);
  });

  it('says in the description of rooms that nothing is pushed for it in this version', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const rooms = (await client.listResourceTemplates()).resourceTemplates.find(
      (t) => t.uriTemplate === 'aasc://rooms',
    );

    expect(rooms?.description).toMatch(/not pushed|no live updates/i);
  });
});

describe('resources/list', () => {
  it('shows the five resources that have no variable, as they are, and none of the templated ones', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri)).toEqual([...STATIC_URIS]);
    expect(STATIC_URIS).toEqual([
      'aasc://sessions',
      'aasc://rooms',
      'aasc://snippets',
      'aasc://plan-usage',
      'aasc://workspace',
    ]);
    for (const r of resources) {
      expect(r.name, r.uri).toBeTruthy();
      expect(r.description, r.uri).toBeTruthy();
    }
  });

  it('shows a Codex central only the ones it may read', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ cli: 'codex' }));

    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([
      'aasc://sessions',
      'aasc://plan-usage',
      'aasc://workspace',
    ]);
  });
});

// ---------------------------------------------------------------------------
// resources/read
// ---------------------------------------------------------------------------

describe('the task resource (K3)', () => {
  it('aasc://tasks/T1 reads like task_get and refuses another central’s task', async () => {
    const world = freshWorld();
    const t = testDeliver({ sessions: () => world.sessions });
    const started = await startWorld(world, { deliver: t.deliver });
    const mine = await connectAs(started, globalInput());
    // A room central whose scope holds the same worker: the task is still not its own.
    const theirs = await connectAs(started, roomInput('r1'));
    const task = t.ledger.create({ central: mine.central, session: world.sessions[0], task: 'fix the login test' });

    const read = await mine.client.readResource({ uri: `aasc://tasks/${task.taskId}` });
    const call = await mine.client.callTool({ name: 'task_get', arguments: { id: task.taskId } });

    expect(task.taskId).toBe('T1');
    expect(textOf(read)).toBe((call.content as Array<{ text: string }>)[0].text);
    expect(textOf(read)).toContain('<untrusted source="task:T1" kind="task">fix the login test</untrusted>');
    const json = read.contents[1];
    expect(JSON.parse('text' in json ? json.text : 'null')).toEqual((call.structuredContent as { data: unknown }).data);

    const err = await refused(theirs.client.readResource({ uri: 'aasc://tasks/T1' }));
    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('NOT_FOUND');
    expect(err.message).not.toMatch(/fix the login|T1/);
  });

  it('checks a task id as task_get does, before anything is read', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const err = await refused(client.readResource({ uri: 'aasc://tasks/not-a-task' }));

    expect(err.message).toContain('INVALID');
    expect(err.message).not.toContain('not-a-task');
  });
});

describe('resources/read', () => {
  it('reading aasc://sessions/<id>/answer returns fenced text', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const result = await client.readResource({ uri: 'aasc://sessions/s1/answer' });

    expect(result.contents).toHaveLength(2);
    const [text, json] = result.contents;
    // The tool's own words, with what the session wrote inside one fence.
    expect(text).toMatchObject({ uri: 'aasc://sessions/s1/answer', mimeType: 'text/plain' });
    const said = textOf(result);
    expect(said).toContain(
      '<untrusted source="session:s1" kind="answer">Done. The login works now.</untrusted>',
    );
    expect(outsideFences(said)).not.toContain('The login works now');
    // Its data, as JSON, beside it.
    expect(json).toMatchObject({ uri: 'aasc://sessions/s1/answer', mimeType: 'application/json' });
    const data = JSON.parse('text' in json ? json.text : '{}') as { id: string; answer: string };
    expect(data.id).toBe('s1');
    expectFenced(data.answer, 'answer', 'session:s1');
  });

  it('reads the same answer the tool gives, by the short id of a session', async () => {
    const world = freshWorld();
    const id = '0123456789abcdef';
    world.sessions.push(makeSession(id, { title: 'Long id' }));
    world.rooms[0].sessionIds.push(id);
    world.routes[`GET /sessions/${id}/chat`] = world.routes['GET /sessions/s1/chat'];
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const result = await client.readResource({ uri: 'aasc://sessions/01234567/answer' });

    expect(textOf(result)).toContain('The login works now');
    expect(started.api.calls.map((c) => c.path)).toEqual([`/sessions/${id}/chat`]);
  });

  /**
   * The route (or routes) each resource's tool calls: the resource reads what the tool reads, and nothing else.
   * The sessions, one session and plan usage are read from the store, so they call no route.
   */
  const READS: Array<
    [string, Array<{ method: string; path: string; query?: Record<string, unknown> }>]
  > = [
    ['aasc://sessions', []],
    ['aasc://sessions/s1', []],
    [
      'aasc://sessions/s1/conversation',
      [{ method: 'GET', path: '/sessions/s1/chat', query: { limit: 40 } }],
    ],
    ['aasc://sessions/s1/answer', [{ method: 'GET', path: '/sessions/s1/chat' }]],
    ['aasc://sessions/s1/changes', [{ method: 'GET', path: '/sessions/s1/changes' }]],
    ['aasc://sessions/s1/changes/0', [{ method: 'GET', path: '/sessions/s1/changes/0' }]],
    ['aasc://sessions/s1/terminal', [{ method: 'GET', path: '/terminals/term-1/output' }]],
    ['aasc://sessions/s1/queue', [{ method: 'GET', path: '/sessions/s1/queue' }]],
    [
      'aasc://sessions/s1/subagents/a-1',
      [{ method: 'GET', path: '/sessions/s1/subagents/a-1/transcript', query: { limit: 40 } }],
    ],
    ['aasc://rooms', [{ method: 'GET', path: '/rooms' }]],
    [`aasc://resources/${RES}`, [{ method: 'GET', path: `/resources/item/${RES}` }]],
    [
      `aasc://resources/${RES}/file`,
      [{ method: 'GET', path: `/resources/item/${RES}/file`, query: { path: 'SKILL.md' } }],
    ],
    ['aasc://snippets', [{ method: 'GET', path: '/snippets' }]],
    ['aasc://history/h1', [{ method: 'GET', path: '/db/sessions/h1' }]],
    [`aasc://notes/media/${MEDIA}`, [{ method: 'GET', path: `/note-media/${MEDIA}/meta` }]],
    ['aasc://plan-usage', []],
    ['aasc://workspace', [{ method: 'GET', path: '/workspace/load' }]],
  ];

  it.each(READS)(
    '%s reads what its tool reads, and answers its text and its data',
    async (uri, calls) => {
      const started = await startWorld();
      const { client } = await connectAs(started, globalInput());

      const result = await client.readResource({ uri });

      expect(started.api.calls).toEqual(calls);
      expect(result.contents.map((c) => c.mimeType)).toEqual(['text/plain', 'application/json']);
      expect(result.contents.every((c) => c.uri === uri)).toBe(true);
      expect(textOf(result).length).toBeGreaterThan(0);
      // The second part is JSON the tool's data serializes to.
      const second = result.contents[1];
      expect(() => JSON.parse('text' in second ? second.text : 'x')).not.toThrow();
    },
  );

  it('answers the session list as a fenced list of the sessions in scope', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const result = await client.readResource({ uri: 'aasc://sessions' });

    const said = textOf(result);
    expect(said).toMatch(/2 sessions in your scope/);
    expect(said).toContain('<untrusted source="aasc" kind="session-cards">');
    expect(outsideFences(said)).not.toContain('Fix login');
  });

  it('reads a session whose id has a slash in it, named by its escaped id, and calls the route with the id encoded', async () => {
    const world = freshWorld();
    world.sessions.push(makeSession('ext/9', { title: 'Odd id' }));
    world.routes['GET /sessions/ext%2F9/chat'] = world.routes['GET /sessions/s1/chat'];
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const result = await client.readResource({ uri: 'aasc://sessions/ext%2F9/answer' });

    expect(textOf(result)).toContain('The login works now');
    expect(started.api.calls.map((c) => c.path)).toEqual(['/sessions/ext%2F9/chat']);
  });

  it('answers a Mac-level resource to every central that has the toolset, whatever its scope', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, roomInput('r1'));

    const result = await client.readResource({ uri: 'aasc://snippets' });

    expect(textOf(result)).toContain('1 saved prompt');
  });
});
