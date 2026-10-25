// deliver.ts — the runtime P2's writes run on: the task ledger, the activity log, who drove each session last, the
// alias map that follows a re-keyed session id, and the ops-shell check. One per server (deliverWiring.ts builds the
// real one); the endpoint gets it as `McpDeps.deliver` and every call's context is built on it (callContext.ts).
//
// Without it a context still reads, but nothing writes: its ledger and `mayDrive` refuse UNAVAILABLE and runTool
// refuses every non-read tool, because a write the activity log cannot record must not happen at all.
//
// It also wires the ledger to the activity log (each change of a task's state is a row) and offers task changes as
// token-free views (`onTaskUpdate`), for the local-only `mcp_task_update` broadcast.

import type { McpTaskView } from '../../src/types/mcpEvents.js';
import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import { scrubText, type ActivityLog } from './activity.js';
import { resolveCentralSession } from './centrals.js';
import type { Ledger, TaskRecord, TaskState } from './ledger.js';
import type { SessionController } from './policy.js';
import { oneLine } from './tools/define.js';
import { ToolError } from './types.js';

export interface DeliverRuntime {
  ledger: Ledger;
  activity: ActivityLog;
  /** Who drove a session last (presenceManager.getController). */
  controller(sessionId: string): SessionController | null;
  /** A possibly stale session id to the current one (sessionStore.resolveSessionId); null when no session has it. */
  resolveSessionId(id: string): string | null;
  /** Is this terminal a session's ops shell (sshManager.isOpsTerminal)? */
  isOpsTerminal(terminalId: string): boolean;
  /** When a central last pressed Esc in the session or its terminal (escHold.ts), or null: the policy's Esc hold. */
  centralEscAt?(sessionId: string, terminalId: string | null): number | null;
  /** Every change of a task, as a view with no answer, prompt key or terminal. Returns the unsubscribe. */
  onTaskUpdate(listener: (task: McpTaskView) => void): () => void;
  /** Stops the activity log's prune timer and the ledger's wiring to it. */
  close(): void;
}

export interface DeliverParts {
  ledger: Ledger;
  activity: ActivityLog;
  controller(sessionId: string): SessionController | null;
  resolveSessionId(id: string): string | null;
  isOpsTerminal(terminalId: string): boolean;
  centralEscAt?(sessionId: string, terminalId: string | null): number | null;
  /** Every session now: finds a central's own card for the rows of its tasks. */
  sessions?: () => readonly Session[];
}

const TITLE_MAX = 120;
const FENCED = /^<untrusted [^>]*>([\s\S]*)<\/untrusted>$/;
const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A task as the `mcp_task_update` message carries it: what a badge needs, never the answer or the prompt key. How AASC
 * routed it and the session it was re-routed from are fields only (AASC's words and an id).
 */
export function toTaskView(t: TaskRecord): McpTaskView {
  const inner = t.answer === null ? null : (FENCED.exec(t.answer)?.[1] ?? t.answer);
  return {
    taskId: t.taskId,
    centralId: t.centralId,
    sessionId: t.sessionId,
    state: t.state,
    title: scrubText(oneLine(t.task, TITLE_MAX), TITLE_MAX),
    createdAt: t.createdAt,
    sentAt: t.sentAt,
    updatedAt: t.updatedAt,
    error: t.error,
    answerChars: inner === null ? null : inner.length,
    answerTruncated: t.answerTruncated,
    route: t.route ? { by: t.route.by, decision: t.route.decision, reasons: [...t.route.reasons] } : null,
    retargetedFrom: t.retargetedFrom ?? null,
  };
}

/** The activity row's words for a task's new state. AASC's words only: never the task or the answer. */
function transitionSummary(t: TaskRecord): string {
  const note = t.history.at(-1)?.note ?? '';
  return note === '' ? `${t.taskId} ${t.state}` : `${t.taskId} ${t.state}: ${note}`;
}

export function createDeliverRuntime(parts: DeliverParts): DeliverRuntime {
  const seen = new Map<string, TaskState>();
  const centralSessionOf = (centralId: string): string | null =>
    parts.sessions ? (resolveCentralSession(centralId, parts.sessions())?.sessionId ?? null) : null;

  const offLedger = parts.ledger.onChange((t) => {
    const before = seen.get(t.taskId);
    if (before === t.state) return;
    if (t.state === 'done' || t.state === 'failed' || t.state === 'cancelled') seen.delete(t.taskId);
    else seen.set(t.taskId, t.state);
    try {
      parts.activity.logActivity({
        centralId: t.centralId,
        centralSessionId: centralSessionOf(t.centralId),
        tool: 'task',
        risk: 'steers',
        targetSessionId: t.sessionId,
        taskId: t.taskId,
        summary: transitionSummary(t),
        outcome: t.state,
        detail: before === undefined ? null : { from: before },
      });
    } catch (err) {
      log.warn('mcp', `Logging task ${t.taskId} (${t.state}) to the activity log failed: ${describe(err)}`);
    }
  });

  return {
    ledger: parts.ledger,
    activity: parts.activity,
    controller: (sessionId) => parts.controller(sessionId),
    resolveSessionId: (id) => parts.resolveSessionId(id),
    isOpsTerminal: (terminalId) => parts.isOpsTerminal(terminalId),
    ...(parts.centralEscAt ? { centralEscAt: parts.centralEscAt } : {}),
    onTaskUpdate: (listener) => parts.ledger.onChange((t) => listener(toTaskView(t))),
    close() {
      offLedger();
      parts.activity.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Not wired
// ---------------------------------------------------------------------------

/** The refusal of every write when the server has no P2 runtime. */
export function unwired(): ToolError {
  return new ToolError(
    'UNAVAILABLE',
    'This AASC build cannot drive sessions: its task ledger and activity log are not wired.',
    'Tell the person; reading sessions still works.',
  );
}

/** The ledger of a server with no P2 runtime: it holds no task and records none. */
export const unwiredLedger: Ledger = {
  create() {
    throw unwired();
  },
  get: () => null,
  list: () => [],
  isLocked: () => false,
  isFromBeforeRestart: () => false,
  wait: async () => [],
  cancel: async () => {
    throw new ToolError('NOT_FOUND', 'You have no task with that id.', 'task_list shows your tasks.');
  },
  retarget() {
    throw unwired();
  },
  onChange: () => () => undefined,
};
