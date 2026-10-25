// test/mcp/resourceWorld.ts — what the resource, subscription and prompt tests share: the 18 URIs the catalog
// lists (written out here on purpose, so a drift in the code cannot hide), a small world of sessions and rooms,
// the routes the real read tools call, and a central connected over the real endpoint with the SDK's client.
//
// A test file that uses this must mock ../../server/logger.js itself and run `runCleanups` after each test.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  McpError,
  ResourceUpdatedNotificationSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { vi } from 'vitest';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import type { MintInput } from '../../server/mcp/centrals.js';
import { allTools } from '../../server/mcp/registry.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { connect, harness, type Harness } from './endpointHarness.js';
import { row } from './historyFixtures.js';
import {
  envelope,
  fakeClient,
  makeRoom,
  makeSession,
  NOW,
  ok,
  type Answer,
} from './toolHarness.js';

/** The 18 resources of the catalog, in its order. */
export const CATALOG_URIS = [
  'aasc://sessions',
  'aasc://sessions/{id}',
  'aasc://sessions/{id}/conversation',
  'aasc://sessions/{id}/answer',
  'aasc://sessions/{id}/changes',
  'aasc://sessions/{id}/changes/{fileIndex}',
  'aasc://sessions/{id}/terminal',
  'aasc://sessions/{id}/queue',
  'aasc://sessions/{id}/subagents/{agentId}',
  'aasc://tasks/{taskId}',
  'aasc://rooms',
  'aasc://resources/{id}',
  'aasc://resources/{id}/file',
  'aasc://snippets',
  'aasc://history/{id}',
  'aasc://notes/media/{id}',
  'aasc://plan-usage',
  'aasc://workspace',
] as const;

/** The five with no variable: `resources/list` shows them as they are. */
export const STATIC_URIS = CATALOG_URIS.filter((uri) => !uri.includes('{'));

export const RES = 'a1b2c3d4e5f60718';
export const MEDIA = 'a'.repeat(32);
export const T0 = Date.UTC(2026, 9, 24, 11, 5, 22);

const b64 = (text: string): string => Buffer.from(text).toString('base64');

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface World {
  sessions: Session[];
  rooms: Room[];
  routes: Record<string, Answer>;
}

/**
 * Two sessions: `s1` in room r1 and folder /a/proj, `s2` in room r2 and folder /b/other. A global central sees
 * both, a room central of r1 or a project central of /a/proj only `s1`.
 */
export function freshWorld(): World {
  return {
    sessions: [
      makeSession('s1', {
        title: 'Fix login',
        status: 'working',
        terminalId: 'term-1',
        lastActivityAt: NOW - 1_000,
      }),
      makeSession('s2', { title: 'Docs', projectPath: '/b/other', lastActivityAt: NOW - 2_000 }),
    ],
    rooms: [makeRoom('r1', ['s1'], 'Backend'), makeRoom('r2', ['s2'], 'Docs')],
    routes: {
      'GET /sessions/s1/chat': envelope({
        entries: [
          { kind: 'user', key: '0:0', timestamp: T0, text: 'Fix the login' },
          {
            kind: 'assistant',
            key: '0:1',
            timestamp: T0 + 5_000,
            text: 'Done. The login works now.',
          },
        ],
        before: 'b',
        after: 'a',
        cli: 'claude',
        hasMore: false,
      }),
      'GET /sessions/s1/changes': envelope({
        cli: 'claude',
        total: { added: 3, removed: 1 },
        files: [{ path: '/a/proj/login.ts', added: 3, removed: 1, lastAt: T0 }],
      }),
      'GET /sessions/s1/changes/0': envelope({
        path: '/a/proj/login.ts',
        added: 3,
        removed: 1,
        lastAt: T0,
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ['-old', '+new', '+newer'] },
        ],
      }),
      'GET /terminals/term-1/output': ok({ ok: true, output: b64('npm test\nall passed\n') }),
      'GET /sessions/s1/queue': ok({ sessionId: 's1', items: [], automation: null, updatedAt: 0 }),
      'GET /sessions/s1/subagents/a-1/transcript': envelope({
        task: 'Look at the login',
        entries: [],
        start: 0,
        hasEarlier: false,
      }),
      'GET /rooms': ok({
        ok: true,
        rooms: [{ id: 'r1', name: 'Backend', sessionIds: ['s1'], collapsed: false, createdAt: 0 }],
        revision: 1,
      }),
      [`GET /resources/item/${RES}`]: envelope({
        summary: {
          id: RES,
          type: 'skill',
          agent: 'claude',
          scope: 'global',
          origin: 'user',
          name: 'brainstorm',
          path: '~/x',
          fileCount: 1,
          bytes: 5,
        },
        findings: [],
      }),
      [`GET /resources/item/${RES}/file`]: envelope({
        path: 'SKILL.md',
        bytes: 5,
        content: 'hello',
      }),
      'GET /snippets': ok({
        success: true,
        revision: 1,
        snippets: [
          { id: 1, label: 'greet', text: 'hi', useCount: 0, lastUsedAt: null, createdAt: 1 },
        ],
      }),
      'GET /db/sessions/h1': ok({ session: row('h1', '/a/proj') }),
      [`GET /note-media/${MEDIA}/meta`]: ok({ sessionId: 's1', mime: 'image/png', bytes: 1 }),
      'GET /workspace/load': ok({ version: 1, sessions: [], rooms: [] }),
    },
  };
}

// ---------------------------------------------------------------------------
// A central connected over the real endpoint
// ---------------------------------------------------------------------------

/** How long a burst of updates waits before it becomes one notification, in the endpoint tests. */
export const SHORT_DEBOUNCE_MS = 25;

export interface Started {
  h: Harness;
  world: World;
  /** The recording /api client every central's tools use. */
  api: ReturnType<typeof fakeClient>;
}

/**
 * The endpoint with the real tools, over `world` (the test may change it later: the router reads it on every call).
 * `deps` replaces any of what it hands the router, for a test that needs a stub tool.
 */
export async function startWorld(
  world: World = freshWorld(),
  deps: Partial<McpDeps> = {},
): Promise<Started> {
  const api = fakeClient(world.routes);
  const h = await harness(
    {},
    {
      deps: {
        tools: allTools,
        sessions: () => world.sessions,
        rooms: () => world.rooms,
        client: () => api,
        now: () => NOW,
        resourceDebounceMs: SHORT_DEBOUNCE_MS,
        ...deps,
      },
    },
  );
  return { h, world, api };
}

/** Mints a central from `input` and connects the SDK's client to the endpoint as it. */
export async function connectAs(started: Started, input: MintInput) {
  const central = started.h.registry.mint(input);
  const { client, transport } = await connect(started.h, central.token);
  return { client, transport, central };
}

/** The URIs a client is told have changed, in the order it hears them. */
export function listenForUpdates(client: Client): string[] {
  const heard: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    heard.push(n.params.uri);
  });
  return heard;
}

export const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** For `vi.waitFor` on something that must happen but whose moment depends on a busy machine: wait for it, up to 5 s. */
export const PATIENT = { timeout: 5_000, interval: 20 } as const;

/**
 * Plays `emit` until the client has heard something. The SDK's client opens its event stream right after it
 * connects, and a notification sent before that stream exists is dropped, so a test's first update may need a
 * second try. Afterwards the caller lets the burst settle and clears what was heard.
 */
export async function untilHeard(heard: string[], emit: () => void): Promise<void> {
  await vi.waitFor(
    () => {
      emit();
      if (heard.length === 0) throw new Error('Nothing heard yet');
    },
    { timeout: 5_000, interval: 40 },
  );
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** The error a read, a subscription or a prompt answers with: a JSON-RPC error, as the SDK's client throws it. */
export async function refused(call: Promise<unknown>): Promise<McpError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof McpError) return err;
    throw err;
  }
  throw new Error('an McpError was expected');
}

/** The text of a read's first part: the tool's words, with what a session wrote inside its fence. */
export const textOf = (result: ReadResourceResult): string => {
  const [first] = result.contents;
  return 'text' in first ? first.text : '';
};
