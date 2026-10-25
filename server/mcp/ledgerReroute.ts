// ledgerReroute.ts — what P4 adds to the task ledger (ledger.ts), as pure rules and records; the ledger keeps the state.
//
// A new worker's first task waits for it to start (Ruling P4-6). The prompt route refuses a card that is `connecting`
// (`agent_not_ready`), and a central's prompt to one the connecting timeout turned `idle` (`startHeard: false`,
// Rulings P4-35, P4-41), so a task created on either is recorded `queued`, holding the lock, and its envelope is sent
// once the worker's terminal has sent a real hook: SessionStart, or the first hook of any kind (Ruling P4-22). The
// card's status alone never counts: sessionStore turns a `connecting` card `idle` after 30 s with no hook (marking it
// `startHeard: false` until its terminal's first hook), and a CLI that has sent none may be showing its folder-trust
// dialog, where a typed envelope would answer it. Claude sends SessionStart when it starts; Codex only at its first
// prompt, so a Codex worker starts here only when the connecting timeout found it at its input in a folder Codex
// trusts, its terminal heard by that trust record (Rulings P4-46, P4-52); anywhere else Codex 0.163 shows its own
// "Trust this folder?" prompt, which AASC does not answer. A worker that has not started after NEW_WORKER_START_MS,
// or whose card ends or whose terminal exits first, fails the task with NEW_WORKER_ERROR (looked at every
// START_POLL_MS).
//
// One task id end to end, re-routed once (Ruling P4-7). A task AASC routed itself (`route.by` 'auto') whose worker's
// terminal closed before its turn stopped fails with TERMINAL_EXIT_ERROR, and only such a failure may be re-routed
// (`ledger.retarget`), once: to another session, same id, queued again, the same envelope sent under a key of its own.
// A refusal, an Esc, an answer, an agent that left, a session that ended, a turn that had stopped (its work may be
// done), a worker that never started and a terminal a person closed (PERSON_CLOSED_ERROR, closedBy.ts, Ruling P4-24)
// are never re-routed.

import type { Session } from '../../src/types/session.js';
import { startPending, terminalHeard } from '../heardTerminals.js';
import { ROUTE_WORDS_MAX } from './ledgerParts.js';
import { promptKeyFor } from './ledgerTurn.js';
import type { TaskRecord, TaskRoute } from './ledgerTypes.js';
import { shortIdOf } from './scope.js';
import { oneLine } from './tools/define.js';
import { ToolError } from './types.js';

/** How long a new worker has to start before its first task fails. */
export const NEW_WORKER_START_MS = 120_000;
/** How often a task that waits looks at its new worker's card. */
export const START_POLL_MS = 2_000;

/**
 * A session that sent no hook in time, or whose card ended or terminal exited while it started. Neutral (Ruling P4-58):
 * a new worker and one unheard since an AASC restart wait the same way.
 */
export const NEW_WORKER_ERROR =
  'The session has not reported in: its CLI sent AASC no hook. It may be waiting for the person (a trust question), ' +
  'or AASC restarted since it last spoke.';
export const NEW_WORKER_NOTE = 'the session has not reported in (it may be waiting for the person, or AASC restarted)';
/** What the record of a task that waits for its session to report in says. */
export const WAITING_NOTE = 'recorded; AASC sends it once the session has reported that it started';

/** Its terminal closed before its turn stopped: the one failure AASC re-routes. */
export const TERMINAL_EXIT_ERROR = 'Its terminal closed before the task was done.';
/** Its terminal closed after its turn stopped (shells running, the answer being read): its work may be done. */
export const TERMINAL_EXIT_AFTER_STOP_ERROR = 'Its terminal closed after its turn stopped, before AASC had its answer.';
/** A person closed its terminal (closedBy.ts): they meant the work to stop, so it is never re-routed. */
export const PERSON_CLOSED_ERROR = 'A person closed its terminal.';

/** The most reasons a route keeps. */
const ROUTE_REASONS_MAX = 12;

/** What a central reads when the session's CLI has not been heard from yet (Rulings P4-35, P4-41). */
export const NOT_STARTED_ERROR = 'The session has not reported that it started.';
export const NOT_STARTED_HINT = 'If it shows a question, the person answers it in AASC.';

/**
 * Is the session still starting: `connecting`, or not yet reported in (`startPending`: turned idle by the connecting
 * timeout before its terminal sent a hook, or a terminal unheard since AASC restarted, Ruling P4-58)? Its prompt waits
 * for it (the prompt route would refuse it now), and fails with NEW_WORKER_ERROR if it never reports in.
 */
export const isStarting = (s: Pick<Session, 'status' | 'startHeard' | 'terminalId'>): boolean =>
  s.status === 'connecting' || startPending(s);

/**
 * Where a starting worker is: started once its terminal sent a hook (`sawStart`, Ruling P4-22), or once its card is
 * past `connecting` with its terminal heard (Ruling P4-52: a Codex worker in a folder Codex trusts is heard by its trust
 * record at the connecting timeout, and sends no hook before its first prompt); never while it has not reported in
 * (`startPending`: the marker, or a terminal no hook has heard — a hook from another tty is not its start, Ruling
 * P4-59; the prompt route would refuse it); ended when its card did; starting otherwise.
 */
export function startSeen(s: Session | null, sawStart: boolean): 'started' | 'ended' | 'starting' {
  if (s?.status === 'ended') return 'ended';
  if (s !== null && startPending(s)) return 'starting';
  if (sawStart) return 'started';
  return s !== null && s.status !== 'connecting' && terminalHeard(s.terminalId) ? 'started' : 'starting';
}

/** The route a task keeps: a copy of its own, each reason one line of AASC's words, bounded. */
export function routeOf(route: TaskRoute | null | undefined): TaskRoute | null {
  if (route === null || route === undefined) return null;
  const reasons = Array.isArray(route.reasons) ? route.reasons : [];
  return {
    by: 'auto',
    decision: route.decision,
    reasons: reasons.slice(0, ROUTE_REASONS_MAX).map((r) => oneLine(String(r), ROUTE_WORDS_MAX)),
  };
}

/** May this task be re-routed: routed by AASC, failed because its terminal closed before its turn stopped, not yet re-routed? */
export const isRetargetable = (t: TaskRecord): boolean =>
  t.state === 'failed' && t.error === TERMINAL_EXIT_ERROR && t.route?.by === 'auto' && (t.retargetedFrom ?? null) === null;

/**
 * Refuses a re-route before the new session's lock is looked at: NOT_FOUND for a task that is not `centralId`'s (or
 * not held), INVALID for one that may not be re-routed or a session it cannot go to.
 */
export function assertMayRetarget(t: TaskRecord | undefined, centralId: string, session: Session): asserts t is TaskRecord {
  if (t === undefined || t.centralId !== centralId) {
    throw new ToolError('NOT_FOUND', 'You have no task with that id.', 'task_list shows your tasks.');
  }
  if (!isRetargetable(t)) {
    throw new ToolError(
      'INVALID',
      'Only a task AASC routed itself, whose session’s terminal closed before its turn stopped, is re-routed, and only once.',
      'Delegate it again (task_delegate) if it is still wanted.',
    );
  }
  if (!session.terminalId) throw new ToolError('INVALID', 'That session has no terminal to type into.', 'Pick another session.');
  if (session.terminalId === t.terminalId || session.sessionId === t.sessionId) {
    throw new ToolError('INVALID', 'A task is re-routed to another session than the one it failed in.', 'Pick another session.');
  }
}

/** The task re-routed to `session` (`assertMayRetarget` passed): queued again, its id and route kept, its send under a key of its own. */
export function retargetedRecord(t: TaskRecord, session: Session, at: number): TaskRecord {
  return {
    ...t,
    sessionId: session.sessionId,
    terminalId: session.terminalId ?? '',
    state: 'queued',
    sentAt: null,
    updatedAt: at,
    // The prompt route answers a key it has seen with its first answer: a second send needs a key of its own.
    promptKey: `${promptKeyFor(t.centralId, t.taskId)}-r1`,
    answer: null,
    answerTruncated: false,
    error: null,
    retargetedFrom: t.sessionId,
    history: [...t.history, { at, state: 'queued', note: `re-routed from ${shortIdOf(t.sessionId)}` }],
  };
}
