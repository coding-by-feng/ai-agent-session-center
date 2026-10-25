// http.ts — what the dashboard asks of the central-session runtime, and what it is told:
//
//   GET /api/mcp/centrals               which centrals are running (the Central picker greys out a scope that already
//                                       has one; the badges on the cards name the room a room central serves)
//   GET /api/mcp/activity?central=&limit=   the activity log, newest first (the central's ACTIVITY panel)
//   GET /api/mcp/tasks                  the tasks in flight, for the worker badges of a window that was opened late
//   PUT /api/mcp/sessions/:id/hands-off the person's switch: no central may type into, task or queue for this session
//   GET /api/mcp/confirms, POST /api/mcp/confirm/:cardId   the confirmations a tool asked the person (confirmRoutes.ts)
//
// and five feeds to this Mac's windows: `centrals_update` (the whole list, after every registry change and every
// change of a central's own workers, whose count the badge shows),
// `mcp_activity` (each new row of the activity log), `mcp_task_update` (each change of a task's state), and
// `mcp_confirm` / `mcp_confirm_resolved` (a card to show, and its answer). A central that leaves the registry has its
// pending confirmations denied.
// All of it is mounted at `/api` behind authMiddleware, ahead of apiRouter.
//
// A row is built field by field (`centralSummaries`, `activityView`, `taskView`), never by spreading a record: a
// central's record holds the bearer token, and a token must not leave the server. What a row does hold is ids,
// kinds, codes and AASC's own words. That is still more than a remote device may know (it names sessions, and a
// central itself is something only this Mac starts and sees), so every way out is for this Mac only:
//   - each route answers 404 to anyone else (`isLocalRequest`, the rule every local gate shares), and 404 with
//     central sessions switched off (`mcp.enabled: false`), which is how the picker learns to hide;
//   - after that gate, each route answers 403 to one of a central's own calls (its presence id is `mcp:<centralId>`):
//     a central must not lift the rail that holds it (the PUT), nor read the list, the log or the tasks (the GETs),
//     which name every central's targets and task titles, sessions beyond its own scope;
//   - each feed goes through `broadcastByLocality(message, null)`: this Mac's windows get it, every remote device
//     gets nothing. The `null` is passed here, not by the caller, so the one rule is in one place.
//
// What is passed in (the registry, the sessions, the runtime, the store, the broadcast) keeps the module free of
// the running server.

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CentralSummary } from '../../src/types/central.js';
import {
  MCP_ACTIVITY,
  MCP_TASK_UPDATE,
  type McpActivityMessage,
  type McpActivityRow,
  type McpTaskUpdateMessage,
  type McpTaskView,
} from '../../src/types/mcpEvents.js';
import type { Session } from '../../src/types/session.js';
import { WS_TYPES } from '../constants.js';
import log from '../logger.js';
import { isLocalRequest } from '../requestLocality.js';
import { scrubDetail, scrubText, type ActivityLog } from './activity.js';
import { resolveCentralSession, type CentralRegistry } from './centrals.js';
import { confirms as serverConfirms, type ConfirmBook } from './confirm.js';
import { mountConfirmRoutes, type ConfirmFeedMessage } from './confirmRoutes.js';
import { toTaskView, type DeliverRuntime } from './deliver.js';
import type { Ledger, TaskState } from './ledger.js';
import { MCP_CLIENT_PREFIX } from './policy.js';
import { isMcpEnabled } from './runtime.js';
import { workers as serverWorkers, type WorkerRegistry } from './workers.js';

/** What the centrals feed sends: the whole list of live centrals, as GET answers it. */
export interface CentralsUpdateMessage {
  type: typeof WS_TYPES.CENTRALS_UPDATE;
  centrals: CentralSummary[];
}

/** Everything the router sends to this Mac's windows. */
export type CentralsFeedMessage = CentralsUpdateMessage | McpActivityMessage | McpTaskUpdateMessage | ConfirmFeedMessage;

/** What the dashboard reads of P2's runtime (deliver.ts): the activity log, the tasks, the feed of task changes. */
export interface DashboardDeliver {
  activity: Pick<ActivityLog, 'listActivity' | 'onActivity'>;
  onTaskUpdate: DeliverRuntime['onTaskUpdate'];
  ledger: Pick<Ledger, 'list'>;
}

export interface CentralsRouterDeps {
  /** The registry the server runs on: read for the rows, listened to for the feed. */
  registry: Pick<CentralRegistry, 'list' | 'onChange'>;
  /** Every session card, to find the one each central runs in. */
  sessions: () => readonly Session[];
  /**
   * wsManager's `broadcastByLocality`: the message for this Mac's windows, and for every remote device
   * `null`, so they get nothing. The feeds always pass `null` as the second argument.
   */
  broadcastByLocality: (local: CentralsFeedMessage, remote: null) => void;
  /** Is this request the Mac itself? Defaults to `isLocalRequest`. */
  isLocal?: (req: Request) => boolean;
  /** Is the feature on? Defaults to `isMcpEnabled` (read at each request, like every other use). */
  enabled?: () => boolean;
  /**
   * P2's runtime (the activity log, the ledger). Without it the activity and tasks routes answer 404 and the
   * `mcp_activity` and `mcp_task_update` feeds stay silent: nothing records activity on such a server.
   */
  deliver?: DashboardDeliver;
  /**
   * sessionStore's `setSessionHandsOff`: sets or clears the flag, and answers the session, or null when there is
   * none. Without it the hands-off route answers 404.
   */
  setHandsOff?: (sessionId: string, on: boolean) => Session | null;
  /** The sessions centrals opened themselves (workers.ts), counted on each row; the server's registry by default. */
  workers?: CentralWorkers;
  /** The confirmations the person answers here (confirm.ts, confirmRoutes.ts); the server's book by default. */
  confirms?: ConfirmBook;
}

/** What the rows read of the workers registry: the count of each central's live own workers, and its changes. */
export type CentralWorkers = Pick<WorkerRegistry, 'liveCount' | 'onChange'>;

/** The router, plus the way to stop its feeds (a test, or a server that shuts down cleanly). */
export type CentralsRouter = Router & { close(): void };

/**
 * The rows of the live centrals, oldest first. Each is built from the fields named here and no others, so
 * a token can never be in one however the record grows, and each holds copies: nothing a caller does to a
 * row reaches the registry. `sessionId` is the card the central runs in as of now, null while it has none;
 * `workerCount` how many of the sessions it opened itself are live (P4: the badge's "3 workers").
 */
export function centralSummaries(
  registry: Pick<CentralRegistry, 'list'>,
  sessions: readonly Session[],
  workers: Pick<WorkerRegistry, 'liveCount'> = serverWorkers,
): CentralSummary[] {
  return registry.list().map((record) => ({
    centralId: record.centralId,
    kind: record.kind,
    scopeRef: record.scopeRef,
    cli: record.cli,
    sessionId: resolveCentralSession(record.centralId, sessions)?.sessionId ?? null,
    toolsets: [...record.toolsets],
    createdAt: record.createdAt,
    workerCount: workers.liveCount(record.centralId, sessions),
  }));
}

/** More than any row's own caps (activity.ts); this one only blanks token shapes and folds whitespace. */
const TEXT_MAX = 1_000;
/** A session id longer than this is no session id. */
const SESSION_ID_MAX = 200;
/** A central id in a query, as the log stores it. */
const CENTRAL_ID_MAX = 256;
/** The reasons of a task's route that leave the server: the router gives a handful, this is only a bound. */
const ROUTE_REASONS_MAX = 12;
/** A task in one of these states has ended: no badge is needed for it. */
const CLOSED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled']);

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const idOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? scrubText(value, CENTRAL_ID_MAX) : null);

/**
 * A row of the activity log as it may leave the server: built from its public fields and no others, every text
 * scrubbed again (a row is scrubbed on the way into the log; this is the second lock on the way out, so a token
 * cannot leave through a writer that forgot the first).
 */
export function activityView(row: McpActivityRow): McpActivityRow {
  return {
    id: row.id,
    at: row.at,
    centralId: scrubText(String(row.centralId), CENTRAL_ID_MAX),
    centralSessionId: idOrNull(row.centralSessionId),
    tool: scrubText(String(row.tool), 64),
    risk: row.risk,
    targetSessionId: idOrNull(row.targetSessionId),
    taskId: idOrNull(row.taskId),
    summary: scrubText(String(row.summary), TEXT_MAX),
    outcome: row.outcome,
    detail: scrubDetail(row.detail),
  };
}

/** A task view as it may leave the server: its public fields only, its words scrubbed again. */
export function taskView(task: McpTaskView): McpTaskView {
  return {
    taskId: scrubText(String(task.taskId), 64),
    centralId: scrubText(String(task.centralId), CENTRAL_ID_MAX),
    sessionId: scrubText(String(task.sessionId), CENTRAL_ID_MAX),
    state: task.state,
    title: scrubText(String(task.title), TEXT_MAX),
    createdAt: task.createdAt,
    sentAt: task.sentAt,
    updatedAt: task.updatedAt,
    error: task.error === null ? null : scrubText(String(task.error), TEXT_MAX),
    answerChars: task.answerChars,
    answerTruncated: task.answerTruncated === true,
    route:
      task.route === undefined || task.route === null
        ? null
        : {
            by: task.route.by,
            decision: task.route.decision,
            reasons: task.route.reasons.slice(0, ROUTE_REASONS_MAX).map((reason) => scrubText(String(reason), TEXT_MAX)),
          },
    retargetedFrom: task.retargetedFrom === undefined || task.retargetedFrom === null ? null : scrubText(String(task.retargetedFrom), CENTRAL_ID_MAX),
  };
}

/** The first value of a query parameter, or undefined. */
function queryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/** The `limit` of a query: a finite number (the log clamps it), or undefined for "not given" or not a number. */
function limitOf(value: unknown): number | undefined {
  const text = queryText(value);
  if (text === undefined || text.trim() === '') return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** The client id a request names (`x-aasc-client-id`), trimmed; '' when it names none. */
function clientIdOf(req: Request): string {
  const raw = req.headers['x-aasc-client-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value.trim() : '';
}

const handsOffBody = z.object({ on: z.boolean() });

/**
 * The router to mount at `/api` behind the auth middleware (see the module note for its routes). Creating it also
 * starts the feeds: after every registry change this Mac's windows are sent the whole list of centrals, and with a
 * P2 runtime every new activity row and task change. `close()` stops them (once, however often it is called).
 */
export function createCentralsRouter(deps: CentralsRouterDeps): CentralsRouter {
  const { registry, sessions, broadcastByLocality, deliver, setHandsOff } = deps;
  const isLocal = deps.isLocal ?? ((req: Request) => isLocalRequest(req));
  const enabled = deps.enabled ?? isMcpEnabled;
  const workers = deps.workers ?? serverWorkers;
  const confirms = deps.confirms ?? serverConfirms;

  const router = Router();

  /** The same 404 for "not the Mac" and "switched off": the caller learns nothing about which. */
  const mayAsk = (req: Request, res: Response): boolean => {
    if (enabled() && isLocal(req)) return true;
    res.status(404).json({ ok: false, error: 'Not found' });
    return false;
  };
  const gate = (req: Request, res: Response, next: NextFunction): void => {
    if (mayAsk(req, res)) next();
  };
  /**
   * A central's own tools call /api as `mcp:<centralId>`. What it must never read or change is refused to such a
   * call with this, behind the gate (a caller that is not this Mac has been told 404 and nothing else by then). `what`
   * is a fixed phrase, and the answer never echoes the client id.
   */
  const notForCentral =
    (what: string) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (clientIdOf(req).toLowerCase().startsWith(MCP_CLIENT_PREFIX)) {
        res.status(403).json({ ok: false, error: `A central cannot ${what}.` });
        return;
      }
      next();
    };

  router.get('/mcp/centrals', gate, notForCentral('read the list of centrals'), (_req, res) => {
    res.json({ ok: true, centrals: centralSummaries(registry, sessions(), workers) });
  });

  router.get('/mcp/activity', gate, notForCentral('read the activity log'), (req, res) => {
    if (!deliver) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const central = queryText(req.query.central)?.slice(0, CENTRAL_ID_MAX);
    const limit = limitOf(req.query.limit);
    try {
      const rows = deliver.activity
        .listActivity({
          ...(central ? { centralId: central } : {}),
          ...(limit === undefined ? {} : { limit }),
        })
        .map(activityView);
      res.json({ ok: true, rows });
    } catch (err) {
      log.warn('mcp', `Reading the activity log failed: ${describe(err)}`);
      res.status(500).json({ ok: false, error: 'Could not read the activity log' });
    }
  });

  router.get('/mcp/tasks', gate, notForCentral('read the tasks'), (_req, res) => {
    if (!deliver) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    try {
      const open = deliver.ledger.list().filter((task) => !CLOSED.has(task.state));
      res.json({ ok: true, tasks: open.map((task) => taskView(toTaskView(task))) });
    } catch (err) {
      log.warn('mcp', `Reading the tasks failed: ${describe(err)}`);
      res.status(500).json({ ok: false, error: 'Could not read the tasks' });
    }
  });

  // The body is read here so that a body that is not JSON gets this fixed answer, not Express's page; in the
  // running server the app's own parser has read it already and this is a no-op.
  const readJson = express.json({ limit: '1kb' });
  router.put(
    '/mcp/sessions/:id/hands-off',
    gate,
    // It never changes the rail that holds it: refused before the body is read.
    notForCentral('change hands-off'),
    (req: Request, res: Response, next: NextFunction) => {
      readJson(req, res, (err?: unknown) => {
        if (err !== undefined) {
          res.status(400).json({ ok: false, error: 'The body must be JSON: { "on": true } or { "on": false }.' });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
      const id = String(req.params.id ?? '');
      const body = handsOffBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: 'The body must be JSON: { "on": true } or { "on": false }.' });
        return;
      }
      if (!setHandsOff || id === '' || id.length > SESSION_ID_MAX) {
        res.status(404).json({ ok: false, error: setHandsOff ? 'Session not found' : 'Not found' });
        return;
      }
      try {
        const session = setHandsOff(id, body.data.on);
        if (session === null) {
          res.status(404).json({ ok: false, error: 'Session not found' });
          return;
        }
        res.json({ ok: true, handsOff: body.data.on });
      } catch (err) {
        log.warn('mcp', `Changing hands-off failed: ${describe(err)}`);
        res.status(500).json({ ok: false, error: 'Could not change hands-off' });
      }
    },
  );

  /** One message to this Mac's windows. A failing send is logged (no token), never thrown: it must not break a launch, a log write or a task. */
  const send = (build: () => CentralsFeedMessage, what: string): void => {
    try {
      broadcastByLocality(build(), null);
    } catch (err) {
      // A window that misses one refetches it when its socket reconnects.
      log.warn('mcp', `Could not send ${what} to the dashboard: ${describe(err)}`);
    }
  };

  const sendCentrals = (): void =>
    send(
      () => ({ type: WS_TYPES.CENTRALS_UPDATE, centrals: centralSummaries(registry, sessions(), workers) }),
      'the list of centrals',
    );
  // A central that left the registry (revoked, its terminal gone) can no longer carry out what it asked: its pending
  // confirmations are withdrawn (windows get them as denied, so their cards go; the activity row says withdrawn).
  // The registry is read only when something waits (the routes' tests count every read).
  const onRegistryChange = (): void => {
    const waiting = confirms.pending();
    if (waiting.length > 0) {
      const live = new Set(registry.list().map((c) => c.centralId));
      for (const id of new Set(waiting.map((r) => r.centralId))) if (!live.has(id)) confirms.forgetCentral(id);
    }
    sendCentrals();
  };
  const stops: Array<() => void> = [
    registry.onChange(onRegistryChange),
    workers.onChange(sendCentrals),
    mountConfirmRoutes(router, { confirms, gate, notForCentral, send }),
  ];
  if (deliver) {
    stops.push(
      deliver.activity.onActivity((row) =>
        send(() => ({ type: MCP_ACTIVITY, row: activityView(row) }), 'an activity row'),
      ),
      deliver.onTaskUpdate((task) =>
        send(() => ({ type: MCP_TASK_UPDATE, task: taskView(task) }), 'a task update'),
      ),
    );
  }

  let closed = false;
  return Object.assign(router, {
    close(): void {
      if (closed) return;
      closed = true;
      for (const stop of stops) stop();
    },
  });
}
