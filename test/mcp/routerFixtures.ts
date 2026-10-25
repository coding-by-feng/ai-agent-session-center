// test/mcp/routerFixtures.ts — what the router tests (router*.test.ts) share: a fake home with a few projects, sessions
// that are workers in them, the routes the router reads, and dependencies that never touch the disk.
import { basename } from 'node:path';
import type { Session } from '../../src/types/session.js';
import type { KnownProject } from '../../server/mcp/projectIndex.js';
import type { ResolveEnv } from '../../server/mcp/resolveProject.js';
import { routerSettings } from '../../server/mcp/routerConfig.js';
import { route, type RouteDeps, type RouteInput, type RouteResult } from '../../server/mcp/router.js';
import { ToolError, type CentralRecord } from '../../server/mcp/types.js';
import { envelope, makeCentral, makeCtx, makeSession, NOW, ok, type Answer, type CtxOptions } from './toolHarness.js';

export const HOME = '/home/tester';
export const AGENT = `${HOME}/code/agent-manager`;
export const SITE = `${HOME}/code/site`;
export const RANGI = `${HOME}/code/rangi-site`;
export const MIN = 60_000;

/** A project the index knows: live, last active 5 minutes ago, in no room (the named fields changed). */
export function project(folder: string, over: Partial<KnownProject> = {}): KnownProject {
  return { folder, name: basename(folder), sources: ['live'], lastActiveAt: NOW - 5 * MIN, roomIds: [], ...over };
}

/** A global central's resolve environment over a fake home, where every folder exists and nothing is a link. */
export function resolveEnv(over: Partial<ResolveEnv> = {}): ResolveEnv {
  return {
    central: { kind: 'global', scopeRef: null },
    home: HOME,
    known: [],
    exists: () => true,
    realpath: (p) => p,
    ...over,
  };
}

/**
 * A claude worker in `folder`: idle, with a terminal, last active 90 minutes ago and with no context reading, so by
 * default it earns only the same-folder and idle terms (score 5 in its own folder).
 */
export function worker(id: string, folder: string, over: Partial<Session> = {}): Session {
  return makeSession(id, {
    projectPath: folder,
    projectName: basename(folder),
    terminalId: `t-${id}`,
    cliSource: 'claude',
    status: 'idle',
    lastActivityAt: NOW - 90 * MIN,
    ...over,
  });
}

/** The context reading a status-line tap gives a Claude card. */
export const withContext = (pct: number): Partial<Session> => ({ runtime: { context: { pct } } });

/** Routes that answer the router's reads with nothing; a test overrides the ones it cares about. */
export function emptyRoutes(over: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    'GET /resources': envelope({ state: 'ready', projects: [] }),
    'GET /db/projects': ok([]),
    'GET /db/sessions': ok({ sessions: [], total: 0, page: 1, pageSize: 1 }),
    'GET /known-projects': ok({ paths: [] }),
    ...over,
  };
}

/** Dependencies for `route`: the spec's settings, a fake home, every folder present, no links, no known roots. */
export function routeDeps(over: Partial<RouteDeps> = {}): RouteDeps {
  return {
    settings: routerSettings(undefined),
    home: HOME,
    exists: () => true,
    realpath: (p) => p,
    known: async () => [],
    ...over,
  };
}

/** The ids of a candidate list, in order. */
export const idsOf = (candidates: ReadonlyArray<{ sessionId: string }>): string[] => candidates.map((c) => c.sessionId);

// ---------------------------------------------------------------------------
// Routing a task
// ---------------------------------------------------------------------------

/** A task that names agent-manager, whose significant words are flaky, queue and test. */
export const TASK = 'fix the flaky queue test in agent manager';

/** Session ids whose first eight characters differ, so each has a short id of its own. */
export const A = 'sess-aaa1';
export const B = 'sess-bbb2';
export const C = 'sess-ccc3';

/** The history DB knows both projects, so a task can name one that has no live session. */
export const HISTORY = ok([
  { project_path: AGENT, project_name: 'agent-manager' },
  { project_path: SITE, project_name: 'site' },
]);
export const ROUTES = emptyRoutes({ 'GET /db/projects': HISTORY });

/** The global central the router tests run as unless they say otherwise. */
export const GLOBAL = makeCentral('global', null, { centralId: 'global-1', terminalId: 'term-global' });

/** Routes a task as the context's central, with the fake home and no disk. */
export function go(opts: CtxOptions, input: { task?: string; [k: string]: unknown } = {}, deps = routeDeps()) {
  const h = makeCtx({ routes: ROUTES, ...opts });
  const result = route(h.ctx, { task: TASK, ...input } as RouteInput, deps);
  return { ...h, result };
}

export const reuseOf = (r: RouteResult): string => {
  if (r.decision.kind !== 'reuse') throw new Error(`expected a reuse, got ${r.decision.kind}`);
  return r.decision.sessionId;
};

/** The ToolError a route throws. */
export async function refused(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('the route answered; a ToolError was expected');
}

/** A live central of `kind` and its card, as a global central's context holds them. */
export function childCentral(kind: 'project' | 'room', scopeRef: string, centralId: string, over: Partial<Session> = {}) {
  const record: CentralRecord = makeCentral(kind, scopeRef, { centralId, terminalId: `term-${centralId}` });
  const card = makeSession(`card-${centralId}`, {
    projectPath: kind === 'project' ? scopeRef : AGENT,
    terminalId: `term-${centralId}`,
    cliSource: 'claude',
    status: 'working',
    central: { centralId, kind, scopeRef },
    ...over,
  });
  return { record, card };
}
