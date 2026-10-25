// test/mcp/endpoint.test.ts — the /mcp endpoint end to end (server/mcp/index.ts and server.ts).
//
// The SDK's own Client and StreamableHTTPClientTransport talk real HTTP to an Express app on an
// ephemeral port (endpointHarness.ts) that mounts the router the way server/index.ts does. The registry
// is the real one; the tools are stubs and /api is a fake client. The AASC server itself is never
// started, and nothing here reaches a real process.
//
// A raw `fetch` stands in for the client wherever a test needs what the SDK hides: a status code, a
// header, a body, or a request the SDK would never send (another central's session id, no token).
// The event hub has its own file (events.test.ts), and so does server/index.ts's wiring
// (indexWiring.test.ts).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { centralClient, MAX_IN_FLIGHT_PER_SESSION } from '../../server/mcp/index.js';
import { __resetMcpPortForTest, setMcpPort } from '../../server/mcp/runtime.js';
import { CORE_TOOLSETS } from '../../server/mcp/types.js';
import { globalInput, roomInput } from './centralFixtures.js';
import {
  callTool,
  connect,
  harness,
  holds,
  initialize,
  listTools,
  onCleanup,
  openRaw,
  PRESENCE,
  raw,
  resetStubs,
  runCleanups,
  runEcho,
  seenContexts,
  SESSIONS,
  stubNamesFor,
  waits,
} from './endpointHarness.js';

// The registry, the router and the server log; the logger would append to a file on disk.
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
  resetStubs();
  await runCleanups();
  runEcho.mockClear();
  log.warn.mockClear();
});

/** Room for a sweep (every 5 ms in these tests) to run on a busy machine. */
const SWEEP_WAIT = { timeout: 5_000, interval: 20 };

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('initialize with a valid token', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    expect(client.getServerVersion()?.name).toBe('aasc');
    const instructions = client.getInstructions() ?? '';
    expect(instructions.trim().length).toBeGreaterThan(0);
    expect(instructions).not.toContain(central.token);
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
      resources: { subscribe: true, listChanged: true },
      prompts: {},
      logging: {},
    });
  });

  it('answers the resource and prompt lists it announces, empty for a central whose toolsets back none', async () => {
    // The lists are filled from the tools a central has (resources.test.ts, prompts.test.ts); with none, they
    // are empty and answered, not "method not found" for a capability the server announces.
    const h = await harness();
    const central = h.registry.mint(globalInput({ toolsets: ['agenda'] }));
    const { client } = await connect(h, central.token);

    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await client.listPrompts()).prompts).toEqual([]);
  });

  it('works when the app has no body parser of its own', async () => {
    const h = await harness({}, { mount: 'bare' });
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('aasc_presence');
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('tools/list', () => {
  it("tools/list is the central's toolsets up to P2", async () => {
    const h = await harness();
    const codex = h.registry.mint(globalInput({ cli: 'codex' }));
    const claude = h.registry.mint(roomInput('room-1', { cli: 'claude' }));

    const codexNames = (await (await connect(h, codex.token)).client.listTools()).tools.map(
      (t) => t.name,
    );
    const claudeNames = (await (await connect(h, claude.token)).client.listTools()).tools.map(
      (t) => t.name,
    );

    // A Codex global central gets the core toolsets: no rooms, resources or cloud.
    expect(codexNames).toEqual(stubNamesFor(CORE_TOOLSETS));
    expect(codexNames.filter((n) => /^(room|resource)s?_/.test(n))).toEqual([]);
    expect(codexNames).not.toContain('cloud_status');
    // A Claude central gets every toolset.
    expect(claudeNames).toEqual(
      expect.arrayContaining(['room_list', 'resource_list', 'cloud_status', 'aasc_presence']),
    );
    // Both see a phase 2 tool of their toolsets; neither sees a tool from a later phase.
    for (const names of [codexNames, claudeNames]) {
      expect(names).toContain('prompt_send');
      expect(names).not.toContain('session_export');
    }
  });

  it('lists nothing, without an error, for a central whose toolsets have no tool yet', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput({ toolsets: ['agenda'] }));
    const { client } = await connect(h, central.token);

    expect((await client.listTools()).tools).toEqual([]);
  });

  it('describes each tool: its input schema, the shared output schema, annotations from its risk', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    expect(tools.get('aasc_presence')).toMatchObject({
      title: 'Stub aasc_presence',
      description: 'A stand-in for aasc_presence.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    });
    expect(tools.get('cloud_status')?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(tools.get('deleter')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.get('setter')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.get('echo')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    });
    for (const tool of tools.values()) {
      expect(Object.keys(tool.outputSchema?.properties ?? {}).sort()).toEqual([
        'code',
        'data',
        'hint',
        'message',
        'ok',
      ]);
      expect(tool.outputSchema?.required).toEqual(['ok']);
    }
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe('tools/call', () => {
  it('a tool call returns structuredContent', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput({ cli: 'codex' }));
    const { client } = await connect(h, central.token);

    const result = await client.callTool({ name: 'aasc_presence', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ ok: true, data: PRESENCE });
    expect(result.content).toEqual([{ type: 'text', text: 'The Mac window is open.' }]);
    expect(h.api.calls).toEqual([{ method: 'GET', path: '/presence', query: undefined }]);
    // The /api client is made for this central, from a record that holds no token.
    expect(h.clientFor).toHaveBeenCalledWith(
      expect.objectContaining({ centralId: central.centralId, token: '' }),
    );
  });

  it('ToolError becomes isError with code', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const result = await client.callTool({ name: 'refuse', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      code: 'NOT_IN_SCOPE',
      message: 'Session s9 is outside your scope.',
      hint: 'Call session_list to see the sessions you can reach.',
    });
    // A client that reads only the text still gets the code and the hint.
    const [text] = result.content as Array<{ type: string; text: string }>;
    expect(text.type).toBe('text');
    expect(text.text).toContain('NOT_IN_SCOPE');
    expect(text.text).toContain('Session s9 is outside your scope.');
    expect(text.text).toContain('Call session_list to see the sessions you can reach.');
  });

  it('turns any other failure into UPSTREAM and keeps its details in the server log', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const result = await client.callTool({ name: 'explode', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'UPSTREAM' });
    const shown = JSON.stringify(result);
    expect(shown).not.toContain('ENOENT');
    expect(shown).not.toContain('/Users/someone');
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('ENOENT'));
  });

  it('checks the arguments against the input schema before the tool runs', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const ok = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(ok.structuredContent).toEqual({ ok: true, data: { echoed: 'hi' } });

    const bad = await client.callTool({ name: 'echo', arguments: { text: 42 } });
    expect(bad.isError).toBe(true);
    expect(runEcho).toHaveBeenCalledTimes(1);
  });

  it('answers bad arguments with INVALID, naming the fields, in the same envelope as every error', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const wrongType = await client.callTool({ name: 'echo', arguments: { text: 42 } });
    expect(wrongType).toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: 'INVALID', message: expect.stringContaining('text') },
    });
    const [text] = wrongType.content as Array<{ type: string; text: string }>;
    expect(text.text).toMatch(/^INVALID: /);

    const missing = await client.callTool({ name: 'setter', arguments: { id: 'a' } });
    expect(missing.structuredContent).toMatchObject({
      ok: false,
      code: 'INVALID',
      message: expect.stringContaining('title'),
    });
    expect(runEcho).not.toHaveBeenCalled();
  });

  it("answers a tool the central does not have with NOT_FOUND: unknown, another toolset's, a later phase's", async () => {
    const h = await harness();
    const codex = h.registry.mint(globalInput({ cli: 'codex' }));
    const { client } = await connect(h, codex.token);

    // session_export is a phase 7 stand-in in a toolset the central has; room_list belongs to a toolset it has not.
    for (const name of ['no_such_tool', 'room_list', 'session_export']) {
      const answer = await client.callTool({ name, arguments: {} });
      expect(answer, name).toMatchObject({
        isError: true,
        structuredContent: { ok: false, code: 'NOT_FOUND' },
      });
    }
    // The list it is offered is what it was before the call went through AASC's own handler.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(stubNamesFor(CORE_TOOLSETS));
  });

  it('runs every call as the central the registry holds now, without its token', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const before = await client.callTool({ name: 'whoami', arguments: {} });
    expect(before.structuredContent).toMatchObject({
      ok: true,
      data: {
        central: { centralId: central.centralId, terminalId: null, token: '' },
        sessions: ['s1', 's2'],
        rooms: ['room-1'],
        now: h.clock.now,
      },
    });

    // The terminal is attached after the CLI connected: the next call sees it.
    h.registry.attachTerminal(central.centralId, 'term-7');
    const after = await client.callTool({ name: 'whoami', arguments: {} });
    expect(after.structuredContent).toMatchObject({
      data: { central: { terminalId: 'term-7', token: '' } },
    });
    expect(JSON.stringify([before, after])).not.toContain(central.token);
  });
});

// ---------------------------------------------------------------------------
// The tool context
// ---------------------------------------------------------------------------

describe('the tool context', () => {
  it("offers the central's scope as copies a tool cannot change the store through", async () => {
    const h = await harness();
    const room = h.registry.mint(roomInput('room-1'));
    const global = h.registry.mint(globalInput());
    const asRoom = (await connect(h, room.token)).client;
    const asGlobal = (await connect(h, global.token)).client;

    expect((await asRoom.callTool({ name: 'scoped', arguments: {} })).structuredContent).toEqual({
      ok: true,
      data: ['s1'],
    });
    expect((await asGlobal.callTool({ name: 'scoped', arguments: {} })).structuredContent).toEqual({
      ok: true,
      data: ['s1', 's2'],
    });

    await asGlobal.callTool({ name: 'mutator', arguments: {} });
    expect(SESSIONS.map((s) => s.status)).toEqual(['idle', 'working']);
  });

  it('carries no request header and no token: only the call signal comes from the request', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    await client.callTool({ name: 'ctxdump', arguments: {} });

    expect(seenContexts).toHaveLength(1);
    const [ctx] = seenContexts;
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
    const dump = JSON.stringify(ctx, (_key, value: unknown) =>
      typeof value === 'function' ? undefined : value,
    );
    expect(dump).not.toContain(central.token);
    expect(dump).not.toMatch(/authorization|bearer|aasc_mcp_|mcp-session-id|requestInfo|headers/i);
  });

  it('ends a wait when the central cancels the call', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);
    const stop = new AbortController();

    const call = client.callTool({ name: 'waiter', arguments: {} }, undefined, {
      signal: stop.signal,
    });
    await vi.waitFor(() => expect(waits.started).toBe(1));
    stop.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(waits.ended).toEqual([{ found: null, aborted: true }]));
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('the gate', () => {
  it('401 without a token; 403 for a foreign Origin', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());

    const noToken = await raw(h, { body: initialize() });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
    expect(noToken.body).toMatchObject({
      jsonrpc: '2.0',
      error: { data: { code: 'NO_TOKEN' } },
      id: null,
    });

    const badToken = await raw(h, { token: 'aasc_mcp_nobody-holds-this', body: initialize() });
    expect(badToken.status).toBe(401);
    expect(badToken.headers.get('www-authenticate')).toMatch(/^Bearer\b.*invalid_token/);
    expect(badToken.body.error.data.code).toBe('BAD_TOKEN');

    const foreign = await raw(h, {
      token: central.token,
      body: initialize(),
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('www-authenticate')).toBeNull();
    expect(foreign.body.error.data.code).toBe('BAD_ORIGIN');

    // The SDK's client is refused the same way.
    await expect(connect(h, 'aasc_mcp_nobody-holds-this')).rejects.toMatchObject({ code: 401 });
  });

  it('gates every request, not only the first one', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const session = await openRaw(h, central.token);

    for (const method of ['POST', 'GET', 'DELETE']) {
      const r = await raw(h, { method, session, body: method === 'POST' ? listTools : undefined });
      expect(r.status, method).toBe(401);
    }

    h.registry.revoke(central.centralId);
    expect((await raw(h, { token: central.token, session, body: listTools })).status).toBe(401);
  });

  it('never sends the token back, whatever the answer', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const other = h.registry.mint(roomInput('room-1'));
    const session = await openRaw(h, central.token);

    const answers = [
      await raw(h, { token: central.token, body: initialize() }),
      await raw(h, { token: central.token, session, body: listTools }),
      await raw(h, { token: central.token, session, body: callTool('whoami') }),
      await raw(h, { token: central.token, session, body: callTool('refuse') }),
      await raw(h, { token: central.token, session, body: callTool('explode') }),
      await raw(h, { token: other.token, session, body: listTools }),
      await raw(h, { token: central.token, session: 'no-such-session', body: listTools }),
      await raw(h, { token: central.token, method: 'PUT', body: listTools }),
      await raw(h, { token: central.token, body: '{"jsonrpc":' }),
      await raw(h, {
        token: central.token,
        headers: { origin: 'https://evil.example' },
        body: listTools,
      }),
      await raw(h, { token: `${central.token}x`, body: initialize() }),
    ];
    for (const answer of answers) {
      expect(answer.text).not.toContain(central.token);
      expect(answer.text).not.toContain(other.token);
      for (const [, value] of answer.headers) {
        expect(value).not.toContain(central.token);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// MCP sessions
// ---------------------------------------------------------------------------

describe('MCP sessions', () => {
  it('rejects a session id opened by another central', async () => {
    const h = await harness();
    const a = h.registry.mint(globalInput());
    const b = h.registry.mint(roomInput('room-1'));
    const session = await openRaw(h, a.token);

    for (const method of ['POST', 'GET', 'DELETE']) {
      const r = await raw(h, {
        method,
        token: b.token,
        session,
        body: method === 'POST' ? listTools : undefined,
      });
      expect(r.status, method).toBe(403);
    }

    // It is still A's session, and it still works for A.
    const mine = await raw(h, { token: a.token, session, body: listTools });
    expect(mine.status).toBe(200);
    expect(mine.body.result.tools.length).toBeGreaterThan(0);
  });

  it('answers an unknown session id with 404, and a request with none with 400 unless it initializes', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());

    const unknown = await raw(h, {
      token: central.token,
      session: '00000000-0000-4000-8000-000000000000',
      body: listTools,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe(-32001);

    expect((await raw(h, { token: central.token, body: listTools })).status).toBe(400);
    expect((await raw(h, { token: central.token, method: 'GET' })).status).toBe(400);
    expect((await raw(h, { token: central.token, method: 'DELETE' })).status).toBe(400);
  });

  it('DELETE closes the session', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const { transport } = await connect(h, central.token);
    const session = transport.sessionId as string;
    expect(h.router.openSessionCount(central.centralId)).toBe(1);

    await transport.terminateSession();

    expect(h.router.openSessionCount(central.centralId)).toBe(0);
    expect((await raw(h, { token: central.token, session, body: listTools })).status).toBe(404);
  });

  it("closes a central's sessions when it is revoked, and only that central's", async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const other = h.registry.mint(roomInput('room-1'));
    const session = await openRaw(h, central.token);
    const kept = await openRaw(h, other.token);

    h.registry.revoke(central.centralId);

    expect(h.router.openSessionCount(central.centralId)).toBe(0);
    expect(h.router.openSessionCount(other.centralId)).toBe(1);
    // A relaunch mints the same central again; the old session is gone, not handed to it.
    const relaunched = h.registry.mint(globalInput({ centralId: central.centralId }));
    expect((await raw(h, { token: relaunched.token, session, body: listTools })).status).toBe(404);
    expect((await raw(h, { token: other.token, session: kept, body: listTools })).status).toBe(200);
  });

  it('ends a session with the token that opened it: a relaunch or a rotation closes it', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());
    const before = await openRaw(h, central.token);

    // A relaunch mints the same central again, under a new token, without revoking it first.
    const relaunched = h.registry.mint(globalInput({ centralId: central.centralId }));
    expect(h.router.openSessionCount(central.centralId)).toBe(0);
    expect(
      (await raw(h, { token: relaunched.token, session: before, body: listTools })).status,
    ).toBe(404);

    const current = await openRaw(h, relaunched.token);
    h.registry.attachTerminal(central.centralId, 'term-3');
    expect(h.router.openSessionCount(central.centralId)).toBe(1);

    const rotated = h.registry.rotate(central.centralId);
    expect(h.router.openSessionCount(central.centralId)).toBe(0);
    expect((await raw(h, { token: rotated.token, session: current, body: listTools })).status).toBe(
      404,
    );
  });

  it('closes a session idle for 30 minutes, never one with a request still open', async () => {
    const h = await harness({ sweepEveryMs: 5 });
    const central = h.registry.mint(globalInput());
    const idle = await openRaw(h, central.token);
    const streaming = await openRaw(h, central.token);
    // A client holding its event stream open is there, however quiet.
    const stop = new AbortController();
    const stream = await fetch(h.base, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${central.token}`,
        'mcp-session-id': streaming,
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      },
      signal: stop.signal,
    });
    expect(stream.status).toBe(200);

    // 29 minutes is not idle: several sweeps (every 5 ms here) pass and both stay.
    h.clock.now += 29 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.router.openSessionCount()).toBe(2);

    h.clock.now += 2 * 60_000;
    await vi.waitFor(() => expect(h.router.openSessionCount()).toBe(1), SWEEP_WAIT);
    expect((await raw(h, { token: central.token, session: idle, body: listTools })).status).toBe(
      404,
    );

    // Once its stream closes, the quiet one goes the same way.
    stop.abort();
    await vi.waitFor(() => {
      h.clock.now += 31 * 60_000;
      expect(h.router.openSessionCount()).toBe(0);
    }, SWEEP_WAIT);
  });

  it('holds a few sessions per central, and lets the least recently used one go first', async () => {
    const h = await harness({ maxSessionsPerCentral: 2 });
    const central = h.registry.mint(globalInput());
    const first = await openRaw(h, central.token);
    h.clock.now += 1_000;
    const second = await openRaw(h, central.token);
    h.clock.now += 1_000;
    // `first` is used again, so `second` is now the one seen longest ago.
    expect((await raw(h, { token: central.token, session: first, body: listTools })).status).toBe(
      200,
    );
    h.clock.now += 1_000;
    const third = await openRaw(h, central.token);

    expect(h.router.openSessionCount(central.centralId)).toBe(2);
    expect((await raw(h, { token: central.token, session: second, body: listTools })).status).toBe(
      404,
    );
    for (const session of [first, third]) {
      expect((await raw(h, { token: central.token, session, body: listTools })).status).toBe(200);
    }
  });

  it('answers 429 past the cap of requests open on one session, and serves it again once they end', async () => {
    const h = await harness({ maxInFlightPerSession: 2 });
    const central = h.registry.mint(globalInput());
    const session = await openRaw(h, central.token);
    holds.shut();

    const held = [10, 11].map((id) =>
      raw(h, { token: central.token, session, body: callTool('hold', {}, id) }),
    );
    await vi.waitFor(() => expect(holds.started).toBe(2));

    const third = await raw(h, { token: central.token, session, body: listTools });
    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.stringMatching(/\S/) },
      id: null,
    });

    holds.open();
    for (const answer of await Promise.all(held)) expect(answer.status).toBe(200);
    expect((await raw(h, { token: central.token, session, body: listTools })).status).toBe(200);
    expect(MAX_IN_FLIGHT_PER_SESSION).toBe(16);
  });

  it('answers 404 when a session meets a token other than the one that opened it', async () => {
    // The router never hears of the rotation, so the session is still filed: the check on each request
    // is all that stands between the new token and the old session.
    const h = await harness({}, { deafRouter: true });
    const central = h.registry.mint(globalInput());
    const session = await openRaw(h, central.token);
    const rotated = h.registry.rotate(central.centralId);
    expect(h.router.openSessionCount(central.centralId)).toBe(1);

    const answer = await raw(h, { token: rotated.token, session, body: listTools });

    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe(-32001);
  });

  it('answers other methods with 405 and other paths with 404', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());

    const put = await raw(h, { method: 'PUT', token: central.token, body: listTools });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST, DELETE');

    const elsewhere = await fetch(`${h.base}/other`, {
      headers: { authorization: `Bearer ${central.token}` },
    });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers.get('content-type')).toMatch(/application\/json/);
  });

  it.each(['app', 'bare'] as const)(
    'answers malformed JSON with a JSON-RPC parse error, never a page (%s mount)',
    async (mount) => {
      const h = await harness({}, { mount });
      const central = h.registry.mint(globalInput());

      const r = await raw(h, { token: central.token, body: '{"jsonrpc":' });

      expect(r.status).toBe(400);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(r.body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null });
      expect(r.text).not.toMatch(/<html|<pre|\bat .*\.js:\d+/i);
    },
  );

  it('answers malformed JSON from a page on another site with the refusal, not the parse error', async () => {
    const h = await harness();
    const central = h.registry.mint(globalInput());

    const r = await raw(h, {
      token: central.token,
      body: '{"jsonrpc":',
      headers: { origin: 'https://evil.example' },
    });

    expect(r.status).toBe(403);
    expect(r.body.error.data.code).toBe('BAD_ORIGIN');
  });
});

// ---------------------------------------------------------------------------
// The /api client a central's tools use
// ---------------------------------------------------------------------------

describe('centralClient', () => {
  afterEach(() => __resetMcpPortForTest());

  it("calls /api on the server's port as mcp:<centralId>", async () => {
    const seen: Array<string | undefined> = [];
    const app = express();
    app.get('/api/presence', (req, res) => {
      seen.push(req.header('x-aasc-client-id'));
      res.json({ ok: true });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onCleanup(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    setMcpPort((server.address() as AddressInfo).port);

    const answer = await centralClient({ centralId: 'central-1' }).get('/presence');

    expect(answer).toMatchObject({ ok: true, status: 200 });
    expect(seen).toEqual(['mcp:central-1']);
  });

  it('fails the call, not the server, while the port is unknown', async () => {
    __resetMcpPortForTest();

    const answer = await centralClient({ centralId: 'central-1' }).get('/presence');

    expect(answer).toMatchObject({ ok: false, status: 0 });
    expect(answer.error).toMatch(/port/i);
  });
});
