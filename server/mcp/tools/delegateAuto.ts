// tools/delegateAuto.ts — `task_delegate(to: "auto")` (tools/tasks.ts hands it over): AASC picks where the task goes
// and carries it out. On only when `mcp.autoRouting` is true (Ruling P4-10: the replay check measured 41.9 %).
//
//   route    router.ts, as the calling central (its scope, the project, the eligible sessions, the scores)
//   reuse    a task on the session it picked (ledger.create: BUSY if another central took it meanwhile)
//   create   a worker of the central's own (openWorker.ts), the task recorded at once and typed once it has started
//            (Ruling P4-6); a worker the task then cannot go to is closed again, and the refusal names it (P4-28)
//   handoff  the task typed into the child central's own card, held to the policy's hand-off rails (Ruling P4-8)
//
// One task id end to end: the ledger keeps the route (`by: 'auto'`), and what the central asked of it is kept for the
// re-router (rerouter.ts, Ruling P4-7). The answer carries the decision, the project and its confidence, the reasons
// and the runners-up in `data` (Ruling 66); the activity row explains the decision in AASC's words and ids only.

import type { Session } from '../../../src/types/session.js';
import type { ActivityNote } from '../activity.js';
import { rememberRouteAsk, routeRecord, withClosedWorker, workerFor, type RouteAsk } from '../autoRoute.js';
import { resolveCentralSession } from '../centrals.js';
import { openedWorkerNote, type OpenedWorker } from '../openWorker.js';
import { assertNotShellLine } from '../policy.js';
import type { ToolContext, ToolResult } from '../registry.js';
import { explain, route, type RouteResult } from '../router.js';
import { autoRoutingEnabled } from '../routerConfig.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { openWorkerDepsFor, routeDepsFor } from '../workerDeps.js';
import { refOf } from './define.js';
import { NAME_THE_PROJECT, routeView } from './routing.js';

export const AUTO_OFF = 'auto routing is off in this AASC';
export const AUTO_OFF_HINT =
  'Set mcp.autoRouting to true in server-config.json and restart AASC; until then, task_route shows the best sessions and you delegate by id.';

export interface AutoArgs extends RouteAsk {
  task: string;
  answerFormat?: string;
}

/** The session the task goes into for a handoff: the child central's own card, after the hand-off rails. */
function handoffSession(ctx: ToolContext, centralId: string): Session {
  const child = ctx.centrals().find((c) => c.centralId === centralId);
  const card = child === undefined ? null : resolveCentralSession(centralId, ctx.sessions());
  if (child === undefined || card === null) {
    throw new ToolError('UNAVAILABLE', 'The central AASC would hand the task to is no longer live.', 'Call task_delegate again.');
  }
  ctx.mayDrive(card, { handOffTo: child });
  return card;
}

/** The worker a create opened, as `data` carries it (as session_create's does); null for a reuse or a hand-off. */
function openedView(w: OpenedWorker | null) {
  if (w === null) return null;
  return { sessionId: w.sessionId, terminalId: w.terminalId, shortId: shortIdOf(w.sessionId), roomId: w.roomId, filed: w.filed, note: w.note };
}

/** The decision as an activity note: AASC's words and ids (the explanation), the decision and the confidence. */
function routedNote(result: RouteResult, taskId: string, sessionId: string, chars: number): ActivityNote {
  return {
    summary: explain(result),
    targetSessionId: sessionId,
    taskId,
    detail: { decision: result.decision.kind, confidence: result.confidence, runnersUp: result.runnersUp.length, chars },
  };
}

/** task_delegate to "auto": refuses UNAVAILABLE while auto routing is off, else routes and carries out the decision. */
export async function delegateAuto(ctx: ToolContext, args: AutoArgs): Promise<ToolResult> {
  if (!autoRoutingEnabled()) throw new ToolError('UNAVAILABLE', AUTO_OFF, AUTO_OFF_HINT);
  if (args.task.trim() === '') throw new ToolError('INVALID', 'A task needs some text.', 'Say what the session should do.');
  assertNotShellLine(args.task);
  const ask: RouteAsk = {
    ...(args.cli === undefined ? {} : { cli: args.cli }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.newOnly === undefined ? {} : { newOnly: args.newOnly }),
  };
  const result = await route(ctx, { task: args.task, ...ask }, routeDepsFor(ctx));
  const { decision } = result;
  const target = decision.kind === 'handoff' ? { session: handoffSession(ctx, decision.centralId), opened: null } : await workerFor(ctx, decision, openWorkerDepsFor(ctx));

  let t: ReturnType<ToolContext['ledger']['create']>;
  try {
    t = ctx.ledger.create({
      central: ctx.central,
      session: target.session,
      task: args.task,
      route: routeRecord(result),
      ...(args.answerFormat === undefined ? {} : { answerFormat: args.answerFormat }),
    });
  } catch (err) {
    throw target.opened === null ? err : await withClosedWorker(ctx, target.opened, err);
  }
  rememberRouteAsk(t.taskId, ask);

  const view = routeView(result);
  const notes = [...(target.opened ? [openedWorkerNote(target.opened)] : []), routedNote(result, t.taskId, t.sessionId, args.task.length)];
  const task = { ref: 'auto', sessionId: t.sessionId, shortId: shortIdOf(t.sessionId), taskId: t.taskId, state: t.state, code: null, error: null, hint: null };
  const where = decision.kind === 'handoff' ? `central #${shortIdOf(decision.centralId)}` : refOf(ctx)(t.sessionId);
  const wait = target.opened ? ' It waits for the new session to start, then AASC types it in.' : '';
  const guess = view.lowConfidence ? ` ${NAME_THE_PROJECT}` : '';
  return {
    data: { requested: 1, started: 1, tasks: [task], route: view, opened: openedView(target.opened) },
    summary:
      `Task ${t.taskId} handed to ${where}: AASC ${view.explanation}.${wait}${guess}` +
      ` Call task_wait with ids ${JSON.stringify([t.taskId])} for the answer.`,
    activity: notes,
  };
}
