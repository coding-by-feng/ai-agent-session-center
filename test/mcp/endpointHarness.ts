// test/mcp/endpointHarness.ts — what the /mcp endpoint tests share: stub tools, a fake /api client, and
// an Express app on an ephemeral port that mounts the router the way server/index.ts does (behind
// express.json, with mcpErrorHandler after it), plus the SDK's client and a raw `fetch` to talk to it.
//
// The registry is the real one; the tools are stubs (Ruling 3: the real ones arrive in Tasks 8-9). The
// AASC server is never started. A test file that uses this must mock ../../server/logger.js itself and
// run `runCleanups` after each test.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import type { InternalClient, InternalResponse } from '../../server/mcp/client.js';
import { createEventHub } from '../../server/mcp/events.js';
import {
  createMcpRouter,
  mcpErrorHandler,
  type McpRouter,
  type McpRouterOptions,
} from '../../server/mcp/index.js';
import { MCP_MAX_PHASE, type ToolContext, type ToolDef } from '../../server/mcp/registry.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { fakeBus } from './centralFixtures.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const SESSIONS = [
  { sessionId: 's1', status: 'idle' },
  { sessionId: 's2', status: 'working' },
] as unknown as Session[];
export const ROOMS = [{ id: 'room-1', name: 'Backend', sessionIds: ['s1'] }] as unknown as Room[];
export const PRESENCE = { writerOpen: true, devices: 2 };

interface ApiCall {
  method: string;
  path: string;
  query?: unknown;
  body?: unknown;
}

/** A stand-in for the loopback /api client: records each call and answers with PRESENCE. */
function fakeApi(): InternalClient & { calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  function answer<T>(call: ApiCall): Promise<InternalResponse<T>> {
    calls.push(call);
    return Promise.resolve({ ok: true, status: 200, data: PRESENCE as T, error: null });
  }
  return {
    calls,
    get: <T>(path: string, query?: unknown) => answer<T>({ method: 'GET', path, query }),
    post: <T>(path: string, body?: unknown) => answer<T>({ method: 'POST', path, body }),
    put: <T>(path: string, body?: unknown) => answer<T>({ method: 'PUT', path, body }),
    patch: <T>(path: string, body?: unknown) => answer<T>({ method: 'PATCH', path, body }),
    del: <T>(path: string, body?: unknown) => answer<T>({ method: 'DELETE', path, body }),
  };
}

function stubTool(def: Partial<ToolDef> & Pick<ToolDef, 'name' | 'toolset'>): ToolDef {
  return {
    title: `Stub ${def.name}`,
    description: `A stand-in for ${def.name}.`,
    risk: 'read',
    phase: 1,
    input: {},
    run: async () => ({ data: { tool: def.name }, summary: `${def.name} ran` }),
    ...def,
  };
}

export const runEcho = vi.fn(async (args: Record<string, unknown>) => ({
  data: { echoed: args.text },
  summary: `echo ${String(args.text)}`,
}));

/** Every context a `ctxdump` call ran with. */
export const seenContexts: ToolContext[] = [];

/** What `waiter` calls did: how many started, and how each one ended. */
export const waits = { started: 0, ended: [] as Array<{ found: unknown; aborted: boolean }> };

/** `hold` calls wait at the gate while it is shut (`shut()`), until `open()`. */
export const holds = {
  started: 0,
  gate: Promise.resolve(),
  open: (): void => undefined,
  shut(): void {
    holds.gate = new Promise<void>((resolve) => {
      holds.open = resolve;
    });
  },
};

/** Puts the stubs' shared state back between tests. */
export function resetStubs(): void {
  seenContexts.length = 0;
  waits.started = 0;
  waits.ended.length = 0;
  holds.open();
  holds.started = 0;
  holds.gate = Promise.resolve();
  holds.open = () => undefined;
}

/**
 * Catalog names where the test is about a catalog rule (room_*, resource_*, P2+), plain names where it
 * is about the mechanics. Phases and risks are the stub's, not the catalog's.
 */
export const TOOLS: ToolDef[] = [
  stubTool({
    name: 'aasc_presence',
    toolset: 'system',
    run: async (_args, ctx) => {
      const r = await ctx.client.get<typeof PRESENCE>('/presence');
      return { data: r.data, summary: 'The Mac window is open.' };
    },
  }),
  stubTool({ name: 'session_list', toolset: 'sessions' }),
  stubTool({ name: 'room_list', toolset: 'rooms' }),
  stubTool({ name: 'resource_list', toolset: 'resources' }),
  stubTool({ name: 'cloud_status', toolset: 'cloud' }),
  // A destructive stand-in whose call needs no card (P5-2: every risk that waits for the person has a `confirm`).
  stubTool({ name: 'deleter', toolset: 'notes', risk: 'destructive', confirm: () => null }),
  stubTool({
    name: 'setter',
    toolset: 'sessions',
    risk: 'write',
    idempotent: true,
    input: { id: z.string(), title: z.string() },
  }),
  stubTool({ name: 'echo', toolset: 'system', input: { text: z.string() }, run: runEcho }),
  stubTool({
    name: 'whoami',
    toolset: 'system',
    run: async (_args, ctx) => ({
      data: {
        central: ctx.central,
        sessions: ctx.sessions().map((s) => s.sessionId),
        rooms: ctx.rooms().map((r) => r.id),
        now: ctx.now(),
      },
      summary: 'me',
    }),
  }),
  stubTool({
    name: 'refuse',
    toolset: 'system',
    run: async () => {
      throw new ToolError(
        'NOT_IN_SCOPE',
        'Session s9 is outside your scope.',
        'Call session_list to see the sessions you can reach.',
      );
    },
  }),
  stubTool({
    name: 'explode',
    toolset: 'system',
    run: async () => {
      throw new Error('ENOENT: no such file, open /Users/someone/secret/notes.json');
    },
  }),
  stubTool({
    name: 'scoped',
    toolset: 'system',
    run: async (_args, ctx) => ({
      data: ctx.scopedSessions().map((s) => s.sessionId),
      summary: 'scoped',
    }),
  }),
  stubTool({
    name: 'mutator',
    toolset: 'system',
    run: async (_args, ctx) => {
      for (const s of [...ctx.scopedSessions(), ...ctx.sessions()]) {
        (s as unknown as { status: string }).status = 'tampered';
      }
      return { data: null, summary: 'tampered' };
    },
  }),
  stubTool({
    name: 'ctxdump',
    toolset: 'system',
    run: async (_args, ctx) => {
      seenContexts.push(ctx);
      return { data: null, summary: 'seen' };
    },
  }),
  stubTool({
    name: 'waiter',
    toolset: 'system',
    run: async (_args, ctx) => {
      waits.started += 1;
      const found = await ctx.events.waitFor(() => null, 50_000, ctx.signal);
      waits.ended.push({ found, aborted: ctx.signal.aborted });
      return { data: found, summary: 'waited' };
    },
  }),
  stubTool({
    name: 'hold',
    toolset: 'system',
    run: async () => {
      holds.started += 1;
      await holds.gate;
      return { data: null, summary: 'held' };
    },
  }),
  stubTool({ name: 'prompt_send', toolset: 'prompts', risk: 'steers', phase: 2 }),
  // A phase past every build (P6 is the last): the stand-in for "a later phase's tool is never listed".
  stubTool({ name: 'session_export', toolset: 'sessions', risk: 'outward', phase: 7 as ToolDef['phase'], confirm: () => null }),
];

/** The stubs a central with these toolsets should see in this build, in the order they are defined: every phase up to MCP_MAX_PHASE. */
export const stubNamesFor = (toolsets: readonly string[]) =>
  TOOLS.filter((t) => t.phase <= MCP_MAX_PHASE && toolsets.includes(t.toolset)).map((t) => t.name);

// ---------------------------------------------------------------------------
// The harness: one app, one router, a clock the test moves
// ---------------------------------------------------------------------------

export interface Harness {
  base: string;
  registry: CentralRegistry;
  router: McpRouter;
  api: ReturnType<typeof fakeApi>;
  clientFor: ReturnType<typeof vi.fn<(central: CentralRecord) => InternalClient>>;
  /** The broadcast feed the router's event hub listens to: `bus.emit` plays what the server would send. */
  bus: ReturnType<typeof fakeBus>;
  clock: { now: number };
}

/** Cleanups, run newest first after each test: clients close before their server does. */
const cleanups: Array<() => Promise<unknown>> = [];

export function onCleanup(cleanup: () => Promise<unknown>): void {
  cleanups.push(cleanup);
}

export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

export interface HarnessSetup {
  /** `'app'` puts express.json in front of the router, as server/index.ts does; `'bare'` mounts it alone. */
  mount?: 'app' | 'bare';
  /** The router never hears of a registry change (to reach the checks that back that up). */
  deafRouter?: boolean;
  /**
   * Replaces what the harness hands the router, field by field: the real tools, a test's own sessions and
   * rooms, a routed /api client, a short update delay. Everything it leaves out stays the harness's own.
   */
  deps?: Partial<McpDeps>;
}

export async function harness(
  options: McpRouterOptions = {},
  setup: HarnessSetup = {},
): Promise<Harness> {
  const registry = createCentralRegistry();
  const api = fakeApi();
  const clientFor = vi.fn<(central: CentralRecord) => InternalClient>(() => api);
  const clock = { now: 1_700_000_000_000 };
  const bus = fakeBus();
  const deps: McpDeps = {
    registry: setup.deafRouter ? { ...registry, onChange: () => () => undefined } : registry,
    client: clientFor,
    sessions: () => SESSIONS,
    rooms: () => ROOMS,
    events: createEventHub(bus.subscribe),
    tools: () => TOOLS,
    now: () => clock.now,
    ...setup.deps,
  };
  const router = createMcpRouter(deps, options);
  const app = express();
  if ((setup.mount ?? 'app') === 'app') app.use(express.json({ limit: '50mb' }));
  app.use('/mcp', router, mcpErrorHandler);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  onCleanup(async () => {
    await router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}/mcp`, registry, router, api, clientFor, bus, clock };
}

/** The SDK's client, connected as the central that holds `token`. */
export async function connect(h: Harness, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(h.base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'endpoint-test', version: '1.0.0' });
  onCleanup(() => client.close());
  await client.connect(transport);
  return { client, transport };
}

// ---------------------------------------------------------------------------
// Raw requests
// ---------------------------------------------------------------------------

export const initialize = () => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'raw-test', version: '1.0.0' },
  },
});
export const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
/** A raw tools/call. Calls open on one session at once need ids of their own. */
export const callTool = (name: string, args: Record<string, unknown> = {}, id = 3) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

interface RawInit {
  method?: string;
  token?: string;
  session?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RawAnswer {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request, read to the end. A JSON body is parsed; an SSE body yields its first `data:` line. */
export async function raw(h: Harness, init: RawInit): Promise<RawAnswer> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    ...init.headers,
  };
  if (init.token !== undefined) headers.authorization = `Bearer ${init.token}`;
  if (init.session !== undefined) {
    headers['mcp-session-id'] = init.session;
    headers['mcp-protocol-version'] = LATEST_PROTOCOL_VERSION;
  }
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(h.base, { method: init.method ?? 'POST', headers, body });
  const text = await res.text();
  const data = /^data: (.*)$/m.exec(text);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(data ? data[1] : text);
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

/** Opens a session with a raw initialize; answers its id. */
export async function openRaw(h: Harness, token: string): Promise<string> {
  const r = await raw(h, { token, body: initialize() });
  expect(r.status).toBe(200);
  const id = r.headers.get('mcp-session-id');
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id as string;
}
