// test/mcp/resourceRefusals.test.ts — what a central may not read through the MCP resources (server/mcp/resources.ts),
// the context a read runs with, and completion of a session id. Through the real /mcp endpoint, with the SDK's
// client, the real tools and a fake /api; listing and reading are in resources.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolDef } from '../../server/mcp/registry.js';
import { globalInput, projectInput, roomInput } from './centralFixtures.js';
import { runCleanups } from './endpointHarness.js';
import {
  connectAs,
  freshWorld,
  MEDIA,
  PATIENT,
  RES,
  refused,
  startWorld,
  textOf,
} from './resourceWorld.js';
import { fail, makeSession } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

afterEach(async () => {
  await runCleanups();
  log.warn.mockClear();
});

// ---------------------------------------------------------------------------
// What a central may not read
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('an out-of-scope session URI fails', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, roomInput('r1'));

    // s1 is in the room; s2 is not.
    expect(textOf(await client.readResource({ uri: 'aasc://sessions/s1/answer' }))).toContain(
      'The login works now',
    );
    const err = await refused(client.readResource({ uri: 'aasc://sessions/s2/answer' }));

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('NOT_IN_SCOPE');
    expect(err.data).toMatchObject({ ok: false, code: 'NOT_IN_SCOPE' });
    // Said by the tool's own scope check, before any route was called for it.
    expect(started.api.calls.map((c) => c.path)).toEqual(['/sessions/s1/chat']);
  });

  it('refuses every per-session resource of an out-of-scope session, and calls no route', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, projectInput('/a/proj'));

    for (const suffix of [
      '',
      '/conversation',
      '/answer',
      '/changes',
      '/changes/0',
      '/terminal',
      '/queue',
      '/subagents/a-1',
    ]) {
      const err = await refused(client.readResource({ uri: `aasc://sessions/s2${suffix}` }));
      expect(err.message, suffix).toContain('NOT_IN_SCOPE');
    }
    expect(started.api.calls).toEqual([]);
  });

  it('answers a resource the central was not offered as not found, and calls no route', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ cli: 'codex' }));

    for (const uri of [
      'aasc://rooms',
      'aasc://snippets',
      `aasc://resources/${RES}`,
      'aasc://history/h1',
      `aasc://notes/media/${MEDIA}`,
    ]) {
      const err = await refused(client.readResource({ uri }));
      expect(err.code, uri).toBe(ErrorCode.InvalidParams);
      expect(err.message, uri).toMatch(/not found/i);
    }
    expect(started.api.calls).toEqual([]);
  });

  it('answers a URI that is no resource at all as not found', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    for (const uri of [
      'aasc://nothing',
      'aasc://sessions/s1/nothing',
      'aasc://sessions/a/b/c/d',
      'file:///etc/passwd',
    ]) {
      expect((await refused(client.readResource({ uri }))).message, uri).toMatch(/not found/i);
    }
  });

  it('answers a bad argument as INVALID, naming the field, and calls no route', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const bad = await refused(client.readResource({ uri: 'aasc://sessions/s1/changes/abc' }));
    expect(bad.code).toBe(ErrorCode.InvalidParams);
    expect(bad.message).toContain('INVALID');
    expect(bad.message).toContain('fileIndex');
    expect(bad.message).not.toContain('abc');
    const notHex = await refused(client.readResource({ uri: 'aasc://resources/nothex' }));
    expect(notHex.message).toContain('INVALID');
    expect(started.api.calls).toEqual([]);
  });

  it('answers a session that does not exist as not found, with the tool’s hint', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const err = await refused(
      client.readResource({ uri: 'aasc://sessions/no-such-session/answer' }),
    );

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('NOT_FOUND');
    expect(err.message).toContain('Hint:');
    expect(err.message).not.toContain('no-such-session');
  });

  it('answers a task the central does not have as NOT_FOUND, with task_get’s hint, and calls no route (K3)', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    const err = await refused(client.readResource({ uri: 'aasc://tasks/T7' }));

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('NOT_FOUND');
    expect(err.message).toContain('Hint:');
    expect(err.message).not.toContain('T7');
    expect(err.data).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(started.api.calls).toEqual([]);
  });

  it('answers a session with no terminal of its own as UNAVAILABLE, with the tool’s hint', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    // s2 runs outside the dashboard: there is no terminal for the tool to read.
    const err = await refused(client.readResource({ uri: 'aasc://sessions/s2/terminal' }));

    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('UNAVAILABLE');
    expect(err.message).toContain('Hint:');
    expect(err.data).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    expect(started.api.calls).toEqual([]);
  });

  it('answers a tool’s failure as a JSON-RPC error with the tool’s code and hint, never a stack', async () => {
    const world = freshWorld();
    world.routes['GET /sessions/s1/chat'] = {
      ok: false,
      status: 500,
      data: { error: 'disk on fire' },
      error: 'disk on fire',
    };
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const err = await refused(client.readResource({ uri: 'aasc://sessions/s1/answer' }));

    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('UPSTREAM');
    expect(err.message).not.toMatch(/\bat .*\.(js|ts):\d+/);
  });

  it('keeps an unexpected failure’s details in the log, and says only that the read failed', async () => {
    const started = await startWorld();
    started.api.get = (() => {
      throw new Error('ENOENT: /Users/someone/secret/notes.json');
    }) as typeof started.api.get;
    const { client } = await connectAs(started, globalInput());

    const err = await refused(client.readResource({ uri: 'aasc://sessions/s1/answer' }));

    expect(err.code).toBe(ErrorCode.InternalError);
    expect(err.message).toContain('UPSTREAM');
    expect(JSON.stringify([err.message, err.data])).not.toMatch(/ENOENT|someone|secret/);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('ENOENT'));
  });

  it('tells a central that reads the file of a resource that is no skill where to read it instead', async () => {
    const world = freshWorld();
    world.routes[`GET /resources/item/${RES}/file`] = fail(
      404,
      'This resource has no package files',
    );
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const err = await refused(client.readResource({ uri: `aasc://resources/${RES}/file` }));

    expect(err.code).toBe(ErrorCode.InvalidParams);
    expect(err.message).toContain('NOT_FOUND');
    expect(err.message).toContain('Only a skill has files');
    expect(err.message).toContain('aasc://resources/{id}');
    expect(err.message).not.toContain('session_list');
  });

  it('never puts the central’s token into a read or an error', async () => {
    const started = await startWorld();
    const { client, central } = await connectAs(started, globalInput());

    const good = await client.readResource({ uri: 'aasc://sessions/s1' });
    const bad = await refused(client.readResource({ uri: 'aasc://sessions/nope' }));

    expect(JSON.stringify([good, bad.message, bad.data])).not.toContain(central.token);
  });
});

// ---------------------------------------------------------------------------
// What a read runs with
// ---------------------------------------------------------------------------

describe('what a read runs with', () => {
  /** A stand-in for session_list, which is what `aasc://sessions` reads. */
  const stub = (run: ToolDef['run']): ToolDef => ({
    name: 'session_list',
    toolset: 'sessions',
    title: 'Stub',
    description: 'A stand-in for session_list.',
    risk: 'read',
    phase: 1,
    input: {},
    run,
  });

  it('is the context a tool call gets: the central without its token, and from the request only the signal', async () => {
    const seen: ToolContext[] = [];
    const tool = stub(async (_args, ctx) => {
      seen.push(ctx);
      return { data: null, summary: 'seen' };
    });
    const started = await startWorld(freshWorld(), { tools: () => [tool] });
    const { client, central } = await connectAs(started, globalInput());

    await client.readResource({ uri: 'aasc://sessions' });

    expect(seen).toHaveLength(1);
    const [ctx] = seen;
    expect(Object.keys(ctx).sort()).toEqual([
      'allowedByPerson',
      'central',
      'centrals',
      'client',
      'confirms',
      'events',
      'inScope',
      'ledger',
      'mayDrive',
      'mayEdit',
      'mayEnd',
      'mayRelaunch',
      'now',
      'resolveSessionId',
      'rooms',
      'scopedSessions',
      'sessions',
      'signal',
      'workers',
    ]);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.central).toMatchObject({ centralId: central.centralId, token: '' });
    const dump = JSON.stringify(ctx, (_key, value: unknown) =>
      typeof value === 'function' ? undefined : value,
    );
    expect(dump).not.toContain(central.token);
    expect(dump).not.toMatch(/authorization|bearer|aasc_mcp_|mcp-session-id|requestInfo|headers/i);
  });

  it('ends a wait inside the tool when the central cancels the read', async () => {
    const waits = { started: 0, ended: [] as boolean[] };
    const tool = stub(async (_args, ctx) => {
      waits.started += 1;
      await ctx.events.waitFor(() => null, 50_000, ctx.signal);
      waits.ended.push(ctx.signal.aborted);
      return { data: null, summary: 'waited' };
    });
    const started = await startWorld(freshWorld(), { tools: () => [tool] });
    const { client } = await connectAs(started, globalInput());
    const stop = new AbortController();

    const read = client.readResource({ uri: 'aasc://sessions' }, { signal: stop.signal });
    await vi.waitFor(() => expect(waits.started).toBe(1), PATIENT);
    stop.abort();

    await expect(read).rejects.toThrow();
    await vi.waitFor(() => expect(waits.ended).toEqual([true]), PATIENT);
  });

  it('offers only what the stub tools back: a central given one tool reads one resource', async () => {
    const started = await startWorld(freshWorld(), {
      tools: () => [stub(async () => ({ data: null, summary: 'stub' }))],
    });
    const { client } = await connectAs(started, globalInput());

    const uris = (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);

    // No task_get among them, so no task resource either (K3).
    expect(uris).toEqual(['aasc://sessions']);
  });
});

// ---------------------------------------------------------------------------
// Completion of a session id
// ---------------------------------------------------------------------------

describe('completion', () => {
  const complete = (client: Client, uri: string, name: string, value = '') =>
    client.complete({ ref: { type: 'ref/resource', uri }, argument: { name, value } });

  it('completes the id of a session template with the sessions in scope, newest activity first', async () => {
    const world = freshWorld();
    // Stored the other way round: the answer is in order of activity, not of position.
    world.sessions.reverse();
    const started = await startWorld(world);
    const global = await connectAs(started, globalInput());
    const room = await connectAs(started, roomInput('r1'));

    expect(
      (await complete(global.client, 'aasc://sessions/{id}/answer', 'id')).completion.values,
    ).toEqual(['s1', 's2']);
    expect(
      (await complete(room.client, 'aasc://sessions/{id}/answer', 'id')).completion.values,
    ).toEqual(['s1']);
    expect(
      (await complete(global.client, 'aasc://sessions/{id}/changes/{fileIndex}', 'id', 's2'))
        .completion.values,
    ).toEqual(['s2']);
  });

  it('offers the 8-character short id of a long id, and the whole id where short ids collide', async () => {
    const world = freshWorld();
    world.sessions.push(
      makeSession('0123456789abcdef', { lastActivityAt: 5 }),
      makeSession('term-179-a', { lastActivityAt: 4 }),
      makeSession('term-179-b', { lastActivityAt: 3 }),
    );
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    const { values } = (await complete(client, 'aasc://sessions/{id}', 'id')).completion;

    expect(values).toEqual(
      expect.arrayContaining(['01234567', 'term-179-a', 'term-179-b', 's1', 's2']),
    );
    expect(values).not.toContain('term-179');
    expect(values).not.toContain('0123456789abcdef');
  });

  it('leaves out ended sessions and AI popups, as session_list does, and keeps a prefix filter', async () => {
    const world = freshWorld();
    world.sessions.push(
      makeSession('s3', { status: 'ended' }),
      makeSession('s4', { isFloating: true }),
    );
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());

    expect((await complete(client, 'aasc://sessions/{id}', 'id')).completion.values).toEqual([
      's1',
      's2',
    ]);
    expect((await complete(client, 'aasc://sessions/{id}', 'id', 's2')).completion.values).toEqual([
      's2',
    ]);
    expect((await complete(client, 'aasc://sessions/{id}', 'id', 'zz')).completion.values).toEqual(
      [],
    );
  });

  it('completes nothing for a variable that is not a session id', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    expect((await complete(client, 'aasc://resources/{id}', 'id')).completion.values).toEqual([]);
    expect((await complete(client, 'aasc://history/{id}', 'id')).completion.values).toEqual([]);
    expect(
      (await complete(client, 'aasc://sessions/{id}/changes/{fileIndex}', 'fileIndex')).completion
        .values,
    ).toEqual([]);
  });

  it('refuses to complete a template the central was not offered', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput({ cli: 'codex' }));

    const err = await refused(complete(client, 'aasc://resources/{id}', 'id'));

    expect(err.code).toBe(ErrorCode.InvalidParams);
  });
});
