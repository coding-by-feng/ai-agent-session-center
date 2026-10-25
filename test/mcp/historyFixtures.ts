// test/mcp/historyFixtures.ts — what the history tool tests (tools.history, tools.historySearch) share: rows as the
// database answers them, a route that pages them as the server does, and the sessions, rooms and centrals that make
// the three history scopes (Ruling 32).
import type { InternalResponse } from '../../server/mcp/client.js';
import type { Answer, ApiCall } from './toolHarness.js';
import { makeCentral, makeRoom, makeSession, ok } from './toolHarness.js';

/** A route as the fake client takes it: the call in, the answer out. */
export type Route = (call: ApiCall) => InternalResponse<unknown>;

/** One `sessions` row as `GET /db/sessions` answers it. */
export const row = (id: string, projectPath: string, over: Record<string, unknown> = {}) => ({
  id, project_path: projectPath, project_name: projectPath.split('/').pop() ?? '', title: `Title of ${id}`, model: 'opus', status: 'ended',
  source: 'ssh', label: null, summary: null, remark: null, team_id: null, team_role: null, character_model: null, accent_color: null,
  started_at: 1_000, ended_at: 2_000, last_activity_at: 1_500, total_prompts: 3, total_tool_calls: 7, archived: 0, ...over,
});

/** A route that answers pages out of `rows` the way the server does: `page`, `pageSize` and the whole `total`. */
export function pagedRoute(key: string, rows: unknown[], seen: Array<Record<string, unknown>> = []): Answer {
  return (call) => {
    const query = call.query ?? {};
    seen.push({ ...query });
    const pageSize = Number(query.pageSize ?? 50);
    const page = Number(query.page ?? 1);
    return ok({ [key]: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize });
  };
}

export const pagedSessions = (rows: unknown[], seen: Array<Record<string, unknown>> = []): Answer => pagedRoute('sessions', rows, seen);

// ---------------------------------------------------------------------------
// The server's own routes, for the tests that need a filter, an order or a cap to behave as it does
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;
const numeric = (v: unknown): number => (typeof v === 'number' ? v : 0);
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Newest start first, the id breaking a tie: the `ORDER BY started_at DESC, id DESC` of `GET /db/sessions`. */
const newestSession = (a: Raw, b: Raw): number => numeric(b.started_at) - numeric(a.started_at) || before(textOf(b.id), textOf(a.id));
/** Newest prompt first, the id breaking a tie: the `ORDER BY p.timestamp DESC, p.id DESC` of `GET /db/prompts`. */
const newestPrompt = (a: Raw, b: Raw): number => numeric(b.timestamp) - numeric(a.timestamp) || numeric(b.id) - numeric(a.id);

const inRange = (when: unknown, query: Record<string, unknown>): boolean =>
  (query.dateFrom === undefined || numeric(when) >= Number(query.dateFrom)) && (query.dateTo === undefined || numeric(when) <= Number(query.dateTo));

function onePage(key: string, rows: Raw[], query: Record<string, unknown>): ReturnType<typeof ok> {
  const pageSize = Number(query.pageSize ?? 50);
  const page = Number(query.page ?? 1);
  return ok({ [key]: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize });
}

/**
 * `GET /db/sessions` as the server answers it over `rows`: the exact `project`, `status` and date filters; an archived
 * row only when the call says `archived=all`; newest start first; then one page and the `total` of everything that matched.
 */
export function serverSessions(rows: unknown[], seen: Array<Record<string, unknown>> = []): Route {
  return (call) => {
    const query = call.query ?? {};
    seen.push({ ...query });
    const matching = (rows as Raw[])
      .filter((r) => query.project === undefined || r.project_path === query.project)
      .filter((r) => query.status === undefined || r.status === query.status)
      .filter((r) => query.archived === 'all' || !r.archived)
      .filter((r) => inRange(r.started_at, query))
      .sort(newestSession);
    return onePage('sessions', matching, query);
  };
}

/**
 * `GET /db/prompts` as the server answers it: `kind=mine` leaves out the harness's turns (text that starts with `<`), the
 * exact `project` and `session` and the date filters, newest first, then one page and the `total` of what matched.
 */
export function serverPrompts(rows: unknown[], seen: Array<Record<string, unknown>> = []): Route {
  return (call) => {
    const query = call.query ?? {};
    seen.push({ ...query });
    const matching = (rows as Raw[])
      .filter((r) => query.kind !== 'mine' || !/^\s*</.test(textOf(r.text)))
      .filter((r) => query.project === undefined || r.project_path === query.project)
      .filter((r) => query.session === undefined || r.session_id === query.session)
      .filter((r) => inRange(r.timestamp, query))
      .sort(newestPrompt);
    return onePage('prompts', matching, query);
  };
}

/** `GET /db/projects`: each distinct folder (and name) of `rows` that has a folder, by name. */
export function serverProjects(rows: unknown[], seen: Array<Record<string, unknown>> = []): Route {
  return (call) => {
    seen.push({ ...(call.query ?? {}) });
    const distinct = new Map<string, Raw>();
    for (const r of rows as Raw[]) {
      const path = textOf(r.project_path);
      if (path !== '') distinct.set(`${path}\u0000${textOf(r.project_name)}`, { project_path: path, project_name: textOf(r.project_name) });
    }
    return ok([...distinct.values()].sort((a, b) => before(textOf(a.project_name), textOf(b.project_name))));
  };
}

// Sessions in the store: s1 and s2 run in /a/proj and /a/proj/sub (room r1); s3 runs elsewhere (room r2).
export const s1 = makeSession('s1', { projectPath: '/a/proj' });
export const s2 = makeSession('s2', { projectPath: '/a/proj/sub' });
export const s3 = makeSession('s3', { projectPath: '/b/other' });
export const sessions = [s1, s2, s3];
export const rooms = [makeRoom('r1', ['s1', 's2']), makeRoom('r2', ['s3'])];

// Ruling 36: sessions the store holds that share /a/proj with s1 (and its room r1) without being in that room's scope.
/** Live, in /a/proj, in no room: out of scope for room r1 although its folder passes the folder rule. */
export const liveOut = makeSession('live-out', { projectPath: '/a/proj' });
/** Ended, in /a/proj, in no room: the folder rule alone decides, and it allows /a/proj. */
export const endedIn = makeSession('ended-in', { projectPath: '/a/proj', status: 'ended', endedAt: 5 });
/** Live, in /a/proj/sub, but on another machine: no project central's scope, although its folder is inside /a/proj. */
export const liveRemote = makeSession('live-remote', { projectPath: '/a/proj/sub', sshHost: 'build.example.com' });

export const asGlobal = () => makeCentral('global');
/** Scope folder /a/proj: sees /a/proj and everything below it. */
export const asProject = () => makeCentral('project', '/a/proj');
/** Room r1: sees exactly the folders of s1 and s2. */
export const asRoom = () => makeCentral('room', 'r1');

/** Folders history rows may carry: inside the project, below one of its sessions, and not. */
export const FOLDERS = ['/a/proj', '/a/proj/sub', '/a/proj/deeper/x', '/a/other', '/a/project2', '/b/other', ''];
