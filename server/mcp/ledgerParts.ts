// ledgerParts.ts — the task ledger's limits and timings, the states and events it reads, the bookkeeping it keeps beside
// each open task, and the small pure rules it applies. ledger.ts holds the ledger itself (and re-exports the limits).

import type { Session } from '../../src/types/session.js';
import { EVENT_TYPES } from '../constants.js';
import { MAX_WAIT_MS } from './events.js';
import type { CreateTaskInput, PromptOutcomeView, TaskRecord, TaskState } from './ledgerTypes.js';
import { ToolError } from './types.js';

// ---------------------------------------------------------------------------
// Limits and timings
// ---------------------------------------------------------------------------

/** The longest task text (the prompt route takes 65 536 characters, the envelope included). */
export const TASK_TEXT_MAX = 60_000;
/** The longest answer format. */
export const ANSWER_FORMAT_MAX = 2_000;
/** How long after a Stop the verdict waits for a cancel stamp (sessionStore's transcript check). */
export const STOP_SETTLE_MS = 1_000;
/** How often the ledger looks at its open tasks: a sent prompt's outcome, a dialog no hook announced, the agent. */
export const TICK_MS = 5_000;
/** A sent prompt the session has not taken after this long never will (the submitter parks one ≤ 15 min). */
export const SENT_TIMEOUT_MS = 17 * 60_000;
/** A task whose terminal has not shown its agent in front for this long has lost it (Ruling 50). */
export const AGENT_GONE_MS = 10_000;
/** How many times the answer is read before the task is done without one (A-M5). */
export const READ_TRIES = 3;
/** Ended tasks beyond this many are forgotten, oldest first. */
export const MAX_TASKS = 500;

// ---------------------------------------------------------------------------
// States and events
// ---------------------------------------------------------------------------

export const FINAL: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled']);
export const SETTLED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled', 'blocked', 'stalled']);
export const IN_TURN: ReadonlySet<TaskState> = new Set<TaskState>(['running', 'blocked']);
export const STOP_EVENTS: ReadonlySet<string> = new Set<string>([EVENT_TYPES.STOP, EVENT_TYPES.AGENT_TURN_COMPLETE]);
/** Hooks that, after a Stop, mean the turn went on (a background task woke it), not that it is over. */
export const TURN_GOES_ON: ReadonlySet<string> = new Set<string>([
  EVENT_TYPES.PRE_TOOL_USE,
  EVENT_TYPES.POST_TOOL_USE,
  EVENT_TYPES.POST_TOOL_USE_FAILURE,
  EVENT_TYPES.PERMISSION_REQUEST,
  EVENT_TYPES.SUBAGENT_START,
]);
/** Statuses of a session whose turn is over: a send the route calls taken, seen only now, has already run. */
export const BETWEEN_TURNS: ReadonlySet<string> = new Set<string>(['waiting', 'idle']);
export const TASK_NUMBER = /^T([0-9]{1,9})$/;

// ---------------------------------------------------------------------------
// Small rules
// ---------------------------------------------------------------------------

export const ROUTE_WORDS_MAX = 200;
export const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const isOpen = (t: TaskRecord): boolean => !FINAL.has(t.state);
export const copyOf = (t: TaskRecord): TaskRecord => ({
  ...t,
  history: t.history.map((h) => ({ ...h })),
  route: t.route ? { ...t.route, reasons: [...t.route.reasons] } : null,
  retargetedFrom: t.retargetedFrom ?? null,
});
/** A fault kind is one of a few words (`rate_limit`); anything else a session object carries is not repeated. */
export const faultWord = (kind: unknown): string => (typeof kind === 'string' && /^[a-z_]{1,20}$/.test(kind) ? kind : 'unknown');
/** A cancel stamped on the session after the task was sent. */
export const cancelStamped = (s: Session | null, sentAt: number): boolean =>
  typeof s?.userCancelledAt === 'number' && s.userCancelledAt > sentAt;

/** A task's text, answer format and terminal, checked before anything is recorded; throws INVALID. */
export function checkedTask(i: CreateTaskInput): { text: string; format: string | null; terminalId: string } {
  const text = typeof i.task === 'string' ? i.task : '';
  if (text.trim() === '') throw new ToolError('INVALID', 'A task needs some text.', 'Say what the session should do.');
  if (text.length > TASK_TEXT_MAX) {
    throw new ToolError(
      'INVALID',
      `A task is at most ${TASK_TEXT_MAX} characters.`,
      'Shorten it, or point the session at a file that holds the details.',
    );
  }
  const format = typeof i.answerFormat === 'string' && i.answerFormat.trim() !== '' ? i.answerFormat.trim() : null;
  if (format !== null && format.length > ANSWER_FORMAT_MAX) {
    throw new ToolError('INVALID', `An answer format is at most ${ANSWER_FORMAT_MAX} characters.`, 'Shorten it.');
  }
  const terminalId = i.session.terminalId;
  if (!terminalId) throw new ToolError('INVALID', 'That session has no terminal to type into.', 'Pick another session.');
  return { text, format, terminalId };
}

/** How long a wait really lasts: at most MAX_WAIT_MS, and zero for a value that is not a positive number. */
export function waitLength(timeoutMs: number): number {
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.min(timeoutMs, MAX_WAIT_MS);
}

/**
 * `current()` once `settled()`, when `ms` passes (at once for 0), or at once when `signal` aborts; `onChange` calls its
 * listener whenever it is worth looking again, and answers the unsubscribe.
 */
export function waitUntil<T>(
  settled: () => boolean,
  current: () => T,
  onChange: (look: () => void) => () => void,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (ms === 0 || settled() || signal?.aborted) return Promise.resolve(current());
  return new Promise<T>((resolve) => {
    let done = false;
    let off: () => void = () => undefined;
    const finishWait = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', finishWait);
      resolve(current());
    };
    const timer = setTimeout(finishWait, ms);
    timer.unref?.();
    off = onChange(() => {
      if (settled()) finishWait();
    });
    signal?.addEventListener('abort', finishWait, { once: true });
  });
}

/** Why the prompt route stopped a send, as the task's error and its history note. */
export function stoppedWords(view: PromptOutcomeView): { error: string; note: string } {
  if (view.stoppedBy === 'hands-off') {
    return { error: 'Hands-off turned on before AASC finished typing the prompt.', note: 'hands-off turned on' };
  }
  if (view.stoppedBy === 'person') {
    return { error: 'A person took over the session before AASC finished typing the prompt.', note: 'a person took over' };
  }
  return { error: `The session never took the prompt (${view.state}).`, note: `the prompt was not taken (${view.state})` };
}

// ---------------------------------------------------------------------------
// The bookkeeping of an open task
// ---------------------------------------------------------------------------

/** The bookkeeping of an open task that is not part of its record. Replaced, never edited. */
export interface Bookkeeping {
  settle: ReturnType<typeof setTimeout> | null;
  /** Its answer is being read: the verdict is in progress. */
  finishing: boolean;
  /** The central is cancelling it: no verdict may finish it now. */
  cancelling: boolean;
  /** Its prompt's outcome is being asked for. */
  polling: boolean;
  /** Its own turn has begun (its prompt's UserPromptSubmit, or the route's `submitted` for its key). */
  begun: boolean;
  /** That turn reached a Stop: from now on, another prompt is the end of it. */
  stopped: boolean;
  /** The prompts that continued its stalled turn: on the chat page they do not end it. */
  resumes: readonly string[];
  /** Answer reads that failed so far. */
  readFailures: number;
  /** A verdict to try again on the next tick, its answer unread: whether shells were still running. */
  retry: { shells: boolean } | null;
  /** Since when its terminal has not shown the agent in front; null while it does. */
  awaySince: number | null;
  /** Its worker is still starting (P4-6): the envelope to send once it has, and since when it waits. */
  waiting: { envelope: string; since: number } | null;
  /** The look at a starting worker's card, every START_POLL_MS, while it waits. */
  startPoll: ReturnType<typeof setInterval> | null;
  /** Its worker's terminal has sent a hook (Ruling P4-22): the only sign that the worker started. */
  sawStart: boolean;
  /** Since when a prompt not yet taken is timed, when not since the record's `createdAt` (a re-route, P4-28). */
  clockFrom: number | null;
}

export const NEW_BOOK: Bookkeeping = {
  settle: null,
  finishing: false,
  cancelling: false,
  polling: false,
  begun: false,
  stopped: false,
  resumes: [],
  readFailures: 0,
  retry: null,
  awaySince: null,
  waiting: null,
  startPoll: null,
  sawStart: false,
  clockFrom: null,
};

export type RecordChange = Partial<Pick<TaskRecord, 'state' | 'sessionId' | 'sentAt' | 'answer' | 'answerTruncated' | 'error'>>;
