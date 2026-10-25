/**
 * mcpStore — what this window knows about central sessions (server/mcp): which centrals are running, so
 * the Central picker can grey out a scope that already has one; whether this window may start one at all;
 * and whether a dashboard password is set, because without one a central can also reach /api directly.
 *
 * The server is the source (`server/mcp/http.ts`): the list is read from GET /api/mcp/centrals whenever the
 * socket (re)connects, and followed through `centrals_update`, the whole list after every change, which
 * the server sends to this Mac's own windows only. A row names no token and holds nothing but the public
 * fields: whatever else arrives with one is dropped here, so a window can never keep a secret it was
 * not meant to have.
 *
 * `available` is the answer to "may this window start a central?": true once the list was read or pushed,
 * false when the server says it is not here (404: another device, a phone, or the feature switched off in
 * `server-config.json`), null until the first answer. Any other answer that is not a list (a refusal of a
 * sign-in or a rate limit, 401/403/429; a server that fails, 5xx; one that cannot be reached) says nothing,
 * so the store keeps what it knew, as `loadTasks` does: the picker is a convenience, never a reason to show
 * an error, and a passing refusal must not hide every worker badge until the next list.
 *
 * `revision` counts the lists applied. A read that was in flight while a newer list arrived over the
 * socket is thrown away, so a late answer can never put an old list over a new one.
 *
 * Beside the centrals the store holds what they do (P2), both from the same server, both for this Mac's
 * windows only:
 *   - `tasks`, by task id: the tasks the centrals handed out. `mcp_task_update` changes one; GET /api/mcp/tasks
 *     (read when the socket connects) lists the open ones, so a window opened mid-task still has its worker
 *     badges, and a task that ended while the window was not listening does not stay "running" for ever. A 404
 *     from that read says the ledger is not here at all, so every open task held is dropped.
 *   - `activity`, newest first: the rows of the activity log, one at a time over `mcp_activity` and a page at a
 *     time from GET /api/mcp/activity (read when a central's panel opens). A row is held once, whichever way
 *     it came, and at most ACTIVITY_MAX rows are held for each central. When a list of centrals no longer holds
 *     a central, its rows go too: nothing else would ever prune them.
 * Reducers never change what they were given or held (a new Map or array each time). A row and a task keep only
 * their public fields, so a window can never hold a token, an answer or a prompt key it was not meant to have.
 *
 * Only the dashboard window follows any of this (useWebSocket): a pop-out gets no Hands off button, no ACTIVITY tab and
 * no worker badges, so it is given none of the lists, tasks or rows, and its `available` stays null.
 */
import { create } from 'zustand';
import type {
  CentralKind,
  CentralSummary,
  McpActivityDetail,
  McpActivityOutcome,
  McpActivityRow,
  McpRisk,
  McpTaskState,
  McpTaskView,
} from '@/types';

/** How AASC routed a task (`McpTaskView.route`, without the null). */
type McpTaskRoute = NonNullable<McpTaskView['route']>;

/** The most activity rows held for one central; the oldest of its rows go first. */
export const ACTIVITY_MAX = 500;
/** The most tasks held; the oldest that have ended go first, an open task never. */
export const TASKS_MAX = 200;
/** The rows one read of the log asks for. */
const ACTIVITY_READ_LIMIT = 200;
/** How often a read of the tasks starts over when a live change overtook it, before it gives up. */
const TASKS_READ_TRIES = 3;

interface McpState {
  /** The live centrals by id. Replaced, never edited in place. */
  centrals: Map<string, CentralSummary>;
  /** May this window start a central? null until known. */
  available: boolean | null;
  /** Is a dashboard password set? null until known: no warning is shown on a guess. */
  passwordEnabled: boolean | null;
  /** How many lists have been applied (see the module note). */
  revision: number;
  /** The tasks the centrals handed out, by task id. Replaced, never edited in place. */
  tasks: Map<string, McpTaskView>;
  /** The activity log's rows, newest first, at most ACTIVITY_MAX of each central. Replaced, never edited in place. */
  activity: McpActivityRow[];
  /** How many changes of `tasks` have been applied: a read of the tasks can tell a live change overtook it. */
  taskRevision: number;

  /** A list from the socket (`centrals_update`) or from a read: the whole list replaces what is held. */
  applyCentrals: (raw: unknown) => void;
  /** Read the list and the password setting. Never throws. */
  load: () => Promise<void>;

  /** One change of a task (`mcp_task_update`): the task is added, or replaces its older self. */
  applyTaskUpdate: (raw: unknown) => void;
  /** The tasks in flight, as the server lists them: they replace every open task held; ended ones stay. */
  applyTasks: (raw: unknown) => void;
  /**
   * Read the tasks in flight. Never throws; a failure or a refusal of a sign-in changes nothing, and a 404 (the
   * ledger is not here) drops every open task held.
   */
  loadTasks: () => Promise<void>;
  /** One new row of the activity log (`mcp_activity`). */
  applyActivityRow: (raw: unknown) => void;
  /** A page of rows (a read of the log): merged with the rows held. */
  applyActivityRows: (raw: unknown) => void;
  /**
   * Read a central's rows (every central's when none is named) into the store. Answers whether the server
   * gave a list; never throws.
   */
  loadActivity: (centralId?: string) => Promise<boolean>;
}

const KINDS: ReadonlySet<string> = new Set<CentralKind>(['global', 'room', 'project']);
const CLIS: ReadonlySet<string> = new Set(['claude', 'codex']);

/** A row's count of live own workers: a whole number from 0 up, and 0 when a server older than P4 sends none. */
const workerCountOf = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** One row of the wire format, or null when it is not one. Only the public fields are copied. */
function toRow(value: unknown): CentralSummary | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (typeof r.centralId !== 'string' || r.centralId === '') return null;
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
  if (r.scopeRef !== null && typeof r.scopeRef !== 'string') return null;
  if (typeof r.cli !== 'string' || !CLIS.has(r.cli)) return null;
  if (r.sessionId !== null && typeof r.sessionId !== 'string') return null;
  if (!Array.isArray(r.toolsets) || !r.toolsets.every((t) => typeof t === 'string')) return null;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null;
  return {
    centralId: r.centralId,
    kind: r.kind as CentralKind,
    scopeRef: r.scopeRef,
    cli: r.cli as CentralSummary['cli'],
    sessionId: r.sessionId,
    toolsets: [...(r.toolsets as string[])],
    createdAt: r.createdAt,
    workerCount: workerCountOf(r.workerCount),
  };
}

/**
 * The rows of a list read off the wire: the well-formed ones, and null when `raw` is no list at all (a
 * payload that is not one is ignored whole, so it cannot empty a list that was fine).
 */
export function parseCentralRows(raw: unknown): CentralSummary[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(toRow).filter((row): row is CentralSummary => row !== null);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_STATES: ReadonlySet<string> = new Set<McpTaskState>([
  'queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'failed', 'cancelled',
]);
const ROUTE_DECISIONS: ReadonlySet<string> = new Set<McpTaskRoute['decision']>(['reuse', 'create', 'handoff']);
const ENDED_STATES: ReadonlySet<string> = new Set<McpTaskState>(['done', 'failed', 'cancelled']);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string';
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNumberOrNull = (v: unknown): v is number | null => v === null || isFiniteNumber(v);

/** How AASC routed a task, or undefined when `value` is not a route (null stays null: the central named the session). */
function parseRoute(value: unknown): McpTaskRoute | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const r = value as Record<string, unknown>;
  if (r.by !== 'auto' || !isText(r.decision) || !ROUTE_DECISIONS.has(r.decision)) return undefined;
  if (!Array.isArray(r.reasons) || !r.reasons.every(isText)) return undefined;
  return { by: 'auto', decision: r.decision as McpTaskRoute['decision'], reasons: [...(r.reasons as string[])] };
}

/** One task of the wire format, or null when it is not one. Only the public fields are copied. */
export function parseTaskView(value: unknown): McpTaskView | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!isText(r.taskId) || r.taskId === '') return null;
  if (!isText(r.centralId) || r.centralId === '') return null;
  if (!isText(r.sessionId) || r.sessionId === '') return null;
  if (!isText(r.state) || !TASK_STATES.has(r.state)) return null;
  if (!isText(r.title)) return null;
  if (!isFiniteNumber(r.createdAt) || !isFiniteNumber(r.updatedAt)) return null;
  if (!isNumberOrNull(r.sentAt) || !isTextOrNull(r.error) || !isNumberOrNull(r.answerChars)) return null;
  // Only on a server from P4 on; one that is not well formed is left out and the task is kept.
  const route = parseRoute(r.route);
  return {
    taskId: r.taskId,
    centralId: r.centralId,
    sessionId: r.sessionId,
    state: r.state as McpTaskState,
    title: r.title,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    updatedAt: r.updatedAt,
    error: r.error,
    answerChars: r.answerChars,
    ...(typeof r.answerTruncated === 'boolean' ? { answerTruncated: r.answerTruncated } : {}),
    ...(route !== undefined ? { route } : {}),
    ...(isTextOrNull(r.retargetedFrom) ? { retargetedFrom: r.retargetedFrom } : {}),
  };
}

/** Has the task not ended yet (it still holds its worker)? */
export function isOpenTask(task: Pick<McpTaskView, 'state'>): boolean {
  return !ENDED_STATES.has(task.state);
}

/**
 * The open task of a session: its worker badge's subject. A session holds one at a time (the ledger's lock), so
 * a second is a stale one beside the live one; the latest change wins. Answers the object the Map holds, so a
 * selector may return it as it is.
 */
export function openTaskFor(
  tasks: ReadonlyMap<string, McpTaskView>,
  sessionId: string,
): McpTaskView | undefined {
  let found: McpTaskView | undefined;
  for (const task of tasks.values()) {
    if (task.sessionId !== sessionId || !isOpenTask(task)) continue;
    if (found === undefined || task.updatedAt > found.updatedAt) found = task;
  }
  return found;
}

/**
 * Over TASKS_MAX, the oldest tasks that have ended go; an open one never does. Edits (and answers) `tasks`,
 * which is the caller's own new Map.
 */
function trimTasks(tasks: Map<string, McpTaskView>): Map<string, McpTaskView> {
  let excess = tasks.size - TASKS_MAX;
  if (excess <= 0) return tasks;
  const ended = [...tasks.values()].filter((t) => !isOpenTask(t)).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const task of ended) {
    if (excess <= 0) break;
    tasks.delete(task.taskId);
    excess -= 1;
  }
  return tasks;
}

/** The well-formed entries of a list read off the wire; null when `raw` is no list at all. */
function parseList<T>(raw: unknown, parse: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map(parse).filter((item): item is T => item !== null);
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const RISKS: ReadonlySet<string> = new Set<McpRisk>(['read', 'write', 'steers', 'ask', 'destructive', 'outward']);
const OUTCOMES: ReadonlySet<string> = new Set<McpActivityOutcome>([
  'ok', 'refused', 'failed', 'queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'cancelled',
]);

/** A detail's flat values (what is nested or not plain is dropped): null when there is none, undefined when `value` is no detail. */
function parseDetail(value: unknown): McpActivityDetail | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: McpActivityDetail = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean' || v === null || isFiniteNumber(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One row of the activity log in the wire format, or null when it is not one. Only the public fields are copied. */
export function parseActivityRow(value: unknown): McpActivityRow | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!isFiniteNumber(r.id) || !isFiniteNumber(r.at)) return null;
  if (!isText(r.centralId) || r.centralId === '') return null;
  if (!isTextOrNull(r.centralSessionId) || !isTextOrNull(r.targetSessionId) || !isTextOrNull(r.taskId)) return null;
  if (!isText(r.tool) || !isText(r.summary)) return null;
  if (!isText(r.risk) || !RISKS.has(r.risk)) return null;
  if (!isText(r.outcome) || !OUTCOMES.has(r.outcome)) return null;
  const detail = parseDetail(r.detail);
  if (detail === undefined) return null;
  return {
    id: r.id,
    at: r.at,
    centralId: r.centralId,
    centralSessionId: r.centralSessionId,
    tool: r.tool,
    risk: r.risk as McpRisk,
    targetSessionId: r.targetSessionId,
    taskId: r.taskId,
    summary: r.summary,
    outcome: r.outcome as McpActivityOutcome,
    detail,
  };
}

/** The rows of the centrals in `centrals` only; the same array when none is of a central that has gone. */
function withoutGoneCentrals(
  activity: McpActivityRow[],
  centrals: ReadonlyMap<string, CentralSummary>,
): McpActivityRow[] {
  return activity.every((row) => centrals.has(row.centralId))
    ? activity
    : activity.filter((row) => centrals.has(row.centralId));
}

/**
 * The rows held and the rows that came, each id once (the one held stays: a row never changes), newest first, and at
 * most ACTIVITY_MAX of each central. The cap is per central because the store holds every central's rows and a panel
 * shows only its own: under one cap for all, a busy central would push a quiet one's rows out, and the quiet one's
 * panel would say "No activity yet" with its log full.
 */
function mergeActivity(held: readonly McpActivityRow[], incoming: readonly McpActivityRow[]): McpActivityRow[] {
  const byId = new Map<number, McpActivityRow>(held.map((row) => [row.id, row]));
  for (const row of incoming) if (!byId.has(row.id)) byId.set(row.id, row);
  const keptOf = new Map<string, number>();
  return [...byId.values()]
    .sort((a, b) => b.id - a.id)
    .filter((row) => {
      const kept = (keptOf.get(row.centralId) ?? 0) + 1;
      keptOf.set(row.centralId, kept);
      return kept <= ACTIVITY_MAX;
    });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** What reading the list came to: its rows, a refusal, or nothing known (the server failed or was unreachable). */
type CentralsRead = { available: true; rows: CentralSummary[] } | { available: false } | null;

async function readCentrals(): Promise<CentralsRead> {
  try {
    const res = await fetch('/api/mcp/centrals');
    // 404 says central sessions are not here; any other refusal or failure says nothing (see the module note).
    if (res.status === 404) return { available: false };
    if (!res.ok) return null;
    const body = (await res.json()) as { centrals?: unknown };
    const rows = parseCentralRows(body.centrals);
    return rows === null ? null : { available: true, rows };
  } catch {
    return null;
  }
}

async function readPasswordEnabled(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/auth/status');
    if (!res.ok) return null;
    const body = (await res.json()) as { passwordRequired?: unknown };
    return typeof body.passwordRequired === 'boolean' ? body.passwordRequired : null;
  } catch {
    return null;
  }
}

/**
 * What reading the tasks came to: the open ones the server lists; "gone" for a 404, which says the ledger that held
 * them is not here (central sessions are off, or this is a device that may not see them); or nothing known for a
 * refusal of a sign-in, a failure, or an answer with no list.
 */
type TasksRead = { kind: 'list'; tasks: unknown[] } | { kind: 'gone' } | null;

async function readTasks(): Promise<TasksRead> {
  try {
    const res = await fetch('/api/mcp/tasks');
    if (res.status === 404) return { kind: 'gone' };
    if (!res.ok) return null;
    const body = (await res.json()) as { tasks?: unknown };
    return Array.isArray(body.tasks) ? { kind: 'list', tasks: body.tasks } : null;
  } catch {
    return null;
  }
}

/** The rows the server lists, or null for a refusal, a failure or an answer with no list. */
async function readActivity(centralId?: string): Promise<unknown[] | null> {
  const central = centralId ? `&central=${encodeURIComponent(centralId)}` : '';
  try {
    const res = await fetch(`/api/mcp/activity?limit=${ACTIVITY_READ_LIMIT}${central}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { rows?: unknown };
    return Array.isArray(body.rows) ? body.rows : null;
  } catch {
    return null;
  }
}

export const useMcpStore = create<McpState>((set, get) => ({
  centrals: new Map(),
  available: null,
  passwordEnabled: null,
  revision: 0,
  tasks: new Map(),
  activity: [],
  taskRevision: 0,

  applyCentrals: (raw) => {
    const rows = parseCentralRows(raw);
    if (rows === null) return;
    // A list that reached this window over the socket came from a server that sends it to this Mac only.
    set((s) => {
      const centrals = new Map(rows.map((row) => [row.centralId, row]));
      return {
        centrals,
        available: true,
        revision: s.revision + 1,
        activity: withoutGoneCentrals(s.activity, centrals),
      };
    });
  },

  load: async () => {
    const startedAt = get().revision;
    const [read, passwordEnabled] = await Promise.all([readCentrals(), readPasswordEnabled()]);
    if (passwordEnabled !== null) set({ passwordEnabled });
    if (read === null || get().revision !== startedAt) return;
    if (read.available) {
      set((s) => {
        const centrals = new Map(read.rows.map((row) => [row.centralId, row]));
        return {
          centrals,
          available: true,
          revision: s.revision + 1,
          activity: withoutGoneCentrals(s.activity, centrals),
        };
      });
    } else {
      set((s) => ({ centrals: new Map(), available: false, revision: s.revision + 1, activity: [] }));
    }
  },

  applyTaskUpdate: (raw) => {
    const incoming = parseTaskView(raw);
    if (incoming === null) return;
    set((s) => {
      const held = s.tasks.get(incoming.taskId);
      // The feed may deliver a change after a newer one: the older never undoes the newer.
      if (held !== undefined && held.updatedAt > incoming.updatedAt) return s;
      const next = new Map(s.tasks);
      next.set(incoming.taskId, incoming);
      return { tasks: trimTasks(next), taskRevision: s.taskRevision + 1 };
    });
  },

  applyTasks: (raw) => {
    const list = parseList(raw, parseTaskView);
    if (list === null) return;
    set((s) => {
      // The list holds open tasks only: a task held and ended stays; one held and open but not listed has ended
      // since (or the server restarted); a listed one is taken unless the one held is newer.
      const next = new Map<string, McpTaskView>();
      for (const task of s.tasks.values()) if (!isOpenTask(task)) next.set(task.taskId, task);
      for (const incoming of list) {
        const held = s.tasks.get(incoming.taskId);
        next.set(incoming.taskId, held !== undefined && held.updatedAt > incoming.updatedAt ? held : incoming);
      }
      return { tasks: trimTasks(next), taskRevision: s.taskRevision + 1 };
    });
  },

  loadTasks: async () => {
    let overtaken: { tasks: unknown[]; changedMeanwhile: McpTaskView[] } | null = null;
    for (let attempt = 0; attempt < TASKS_READ_TRIES; attempt += 1) {
      const startedAt = get().taskRevision;
      const heldAtStart = get().tasks;
      const read = await readTasks();
      if (read === null) return;
      // The ledger is not here, so no task held can still be running: drop the open ones (ended ones stay, as for
      // any list). There is no list to wait for, so a live change that landed meanwhile does not matter.
      if (read.kind === 'gone') {
        get().applyTasks([]);
        return;
      }
      if (get().taskRevision !== startedAt) {
        // A live change that landed while the read was in flight may be newer than the list: read again. The open
        // tasks it brought or moved are kept aside (a Map entry is replaced, never edited, so a different object is
        // a change) in case this was the last try.
        const changedMeanwhile = [...get().tasks.values()].filter((t) => isOpenTask(t) && heldAtStart.get(t.taskId) !== t);
        overtaken = { tasks: read.tasks, changedMeanwhile };
        continue;
      }
      get().applyTasks(read.tasks);
      return;
    }
    // Changes kept arriving, so every read was overtaken. Leaving the window as it was would keep a task that ended
    // while it was away "running" until the next reconnect: the last list is applied. What a live change brought
    // during that read may be newer than the list, which could not know it, so it goes in too: first, so that where
    // both name a task the newer of the two wins (applyTasks takes a later entry unless the one held is newer).
    if (overtaken !== null) get().applyTasks([...overtaken.changedMeanwhile, ...overtaken.tasks]);
  },

  applyActivityRow: (raw) => {
    const row = parseActivityRow(raw);
    if (row === null) return;
    set((s) => ({ activity: mergeActivity(s.activity, [row]) }));
  },

  applyActivityRows: (raw) => {
    const rows = parseList(raw, parseActivityRow);
    if (rows === null) return;
    set((s) => ({ activity: mergeActivity(s.activity, rows) }));
  },

  loadActivity: async (centralId) => {
    const read = await readActivity(centralId);
    if (read === null) return false;
    get().applyActivityRows(read);
    return true;
  },
}));
