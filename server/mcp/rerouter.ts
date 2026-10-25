// rerouter.ts — a task AASC routed itself is routed again, once, when its worker dies mid-task (Ruling P4-7).
//
// It listens to the ledger. A task that failed because its terminal closed before its turn stopped, that AASC routed
// itself (`route.by: 'auto'`) and that was never re-routed (`isRetargetable`) is routed again as its central: the same
// task, what the central asked of the first route (autoRoute.ts), and the failed session left out — so a reuse or a
// new session, never a handoff (the router hands off only on a first, unconstrained pass). Then `ledger.retarget` moves
// it there under the same id, queued again, the same envelope typed in (once a new worker has started: Ruling P4-6).
//
// A refusal, an Esc, an answer, a session that ended between turns and a task the central named the session for are
// never re-routed; a second death stays failed (`retargetedFrom` is set). Both outcomes are logged as the central's
// own rows: the re-route with the router's explanation, or why it could not be (a code, AASC's words only). A worker
// opened for the re-route that then could not take the task is closed as its central (DELETE /sessions/:id, the
// clean-up's path), and the failure row names it (P4-28).

import log from '../logger.js';
import type { ActivityInput, ActivityLog } from './activity.js';
import { closeUnusedWorker, forgetRouteAsk, routeAskOf, workerFor } from './autoRoute.js';
import { isRetargetable, type Ledger, type TaskRecord } from './ledger.js';
import { openedWorkerNote, type OpenWorkerDeps } from './openWorker.js';
import type { ToolContext } from './registry.js';
import { explain, route, type RouteDeps } from './router.js';
import { shortIdOf } from './scope.js';
import { oneLine } from './tools/define.js';
import { ToolError } from './types.js';
import { openWorkerDepsFor, routeDepsFor } from './workerDeps.js';

export interface RerouterDeps {
  /** The server's whole ledger (every central's tasks). */
  ledger: Pick<Ledger, 'onChange'>;
  /** A context for a call by this central, as a tool call would get it; null when the central is no longer live. */
  contextOf(centralId: string): ToolContext | null;
  activity: Pick<ActivityLog, 'logActivity'>;
  /** The card a central runs in, for its rows; none by default. */
  centralSessionOf?(centralId: string): string | null;
  /** The router's and the opener's dependencies; the server's (workerDeps.ts) by default. */
  routeDeps?(ctx: ToolContext): RouteDeps;
  openDeps?(ctx: ToolContext): OpenWorkerDeps;
}

const ENDED: ReadonlySet<TaskRecord['state']> = new Set(['done', 'failed', 'cancelled']);
const SUMMARY_MAX = 300;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A re-route that failed after it opened a worker: the worker, and whether AASC closed it again. */
class OpenedThenFailed extends Error {
  constructor(
    readonly reason: unknown,
    readonly terminalId: string,
    readonly closed: boolean,
  ) {
    super(describe(reason));
  }
}

/** The failure row's words and detail: its code, and the worker it opened, closed or left open. */
function failureOf(t: TaskRecord, err: unknown): { summary: string; detail: Record<string, string | boolean> } {
  const opened = err instanceof OpenedThenFailed ? err : null;
  const reason = opened?.reason ?? err;
  const code = reason instanceof ToolError ? reason.code : 'UPSTREAM';
  if (opened === null) return { summary: `${t.taskId} not re-routed (${code})`, detail: { code } };
  const short = shortIdOf(opened.terminalId);
  const what = opened.closed ? `closed #${short} the session AASC opened for it` : `#${short}, the session AASC opened for it, is still open`;
  return {
    summary: `${t.taskId} not re-routed (${code}); ${what}`,
    detail: { code, openedSession: opened.terminalId, closed: opened.closed },
  };
}

/** Starts re-routing the ledger's tasks; returns the stop. */
export function startRerouter(deps: RerouterDeps): () => void {
  const inFlight = new Set<string>();
  const routeDeps = deps.routeDeps ?? routeDepsFor;
  const openDeps = deps.openDeps ?? openWorkerDepsFor;

  function write(t: TaskRecord, row: Pick<ActivityInput, 'targetSessionId' | 'summary' | 'outcome' | 'detail'>): void {
    try {
      deps.activity.logActivity({
        centralId: t.centralId,
        centralSessionId: deps.centralSessionOf?.(t.centralId) ?? null,
        tool: 'task_delegate',
        risk: 'steers',
        taskId: t.taskId,
        ...row,
        summary: oneLine(row.summary, SUMMARY_MAX),
      });
    } catch (err) {
      log.warn('mcp', `Logging the re-route of task ${t.taskId} failed: ${describe(err)}`);
    }
  }

  async function reroute(t: TaskRecord): Promise<void> {
    const ctx = deps.contextOf(t.centralId);
    if (ctx === null) throw new ToolError('UNAVAILABLE', 'Its central is no longer live.');
    const result = await route(ctx, { ...routeAskOf(t.taskId), task: t.task, exclude: [t.sessionId] }, routeDeps(ctx));
    const { decision } = result;
    if (decision.kind === 'handoff') throw new ToolError('INVALID', 'A re-route never hands a task off.');
    const target = await workerFor(ctx, decision, openDeps(ctx));
    if (target.opened) {
      const note = openedWorkerNote(target.opened);
      write(t, { targetSessionId: target.opened.terminalId, summary: note.summary, outcome: 'ok', detail: null });
    }
    let moved: TaskRecord;
    try {
      moved = ctx.ledger.retarget(t.taskId, t.centralId, target.session);
    } catch (err) {
      if (target.opened === null) throw err;
      throw new OpenedThenFailed(err, target.opened.terminalId, await closeUnusedWorker(ctx, target.opened));
    }
    write(t, {
      targetSessionId: moved.sessionId,
      summary: `re-routed ${t.taskId} from #${shortIdOf(t.sessionId)}: ${explain(result)}`,
      outcome: 'ok',
      detail: { decision: decision.kind, confidence: result.confidence },
    });
    log.info('mcp', `Task ${t.taskId} of central ${t.centralId} re-routed (${decision.kind})`);
  }

  const stop = deps.ledger.onChange((t) => {
    if (isRetargetable(t)) {
      if (inFlight.has(t.taskId)) return;
      inFlight.add(t.taskId);
      void reroute(t)
        .catch((err: unknown) => {
          const reason = err instanceof OpenedThenFailed ? err.reason : err;
          if (!(reason instanceof ToolError)) log.warn('mcp', `Re-routing task ${t.taskId} failed: ${describe(reason)}`);
          const { summary, detail } = failureOf(t, err);
          write(t, { targetSessionId: t.sessionId, summary, outcome: 'failed', detail });
          forgetRouteAsk(t.taskId);
        })
        .finally(() => inFlight.delete(t.taskId));
      return;
    }
    if (ENDED.has(t.state)) forgetRouteAsk(t.taskId);
  });
  return stop;
}
