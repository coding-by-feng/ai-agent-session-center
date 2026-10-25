// autoRoute.ts — carrying out a route (router.ts) for `task_delegate(to: "auto")` and for the re-router
// (rerouter.ts): the session a reuse or create decision puts the task in, the route record the ledger keeps, and what
// the central asked of the route, kept so a re-route asks the same (Ruling P4-7).
//
//   reuse   the session the router picked, as the central's scope holds it now
//   create  a new worker of the central's own (openWorker.ts), its card found by its terminal
//   handoff the task_delegate tool's alone (the policy's hand-off rails; a re-route never hands off)
//
// A worker opened for a task that then cannot be given it is closed again (Ruling P4-28): through DELETE
// /sessions/:id, as the idle clean-up closes one (cleanup.ts), or DELETE /terminals/:id when AASC shows no card for it.
// The refusal that follows names it (`withClosedWorker`).

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import { openWorker, type OpenedWorker, type OpenWorkerDeps } from './openWorker.js';
import { SteerRefusal } from './policy.js';
import type { ToolContext } from './registry.js';
import type { TaskRoute } from './ledgerTypes.js';
import type { RouteDecision, RouteInput, RouteResult } from './router.js';
import { shortIdOf } from './scope.js';
import { seg } from './tools/define.js';
import { ToolError } from './types.js';

/** What the central asked of a route besides the task (task_delegate's cli, project, model, newOnly). */
export type RouteAsk = Omit<RouteInput, 'task' | 'exclude'>;

/** The route a task keeps in the ledger: AASC's decision and its reasons. */
export const routeRecord = (result: RouteResult): TaskRoute => ({
  by: 'auto',
  decision: result.decision.kind,
  reasons: [...result.decision.reasons],
});

/** The card of a worker just opened (by its terminal); UPSTREAM when AASC does not hold it. */
export function newWorkerCard(ctx: Pick<ToolContext, 'sessions'>, w: OpenedWorker): Session {
  const card = ctx.sessions().find((s) => s.terminalId === w.terminalId && s.status !== 'ended');
  if (card === undefined) {
    throw new ToolError('UPSTREAM', 'AASC opened the session but does not show its card yet.', 'Call session_list in a moment.');
  }
  return card;
}

export interface RoutedWorker {
  session: Session;
  /** The worker opened for it; null for a reuse. */
  opened: OpenedWorker | null;
}

/** The session a reuse or create decision puts the task in; a create opens it (throwing openWorker's refusal). */
export async function workerFor(
  ctx: ToolContext,
  decision: Exclude<RouteDecision, { kind: 'handoff' }>,
  deps: OpenWorkerDeps,
): Promise<RoutedWorker> {
  if (decision.kind === 'reuse') {
    const session = ctx.scopedSessions().find((s) => s.sessionId === decision.sessionId);
    if (session === undefined) {
      throw new ToolError('NOT_FOUND', 'The session AASC picked is gone.', 'Call task_delegate again, or name a session.');
    }
    return { session, opened: null };
  }
  const opened = await openWorker(
    ctx,
    {
      cli: decision.cli,
      folder: decision.folder,
      title: decision.title,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.effort === undefined ? {} : { effort: decision.effort }),
      ...(decision.roomId === undefined ? {} : { roomId: decision.roomId }),
    },
    deps,
  );
  try {
    return { session: newWorkerCard(ctx, opened), opened };
  } catch (err) {
    throw await withClosedWorker(ctx, opened, err);
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Closes a worker opened for a task it was then not given: its card through DELETE /sessions/:id (as the idle
 * clean-up closes one), or, with no card shown, its terminal. True when AASC closed it; a failure is logged, never thrown.
 */
export async function closeUnusedWorker(ctx: Pick<ToolContext, 'client' | 'sessions'>, w: OpenedWorker): Promise<boolean> {
  const card = ctx.sessions().find((s) => s.terminalId === w.terminalId && s.status !== 'ended');
  const path = card === undefined ? `/terminals/${seg(w.terminalId)}` : `/sessions/${seg(card.sessionId)}`;
  try {
    const res = await ctx.client.del(path);
    if (res.ok) return true;
    log.warn('mcp', `Closing a worker no task went to failed (HTTP ${res.status})`);
  } catch (err) {
    log.warn('mcp', `Closing a worker no task went to failed: ${describe(err)}`);
  }
  return false;
}

/**
 * The refusal `err` after the worker `w` opened for it was closed (or not): the same code and hint, about that worker
 * (a SteerRefusal names its session, so the refusal's activity row does), and its words say what became of it.
 * Anything that is no ToolError is thrown as it is, once the worker is closed.
 */
export async function withClosedWorker(ctx: Pick<ToolContext, 'client' | 'sessions'>, w: OpenedWorker, err: unknown): Promise<unknown> {
  const closed = await closeUnusedWorker(ctx, w);
  if (!(err instanceof ToolError)) return err;
  const what = closed ? 'AASC closed the session it opened for it' : 'AASC could not close the session it opened for it';
  return new SteerRefusal(err.code, `${err.message} ${what} (#${shortIdOf(w.sessionId)}).`, err.hint ?? '', w.sessionId);
}

// ---------------------------------------------------------------------------
// What a re-route asks again
// ---------------------------------------------------------------------------

/** The most asks kept: a task's entry goes when it ends, so this only bounds a ledger that never ends its tasks. */
const ASKS_KEPT = 1_000;
const asks = new Map<string, RouteAsk>();

/** Keeps what the central asked of the route of `taskId`, for a re-route. */
export function rememberRouteAsk(taskId: string, ask: RouteAsk): void {
  asks.delete(taskId);
  asks.set(taskId, { ...ask });
  while (asks.size > ASKS_KEPT) {
    const oldest = asks.keys().next().value;
    if (oldest === undefined) break;
    asks.delete(oldest);
  }
}

/** What the central asked of the route of `taskId`; {} when nothing is kept. */
export const routeAskOf = (taskId: string): RouteAsk => ({ ...(asks.get(taskId) ?? {}) });

export function forgetRouteAsk(taskId: string): void {
  asks.delete(taskId);
}
