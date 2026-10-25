// test/mcp/runTool.test.ts — the one way into a tool's `run` (server/mcp/runTool.ts): what it runs with, how a
// failure comes back, and that a tool call and a resource read both go through it and nothing else does. Whatever a
// later phase adds for every way a central reaches a tool (an activity log, a budget) is added there, and these
// tests are what keep a read through a resource from slipping past it.
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDef } from '../../server/mcp/registry.js';
import { RETRY_HINT, runTool, upstreamFailure } from '../../server/mcp/runTool.js';
import { ToolError } from '../../server/mcp/types.js';
import { globalInput } from './centralFixtures.js';
import { runCleanups } from './endpointHarness.js';
import { book } from './resourceBookWorld.js';
import { connectAs, freshWorld, refused, startWorld } from './resourceWorld.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

/** Every run that went through `runTool`, whoever asked: the tool and how it was reached. */
const seen = vi.hoisted(() => ({ runs: [] as Array<{ tool: string; via: string }> }));
vi.mock('../../server/mcp/runTool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/mcp/runTool.js')>();
  return {
    ...actual,
    runTool: (...args: Parameters<typeof actual.runTool>) => {
      seen.runs.push({ tool: args[0].name, via: args[2].via });
      return actual.runTool(...args);
    },
  };
});

beforeEach(() => {
  seen.runs.length = 0;
  log.warn.mockClear();
  log.debug.mockClear();
});

afterEach(runCleanups);

/** A tool of the test's own, which does what `run` says. */
const stub = (run: ToolDef['run'], name = 'stub_tool'): ToolDef => ({
  name,
  toolset: 'system',
  title: 'Stub',
  description: 'A stand-in.',
  risk: 'read',
  phase: 1,
  input: {},
  run,
});

describe('runTool', () => {
  it('runs the tool as the central, with the arguments as given and the context a tool call gets', async () => {
    const { deps, central } = book(globalInput());
    const stop = new AbortController();
    const answer = { data: { ok: 1 }, summary: 'done' };
    let given: Parameters<ToolDef['run']> | null = null;
    const tool = stub(async (args, ctx) => {
      given = [args, ctx];
      return answer;
    });

    const result = await runTool(
      tool,
      { x: 1 },
      { centralId: central.centralId, deps, signal: stop.signal, via: 'call' },
    );

    expect(result).toBe(answer);
    const [args, ctx] = given as unknown as Parameters<ToolDef['run']>;
    expect(args).toEqual({ x: 1 });
    expect(ctx.central).toMatchObject({ centralId: central.centralId, token: '' });
    expect(ctx.signal).toBe(stop.signal);
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
  });

  it('lets a refusal through as it is', async () => {
    const { deps, central } = book(globalInput());
    const refusal = new ToolError('NOT_IN_SCOPE', 'Outside your scope.', 'Call session_list.');
    const tool = stub(async () => {
      throw refusal;
    });

    const failure = await runTool(
      tool,
      {},
      { centralId: central.centralId, deps, signal: new AbortController().signal, via: 'read' },
    ).catch((e: unknown) => e);

    expect(failure).toBe(refusal);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('answers any other failure as UPSTREAM in fixed words, and keeps its details in the log', async () => {
    const { deps, central } = book(globalInput());
    const tool = stub(async () => {
      throw new Error('ENOENT: /Users/someone/secret/notes.json');
    });

    const failure = await runTool(
      tool,
      {},
      { centralId: central.centralId, deps, signal: new AbortController().signal, via: 'call' },
    ).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'UPSTREAM',
      message: 'stub_tool failed inside AASC.',
      hint: RETRY_HINT,
    });
    expect(JSON.stringify(failure)).not.toMatch(/ENOENT|someone|secret/);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('ENOENT'));
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining(central.centralId));
  });

  it('answers UNAVAILABLE, and never runs the tool, for a central that is no longer live', async () => {
    const { deps, central, registry } = book(globalInput());
    const run = vi.fn(async () => ({ data: null, summary: 'ran' }));
    registry.revoke(central.centralId);

    const failure = await runTool(
      stub(run),
      {},
      { centralId: central.centralId, deps, signal: new AbortController().signal, via: 'call' },
    ).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();
  });

  it('says in the debug log how the central reached the tool', async () => {
    const { deps, central } = book(globalInput());
    const tool = stub(async () => ({ data: null, summary: 'ok' }));
    const signal = new AbortController().signal;

    await runTool(tool, {}, { centralId: central.centralId, deps, signal, via: 'call' });
    await runTool(tool, {}, { centralId: central.centralId, deps, signal, via: 'read' });

    expect(log.debug).toHaveBeenCalledWith('mcp', `Central ${central.centralId} calls stub_tool`);
    expect(log.debug).toHaveBeenCalledWith('mcp', `Central ${central.centralId} reads stub_tool`);
  });
});

describe('upstreamFailure', () => {
  it('names what failed and the central, and never what the failure said', () => {
    const failure = upstreamFailure(
      'Reading the thing',
      'central-9',
      new Error('the disk said /Users/x/secret'),
    );

    expect(failure).toMatchObject({
      code: 'UPSTREAM',
      message: 'Reading the thing failed inside AASC.',
      hint: RETRY_HINT,
    });
    expect(failure.message).not.toMatch(/disk|secret/);
    expect(log.warn).toHaveBeenCalledWith(
      'mcp',
      'Reading the thing failed for central central-9: the disk said /Users/x/secret',
    );
  });

  it('takes anything thrown, not only an Error', () => {
    expect(upstreamFailure('x', 'c', 'just a string').code).toBe('UPSTREAM');
    expect(log.warn).toHaveBeenCalledWith('mcp', 'x failed for central c: just a string');
  });
});

describe('the one way in', () => {
  it('is the only place in server/mcp that calls a tool’s run', async () => {
    const root = new URL('../../server/mcp/', import.meta.url);
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith('.ts'));
    const callers: string[] = [];
    for (const file of files) {
      if (/\.run\(/.test(await readFile(new URL(file, root), 'utf8'))) callers.push(file);
    }

    // A new way to reach a tool goes through runTool, or the activity log and the budgets of later phases skip it.
    expect(callers).toEqual(['runTool.ts']);
  });

  it('is what a tool call and a resource read both go through, and a subscription or a completion never touches', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());

    await client.callTool({ name: 'session_list', arguments: {} });
    await client.readResource({ uri: 'aasc://sessions' });
    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await client.complete({
      ref: { type: 'ref/resource', uri: 'aasc://sessions/{id}' },
      argument: { name: 'id', value: '' },
    });

    expect(seen.runs).toEqual([
      { tool: 'session_list', via: 'call' },
      { tool: 'session_list', via: 'read' },
    ]);
  });

  it('gives a failure the same words whether the tool was called or a resource of it was read', async () => {
    const tool = stub(async () => {
      throw new Error('ENOENT: /Users/someone/secret/notes.json');
    }, 'session_list');
    const started = await startWorld(freshWorld(), { tools: () => [tool] });
    const { client } = await connectAs(started, globalInput());

    const called = await client.callTool({ name: 'session_list', arguments: {} });
    const read = await refused(client.readResource({ uri: 'aasc://sessions' }));

    expect(called.structuredContent).toEqual({
      ok: false,
      code: 'UPSTREAM',
      message: 'session_list failed inside AASC.',
      hint: RETRY_HINT,
    });
    expect(read.code).toBe(ErrorCode.InternalError);
    expect(read.data).toEqual({
      ok: false,
      code: 'UPSTREAM',
      message: 'session_list failed inside AASC.',
      hint: RETRY_HINT,
    });
    expect(read.message).toContain('UPSTREAM: session_list failed inside AASC.');
    expect(JSON.stringify([called, read.message, read.data])).not.toMatch(/ENOENT|someone|secret/);
  });

  it('words a failure that is the read’s own, outside the tool, the same way: fixed words, details in the log', async () => {
    // The tool answers; it is the answer that cannot be written as JSON.
    const circular: Record<string, unknown> = { note: 'a thing that is its own part' };
    circular.self = circular;
    const tool = stub(async () => ({ data: circular, summary: 'ok' }), 'session_list');
    const started = await startWorld(freshWorld(), { tools: () => [tool] });
    const { client, central } = await connectAs(started, globalInput());

    const read = await refused(client.readResource({ uri: 'aasc://sessions' }));

    expect(read.code).toBe(ErrorCode.InternalError);
    expect(read.data).toEqual({
      ok: false,
      code: 'UPSTREAM',
      message: 'Reading sessions failed inside AASC.',
      hint: RETRY_HINT,
    });
    expect(read.message).not.toMatch(/circular|JSON/i);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('circular'));
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining(central.centralId));
  });
});
