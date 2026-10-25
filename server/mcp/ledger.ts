// ledger.ts — the task ledger: work a central hands to a session, followed from the prompt AASC types into it to
// the answer the session gives back.
//
//   queued ──submit──▶ sent ──its own prompt's UserPromptSubmit──▶ running ──Stop + done-check──▶ done
//                       │                                          ├─ a dialog opens ──▶ blocked ──answered──▶ running
//                       │                                          ├─ an API fault at Stop ──▶ stalled ──resumed──▶ running
//                       │                                          └─ Esc (the person's, or the central's cancel) ──▶ cancelled
//                       └─ refused, stopped, or never taken ──▶ failed     the session, its terminal or its agent gone ──▶ failed
//
// The prompt goes through the prompt route (POST /sessions/:id/prompt, AASC-42's shared submitter), so it is typed
// and confirmed the way a phone's prompt is. What happens next is heard from the worker's own hooks on its terminal
// (hookSignals.ts), which survive a re-key from term-* to the CLI's id; the terminal-exit feed says when it is gone.
//
// Whose turn (Ruling 46, ledgerTurn.ts): the task's turn is the one its own envelope started, the UserPromptSubmit
// whose prompt (the card's `currentPrompt`) begins `[AASC · task T<n> from `; a hook with no prompt text asks the
// route how the key's send went instead. Another prompt typed first (a person's, the queue's, another central's)
// starts nothing. Once the task's turn has stopped (a verdict pending, or background shells still running), any other
// prompt ends it: the verdict is given there, the answer bounded before that prompt. A stalled turn goes on only for
// its own envelope or a resume prompt; any other prompt fails it. Another prompt in the middle of the task's turn
// fails it too (conservative: AASC cannot tell the two answers apart).
//
// The done-check: no background shell left (`backgroundTaskCount` 0), no fault banner (`interruption`), no cancel.
// A cancel is a `system: 'cancelled'` entry in the task's turn on the chat page, or the session's `userCancelledAt`
// stamped after the task was sent (checked before and after the read: sessionStore stamps it 150-600 ms after the
// Stop, so the verdict waits STOP_SETTLE_MS; a tool hook in that window means the turn went on). The answer is the
// turn's final assistant message, read whole (Ruling 48: up to ANSWER_MAX, `answerTruncated` when cut), fenced as
// untrusted (Ruling 28). A read that fails is tried again on the next tick, READ_TRIES times in all (A-M5).
//
// A cancel presses Esc only while the task's own turn is current and the caller says the rails allow it; otherwise
// the task ends cancelled and nothing is pressed (the caller is told which). An Esc is noted (`noteCentralEsc`) so
// the stamp it causes is not taken for the person's (Ruling 47).
//
// One task per session across every central: `create` refuses BUSY while the session (or the terminal it runs in)
// holds a task that has not ended. Tasks live in memory and die with the process; ids are never reused: a new run
// counts on from the highest id the activity log holds (Ruling 49), and an id at or below that is "from before".
//
// A new worker (Ruling P4-6): a task created on a session still starting (`connecting`, a worker a central just opened)
// waits `queued`, holding the lock, and its envelope is sent once the worker's terminal has sent a hook (P4-22); it
// fails when none came in 120 s. A task AASC routed itself is re-routed once (`retarget`, Ruling P4-7) when its terminal
// closed before its turn stopped, unless a person closed it (closedBy.ts, P4-24). The rules are in ledgerReroute.ts.
// `close()` stops every timer and listener (the server's runtime close).
//
// Records go in and out as copies and are replaced, never edited. Nothing here repeats what a session wrote outside
// the fenced answer: a fault is named by its kind, never by its banner. The limits, the bookkeeping kept beside a task
// and the small rules are in ledgerParts.ts; the ledger as one central sees it is ledgerView.ts.

import type { ChatEntry } from '../../src/types/chat.js';
import type { Session } from '../../src/types/session.js';
import { EVENT_TYPES } from '../constants.js';
import type { HookSignal } from '../hookSignals.js';
import log from '../logger.js';
import { closedByPerson } from './closedBy.js';
import {
  AGENT_GONE_MS,
  BETWEEN_TURNS,
  cancelStamped,
  checkedTask,
  copyOf,
  describe,
  FINAL,
  faultWord,
  IN_TURN,
  isOpen,
  MAX_TASKS,
  NEW_BOOK,
  READ_TRIES,
  ROUTE_WORDS_MAX,
  SENT_TIMEOUT_MS,
  SETTLED,
  STOP_EVENTS,
  STOP_SETTLE_MS,
  stoppedWords,
  TASK_NUMBER,
  TICK_MS,
  TURN_GOES_ON,
  waitLength,
  waitUntil,
  type Bookkeeping,
  type RecordChange,
} from './ledgerParts.js';
import {
  assertMayRetarget,
  isRetargetable,
  isStarting,
  NEW_WORKER_ERROR,
  NEW_WORKER_NOTE,
  NEW_WORKER_START_MS,
  PERSON_CLOSED_ERROR,
  retargetedRecord,
  routeOf,
  START_POLL_MS,
  startSeen,
  TERMINAL_EXIT_AFTER_STOP_ERROR,
  TERMINAL_EXIT_ERROR,
  WAITING_NOTE,
} from './ledgerReroute.js';
import {
  ANSWER_MAX,
  ANSWER_UNREAD_NOTE,
  buildEnvelope,
  envelopeHead,
  envelopeLabel,
  isOwnPrompt,
  isResumePrompt,
  promptKeyFor,
  readTurn,
} from './ledgerTurn.js';
import type {
  CancelHow,
  CancelOptions,
  CancelOutcome,
  CreateTaskInput,
  Ledger,
  LedgerDeps,
  PromptOutcomeView,
  SubmitAnswer,
  TaskFilter,
  TaskRecord,
  TaskState,
} from './ledgerTypes.js';
import { fence, oneLine, sessionSource } from './tools/define.js';
import { waitsOnPerson } from './tools/views.js';
import { ToolError } from './types.js';

export { ANSWER_MAX, ANSWER_UNREAD_NOTE, buildEnvelope, envelopeHead, envelopeLabel } from './ledgerTurn.js';
export type * from './ledgerTypes.js';
export {
  AGENT_GONE_MS,
  ANSWER_FORMAT_MAX,
  MAX_TASKS,
  READ_TRIES,
  SENT_TIMEOUT_MS,
  STOP_SETTLE_MS,
  TASK_TEXT_MAX,
  TICK_MS,
} from './ledgerParts.js';
export {
  isRetargetable,
  NEW_WORKER_START_MS,
  PERSON_CLOSED_ERROR,
  START_POLL_MS,
  TERMINAL_EXIT_AFTER_STOP_ERROR,
  TERMINAL_EXIT_ERROR,
} from './ledgerReroute.js';
export { ledgerFor } from './ledgerView.js';

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** The server's ledger: also `close()`, which stops its ticker, start polls, verdict timers and listeners. */
export interface ClosableLedger extends Ledger {
  close(): void;
}

export function createLedger(deps: LedgerDeps): ClosableLedger {
  const tasks = new Map<string, TaskRecord>();
  const books = new Map<string, Bookkeeping>();
  /** terminalId → the unsubscribe of its hook listener, while it holds an open task. */
  const watched = new Map<string, () => void>();
  const listeners = new Set<(t: TaskRecord) => void>();
  /** The envelopes of tasks AASC routed itself, kept while the task may still be re-routed (P4-7). */
  const envelopes = new Map<string, string>();
  /** The highest task number of earlier runs (null until the first task, or the first question about an id). */
  let seed: number | null = null;
  let counter = 0;
  let offExit: (() => void) | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const openOn = (terminalId: string): TaskRecord[] =>
    [...tasks.values()].filter((t) => isOpen(t) && t.terminalId === terminalId);

  function book(id: string, patch: Partial<Bookkeeping>): void {
    const current = books.get(id);
    if (current !== undefined) books.set(id, { ...current, ...patch });
  }

  function clearSettle(id: string): void {
    const timer = books.get(id)?.settle;
    if (timer) {
      clearTimeout(timer);
      book(id, { settle: null });
    }
  }

  function emit(t: TaskRecord): void {
    for (const listener of [...listeners]) {
      try {
        listener(copyOf(t));
      } catch (err) {
        log.warn('mcp', `A task listener failed on ${t.taskId}: ${describe(err)}`);
      }
    }
  }

  /** The highest task number of earlier runs, read once from the activity log; 0 when it cannot be read. */
  function seeded(): number {
    if (seed !== null) return seed;
    let n = 0;
    try {
      const last = deps.lastTaskNumber?.() ?? 0;
      n = Number.isSafeInteger(last) && last > 0 ? last : 0;
    } catch (err) {
      log.warn('mcp', `Reading the last task id from the activity log failed: ${describe(err)}`);
    }
    seed = n;
    counter = Math.max(counter, n);
    return n;
  }

  /** Listens to the task's terminal, the exit feed and the clock while any task is open. */
  function watch(t: TaskRecord): void {
    if (!watched.has(t.terminalId)) {
      watched.set(t.terminalId, deps.onTerminalHook(t.terminalId, (signal) => onHook(t.terminalId, signal)));
    }
    if (offExit === null) offExit = deps.onTerminalExit(onExit);
    if (ticker === null) {
      ticker = setInterval(onTick, TICK_MS);
      ticker.unref?.();
    }
  }

  /** A task ended: stop what only it needed. */
  function closed(t: TaskRecord): void {
    clearSettle(t.taskId);
    const poll = books.get(t.taskId)?.startPoll;
    if (poll) clearInterval(poll);
    books.delete(t.taskId);
    if (!isRetargetable(t)) envelopes.delete(t.taskId);
    if (openOn(t.terminalId).length === 0) {
      watched.get(t.terminalId)?.();
      watched.delete(t.terminalId);
    }
    if (![...tasks.values()].some(isOpen)) {
      offExit?.();
      offExit = null;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
    }
  }

  /**
   * Replaces an open task's record with `patch` applied (and a history line when its state moves). An ended task
   * never changes again. Answers the new record, or null when there was nothing to change.
   */
  function change(id: string, patch: RecordChange, note = ''): TaskRecord | null {
    const current = tasks.get(id);
    if (current === undefined || FINAL.has(current.state)) return null;
    const keys = Object.keys(patch) as Array<keyof RecordChange>;
    if (keys.every((k) => current[k] === patch[k])) return null;
    const at = deps.now();
    const to = patch.state ?? current.state;
    const moved = to !== current.state;
    const next: TaskRecord = {
      ...current,
      ...patch,
      updatedAt: at,
      history: moved ? [...current.history, { at, state: to, note }] : current.history,
    };
    tasks.set(id, next);
    if (moved) log.debug('mcp', `Task ${id} of central ${next.centralId}: ${current.state} -> ${to} (${note})`);
    if (FINAL.has(to)) closed(next);
    emit(next);
    return next;
  }

  const fail = (id: string, error: string, note: string): TaskRecord | null =>
    change(id, { state: 'failed', error }, note);

  // ---- sending ----

  async function send(record: TaskRecord, envelope: string): Promise<void> {
    let answer: SubmitAnswer;
    try {
      answer = await deps.submit(record.sessionId, envelope, record.promptKey, record.centralId);
    } catch (err) {
      log.warn('mcp', `Sending task ${record.taskId} failed: ${describe(err)}`);
      answer = { accepted: false, error: null };
    }
    const now = tasks.get(record.taskId);
    if (now === undefined || FINAL.has(now.state)) return;
    if (!answer.accepted) {
      const why = answer.error ? oneLine(answer.error, ROUTE_WORDS_MAX) : null;
      fail(record.taskId, why ? `The prompt route refused it: ${why}` : 'AASC could not send the prompt.', 'the prompt was refused');
      return;
    }
    if (now.state === 'queued') change(record.taskId, { state: 'sent', sentAt: deps.now() }, 'AASC is typing the prompt');
    else if (now.sentAt === null) change(record.taskId, { sentAt: deps.now() });
  }

  /** Sends the envelope now; to a worker still starting, once it has started (P4-6). */
  function dispatch(record: TaskRecord, envelope: string, session: Session): void {
    if (!isStarting(session)) {
      void send(record, envelope);
      return;
    }
    const poll = setInterval(() => lookAtStart(record.taskId), START_POLL_MS);
    poll.unref?.();
    book(record.taskId, { waiting: { envelope, since: deps.now() }, startPoll: poll });
  }

  /** The look at a starting worker's card: started, ended, or out of time. */
  function lookAtStart(id: string): void {
    const t = tasks.get(id);
    const waiting = books.get(id)?.waiting;
    if (t === undefined || !waiting) return;
    const seen = startSeen(deps.getSession(t.sessionId), books.get(id)?.sawStart === true);
    if (seen === 'started') started(id);
    else if (seen === 'ended' || deps.now() - waiting.since >= NEW_WORKER_START_MS) fail(id, NEW_WORKER_ERROR, NEW_WORKER_NOTE);
  }

  /** The new worker has started: its task's envelope goes out the way every task's does. */
  function started(id: string): void {
    const t = tasks.get(id);
    const b = books.get(id);
    if (t === undefined || !b?.waiting) return;
    if (b.startPoll) clearInterval(b.startPoll);
    book(id, { waiting: null, startPoll: null, awaySince: null });
    void send(t, b.waiting.envelope);
  }

  // ---- what the worker's hooks say ----

  function onHook(terminalId: string, signal: HookSignal): void {
    for (const t of openOn(terminalId)) {
      const followed = signal.sessionId && signal.sessionId !== t.sessionId ? change(t.taskId, { sessionId: signal.sessionId }) : null;
      react(followed ?? t, signal);
    }
  }

  /** The prompt the hook's UserPromptSubmit carried (the card's `currentPrompt`); '' when it carried none. */
  function promptOf(t: TaskRecord, signal: HookSignal): string {
    const prompt = deps.getSession(signal.sessionId || t.sessionId)?.currentPrompt;
    return typeof prompt === 'string' ? prompt : '';
  }

  function react(t: TaskRecord, signal: HookSignal): void {
    const event = signal.event;
    if (event === EVENT_TYPES.SESSION_END) {
      fail(t.taskId, 'The session ended before the task was done.', 'the session ended');
      return;
    }
    if (books.get(t.taskId)?.waiting) {
      // Its worker is still starting (P4-6): its first hook, whichever, is its start (P4-22), unless the hook did not
      // hear its terminal (another tty's, P4-53/P4-59): the look keeps it waiting until one does.
      book(t.taskId, { sawStart: true });
      lookAtStart(t.taskId);
      return;
    }
    if (t.state === 'queued' || t.state === 'sent') {
      if (event === EVENT_TYPES.USER_PROMPT_SUBMIT) promptBeforeTurn(t, promptOf(t, signal));
      return;
    }
    if (t.state === 'stalled') {
      if (event === EVENT_TYPES.USER_PROMPT_SUBMIT) promptWhileStalled(t, promptOf(t, signal));
      return;
    }
    if (IN_TURN.has(t.state)) inTurn(t, signal);
  }

  /** The task's own turn begins. */
  function begin(id: string, note: string): void {
    const t = tasks.get(id);
    if (t === undefined) return;
    book(id, { begun: true, stopped: false });
    change(id, { state: 'running', sentAt: t.sentAt ?? deps.now() }, note);
  }

  function promptBeforeTurn(t: TaskRecord, prompt: string): void {
    if (isOwnPrompt(prompt, t.taskId)) {
      begin(t.taskId, 'the session took the prompt');
      return;
    }
    // No text in the hook: the route knows whether this was the task's own prompt. Any other prompt starts nothing.
    if (prompt.trim() === '') void poll(t.taskId);
  }

  function promptWhileStalled(t: TaskRecord, prompt: string): void {
    const resumed = isOwnPrompt(prompt, t.taskId) || isResumePrompt(prompt, deps.resumePromptOf?.(t.sessionId) ?? null);
    if (!resumed) {
      fail(t.taskId, 'The session moved on to another prompt while the task was stalled.', 'the session moved on while stalled');
      return;
    }
    const b = books.get(t.taskId);
    book(t.taskId, { stopped: false, resumes: [...(b?.resumes ?? []), prompt] });
    change(t.taskId, { state: 'running' }, 'the turn was continued');
  }

  function inTurn(t: TaskRecord, signal: HookSignal): void {
    if (STOP_EVENTS.has(signal.event)) {
      book(t.taskId, { stopped: true });
      scheduleVerdict(t.taskId);
      return;
    }
    if (signal.event === EVENT_TYPES.USER_PROMPT_SUBMIT) {
      promptInTurn(t, promptOf(t, signal));
      return;
    }
    const b = books.get(t.taskId);
    if (b?.settle && !TURN_GOES_ON.has(signal.event)) return;
    if (TURN_GOES_ON.has(signal.event)) {
      // The turn went on after its Stop (a background task woke the agent): it is the task's turn still.
      clearSettle(t.taskId);
      if (b?.stopped) book(t.taskId, { stopped: false });
    }
    reconcile(t.taskId, signal.sessionId);
  }

  function promptInTurn(t: TaskRecord, prompt: string): void {
    // Its own prompt's hook, late: the route's answer began the turn first.
    if (isOwnPrompt(prompt, t.taskId)) return;
    if (books.get(t.taskId)?.stopped) {
      // The turn that stopped is over: decide now, the answer bounded before this prompt, whatever its shells do.
      clearSettle(t.taskId);
      void verdict(t.taskId, true);
      return;
    }
    if (prompt.trim() === '') return;
    fail(t.taskId, 'Another prompt reached the session before the task’s turn ended.', 'another prompt joined its turn');
  }

  /** Running or blocked, as the session's dialog state says now. */
  function reconcile(id: string, sessionId?: string): void {
    const t = tasks.get(id);
    if (t === undefined || !IN_TURN.has(t.state)) return;
    const s = deps.getSession(sessionId || t.sessionId);
    if (s === null) return;
    const waits = waitsOnPerson(s);
    if (waits && t.state === 'running') change(id, { state: 'blocked' }, 'the session waits on a dialog');
    else if (!waits && t.state === 'blocked') change(id, { state: 'running' }, 'the dialog was answered');
  }

  function scheduleVerdict(id: string): void {
    clearSettle(id);
    const timer = setTimeout(() => {
      book(id, { settle: null });
      void verdict(id, false);
    }, STOP_SETTLE_MS);
    timer.unref?.();
    book(id, { settle: timer });
  }

  /** The done-check, after a Stop has settled or when the next prompt ended the turn (`nextPrompt`). */
  async function verdict(id: string, nextPrompt: boolean): Promise<void> {
    const t = tasks.get(id);
    const b = books.get(id);
    if (t === undefined || b === undefined || !IN_TURN.has(t.state) || b.cancelling || b.finishing) return;
    const s = deps.getSession(t.sessionId);
    if (s === null) {
      fail(id, 'The session is gone.', 'the session is gone');
      return;
    }
    const sentAt = t.sentAt ?? t.createdAt;
    if (cancelStamped(s, sentAt)) {
      change(id, { state: 'cancelled' }, 'the person stopped the turn');
      return;
    }
    if (s.interruption) {
      change(id, { state: 'stalled' }, `the turn ended on an API fault (${faultWord(s.interruption.kind)})`);
      return;
    }
    const shells = (s.backgroundTaskCount ?? 0) > 0;
    if (shells && !nextPrompt) {
      log.debug('mcp', `Task ${id}: the turn ended with background shells running; it is not done yet`);
      return;
    }
    await finish(id, sentAt, shells);
  }

  /** Reads the task's turn from the chat page and ends the task on it: cancelled, or done with its answer. */
  async function finish(id: string, sentAt: number, shells: boolean): Promise<void> {
    const t = tasks.get(id);
    if (t === undefined) return;
    book(id, { finishing: true, retry: null });
    let page: readonly ChatEntry[] | null = null;
    try {
      page = await deps.readChat(t.sessionId, envelopeHead(t.taskId), sentAt, t.centralId);
    } catch (err) {
      log.warn('mcp', `Reading the answer of task ${id} failed: ${describe(err)}`);
    }
    book(id, { finishing: false });
    const now = tasks.get(id);
    const b = books.get(id);
    if (now === undefined || b === undefined || !IN_TURN.has(now.state) || b.cancelling) return;
    if (page === null) {
      const failures = b.readFailures + 1;
      if (failures < READ_TRIES) {
        book(id, { readFailures: failures, retry: { shells } });
        return;
      }
      change(id, { state: 'done', answer: null }, ANSWER_UNREAD_NOTE);
      return;
    }
    const turn = readTurn(page, { taskId: now.taskId, since: sentAt, resumes: b.resumes });
    if (turn.cancelled || cancelStamped(deps.getSession(now.sessionId), sentAt)) {
      change(id, { state: 'cancelled' }, 'the person stopped the turn');
      return;
    }
    const still = shells ? '; background shells were still running' : '';
    if (turn.answer === null) {
      change(id, { state: 'done', answer: null }, `the session wrote no answer${still}`);
      return;
    }
    change(
      id,
      { state: 'done', answer: fence(sessionSource(now.sessionId), 'answer', turn.answer), answerTruncated: turn.truncated },
      `${turn.truncated ? `the answer is in, cut to ${ANSWER_MAX} characters` : 'the answer is in'}${still}`,
    );
  }

  /**
   * A terminal exited. Re-routed later (P4-7) only when it closed mid-turn by itself: not a worker that never started,
   * not a close a person asked for (P4-24), not a turn that had stopped (it may have done its work).
   */
  function onExit(terminalId: string): void {
    const byPerson = closedByPerson(terminalId, deps.now());
    for (const t of openOn(terminalId)) {
      const b = books.get(t.taskId);
      if (b?.waiting) fail(t.taskId, NEW_WORKER_ERROR, NEW_WORKER_NOTE);
      else if (byPerson) fail(t.taskId, PERSON_CLOSED_ERROR, 'a person closed its terminal');
      else if (b?.stopped !== true && t.state !== 'stalled') fail(t.taskId, TERMINAL_EXIT_ERROR, 'the terminal closed');
      else fail(t.taskId, TERMINAL_EXIT_AFTER_STOP_ERROR, 'the terminal closed after its turn stopped');
    }
  }

  // ---- the clock ----

  /** Has the task's terminal not shown its agent in front for AGENT_GONE_MS? */
  function agentGone(t: TaskRecord, at: number): boolean {
    if (deps.agentInFront === undefined) return false;
    let front = true;
    try {
      front = deps.agentInFront(t.terminalId);
    } catch (err) {
      log.debug('mcp', `Asking what runs in task ${t.taskId}'s terminal failed: ${describe(err)}`);
    }
    const since = books.get(t.taskId)?.awaySince ?? null;
    if (front) {
      if (since !== null) book(t.taskId, { awaySince: null });
      return false;
    }
    if (since === null) {
      book(t.taskId, { awaySince: at });
      return false;
    }
    return at - since >= AGENT_GONE_MS;
  }

  function onTick(): void {
    const at = deps.now();
    for (const t of [...tasks.values()]) {
      // A task that waits for its new worker has its own limit (P4-6): the agent-gone check starts once it is sent.
      if (!isOpen(t) || books.get(t.taskId)?.waiting) continue;
      if (agentGone(t, at)) {
        fail(t.taskId, 'The agent left its terminal before the task was done.', 'the agent left the terminal');
        continue;
      }
      if (t.state === 'queued' || t.state === 'sent') {
        if (at - (t.sentAt ?? books.get(t.taskId)?.clockFrom ?? t.createdAt) > SENT_TIMEOUT_MS) {
          fail(t.taskId, 'The session never took the prompt.', 'the prompt was never taken');
        } else if (t.state === 'sent') {
          void poll(t.taskId);
        }
        continue;
      }
      if (!IN_TURN.has(t.state)) continue;
      const b = books.get(t.taskId);
      if (b?.retry && !b.finishing) void finish(t.taskId, t.sentAt ?? t.createdAt, b.retry.shells);
      else if (!b?.settle) reconcile(t.taskId);
    }
  }

  /** Asks the prompt route how the send went: a prompt it gave up on (or stopped) is a failed task. */
  async function poll(id: string): Promise<void> {
    const t = tasks.get(id);
    if (t === undefined || t.state !== 'sent' || books.get(id)?.polling) return;
    book(id, { polling: true });
    let outcome: PromptOutcomeView | null = null;
    try {
      outcome = await deps.promptOutcome(t.sessionId, t.promptKey, t.centralId);
    } catch (err) {
      log.debug('mcp', `Asking how task ${id}'s prompt went failed: ${describe(err)}`);
    }
    book(id, { polling: false });
    if (outcome === null || tasks.get(id)?.state !== 'sent') return;
    if (outcome.state === 'submitted' || outcome.state === 'unconfirmed') {
      begin(id, 'the session took the prompt');
      // Taken, and the session is between turns already: the task's turn ran while no hook said whose it was.
      const s = deps.getSession(t.sessionId);
      if (s !== null && BETWEEN_TURNS.has(s.status)) {
        book(id, { stopped: true });
        scheduleVerdict(id);
      }
      return;
    }
    const words = stoppedWords(outcome);
    fail(id, words.error, words.note);
  }

  // ---- the lock ----

  function isLocked(sessionId: string, exceptTaskId?: string): boolean {
    const s = deps.getSession(sessionId);
    const ids = new Set([sessionId, ...(s === null ? [] : [s.sessionId])]);
    const terminal = s?.terminalId ?? null;
    return [...tasks.values()].some(
      (t) =>
        isOpen(t) &&
        t.taskId !== exceptTaskId &&
        (ids.has(t.sessionId) || (terminal !== null && t.terminalId === terminal)),
    );
  }

  /** Ended tasks beyond MAX_TASKS are forgotten, the least recently changed first. */
  function prune(): void {
    if (tasks.size < MAX_TASKS) return;
    const ended = [...tasks.values()].filter((t) => !isOpen(t)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const t of ended.slice(0, tasks.size - MAX_TASKS + 1)) {
      tasks.delete(t.taskId);
      envelopes.delete(t.taskId);
    }
  }

  // ---- the interface ----

  function create(i: CreateTaskInput): TaskRecord {
    const { text, format, terminalId } = checkedTask(i);
    if (isLocked(i.session.sessionId) || openOn(terminalId).length > 0) {
      throw new ToolError(
        'BUSY',
        'That session is working on a task a central gave it.',
        'Wait for that task (task_wait), or pick another session.',
      );
    }
    prune();
    seeded();
    counter += 1;
    const taskId = `T${counter}`;
    const at = deps.now();
    const route = routeOf(i.route);
    const record: TaskRecord = {
      taskId,
      centralId: i.central.centralId,
      sessionId: i.session.sessionId,
      terminalId,
      task: text,
      answerFormat: format,
      state: 'queued',
      createdAt: at,
      sentAt: null,
      updatedAt: at,
      promptKey: promptKeyFor(i.central.centralId, taskId),
      answer: null,
      answerTruncated: false,
      error: null,
      history: [{ at, state: 'queued', note: isStarting(i.session) ? WAITING_NOTE : 'recorded' }],
      route,
      retargetedFrom: null,
    };
    tasks.set(taskId, record);
    books.set(taskId, NEW_BOOK);
    watch(record);
    emit(record);
    const label = i.label ?? envelopeLabel(i.central, []);
    const envelope = buildEnvelope(taskId, i.central, label, text, format);
    if (route !== null) envelopes.set(taskId, envelope);
    dispatch(record, envelope, i.session);
    return copyOf(record);
  }

  function get(id: string): TaskRecord | null {
    const t = tasks.get(id);
    return t === undefined ? null : copyOf(t);
  }

  function isFromBeforeRestart(id: string): boolean {
    const n = TASK_NUMBER.exec(id);
    return n !== null && !tasks.has(id) && Number(n[1]) <= seeded();
  }

  function list(f: TaskFilter = {}): TaskRecord[] {
    return [...tasks.values()]
      .filter(
        (t) =>
          (f.centralId === undefined || t.centralId === f.centralId) &&
          (f.state === undefined || t.state === f.state) &&
          (f.sessionId === undefined || t.sessionId === f.sessionId),
      )
      .sort((a, b) => a.createdAt - b.createdAt || Number(a.taskId.slice(1)) - Number(b.taskId.slice(1)))
      .map(copyOf);
  }

  function wait(ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<TaskRecord[]> {
    const wanted = [...new Set(ids)].filter((id) => tasks.has(id));
    // A dialog the approval timer raised fires no hook: look before waiting.
    for (const id of wanted) if (!books.get(id)?.settle) reconcile(id);
    const current = (): TaskRecord[] =>
      wanted.map((id) => tasks.get(id)).filter((t): t is TaskRecord => t !== undefined).map(copyOf);
    const settled = (): boolean =>
      wanted.every((id) => {
        const t = tasks.get(id);
        return t === undefined || SETTLED.has(t.state);
      });
    return waitUntil(settled, current, (look) => onChange(look), waitLength(timeoutMs), signal);
  }

  /** Is the task's own turn the one running in its session now (so an Esc would stop it, and nothing else)? */
  function ownTurnCurrent(id: string): boolean {
    const t = tasks.get(id);
    const b = books.get(id);
    return t !== undefined && b !== undefined && IN_TURN.has(t.state) && b.begun && !b.stopped && !b.finishing && b.retry === null;
  }

  async function cancel(id: string, centralId: string, opts: CancelOptions = {}): Promise<CancelOutcome> {
    const t = tasks.get(id);
    if (t === undefined || t.centralId !== centralId) {
      throw new ToolError('NOT_FOUND', 'You have no task with that id.', 'task_list shows your tasks.');
    }
    if (FINAL.has(t.state)) return { task: copyOf(t), how: 'ended' };
    const endWithout = (how: CancelHow, note: string): CancelOutcome => ({
      task: copyOf(change(id, { state: 'cancelled' }, note) ?? tasks.get(id) ?? t),
      how,
    });
    // Waiting for its new worker (P4-6), nothing of it has been typed: it ends here, and nothing is (Ruling P4-16).
    if (books.get(id)?.waiting) {
      return endWithout('nothing-to-press', 'cancelled by the central before its new session started; nothing was typed or pressed');
    }
    if (t.state === 'queued' || t.state === 'sent') {
      throw new ToolError(
        'INVALID',
        'That task has not started yet: AASC cannot take back a prompt it is still sending.',
        'Wait for it to start (task_wait), then cancel it.',
      );
    }
    // Its turn is over (stalled, stopped, its answer being read): an Esc now would land in whatever runs next.
    if (!ownTurnCurrent(id)) return endWithout('turn-over', 'cancelled by the central; its turn had already ended, nothing was pressed');
    if (opts.mayPress !== true) return endWithout('held', 'cancelled by the central; nothing was pressed');
    clearSettle(id);
    book(id, { cancelling: true });
    let pressed = false;
    try {
      deps.noteCentralEsc?.(t.sessionId, t.terminalId);
      pressed = await deps.interrupt(t.sessionId, t.terminalId);
    } catch (err) {
      log.warn('mcp', `The Esc for task ${id} failed: ${describe(err)}`);
    }
    const note = pressed ? 'cancelled by the central; AASC pressed Esc on its turn' : 'cancelled by the central; nothing was pressed';
    const after = change(id, { state: 'cancelled' }, note);
    return { task: copyOf(after ?? tasks.get(id) ?? t), how: pressed ? 'pressed' : 'nothing-to-press' };
  }

  function retarget(id: string, centralId: string, session: Session): TaskRecord {
    const t = tasks.get(id);
    assertMayRetarget(t, centralId, session);
    const envelope = envelopes.get(id);
    if (envelope === undefined) throw new Error('A task that may be re-routed has no envelope kept.');
    if (isLocked(session.sessionId) || openOn(session.terminalId ?? '').length > 0) {
      throw new ToolError('BUSY', 'That session is working on a task a central gave it.', 'Pick another session.');
    }
    // Replaced whole (`change` never moves a final record). The old terminal is gone: nothing of it is released.
    const next = retargetedRecord(t, session, deps.now());
    envelopes.delete(id);
    tasks.set(id, next);
    // Its clock starts again (P4-28): the time it ran in the old session is not time its prompt waited.
    books.set(id, { ...NEW_BOOK, clockFrom: deps.now() });
    log.debug('mcp', `Task ${id} of central ${centralId}: failed -> queued (re-routed)`);
    watch(next);
    emit(next);
    dispatch(next, envelope, session);
    return copyOf(next);
  }

  function onChange(listener: (t: TaskRecord) => void): () => void {
    // Wrapped, so the same function added twice is two subscriptions that end separately.
    const subscription = (t: TaskRecord): void => listener(t);
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
    };
  }

  /** Stops everything the ledger runs; the records stay readable. */
  function close(): void {
    for (const b of books.values()) {
      if (b.settle) clearTimeout(b.settle);
      if (b.startPoll) clearInterval(b.startPoll);
    }
    books.forEach((b, id) => books.set(id, { ...b, settle: null, startPoll: null, waiting: null }));
    for (const off of watched.values()) off();
    watched.clear();
    offExit?.();
    offExit = null;
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  }

  return { create, get, list, isLocked, isFromBeforeRestart, wait, cancel, retarget, onChange, close };
}
