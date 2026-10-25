// tools/tasks.ts — the tasks toolset's P2 tools: `task_delegate`, `task_wait`, `task_get`, `task_list`, `task_cancel`.
// They sit on the task ledger (ledger.ts) as ONE central sees it (`ctx.ledger`): its own tasks only, recorded as itself,
// its envelope labelled with its room or folder. Another central's task is not there: `task_get` is NOT_FOUND for it,
// `task_list` and `task_wait` leave it out, `task_cancel` is NOT_FOUND.
//
// task_delegate hands a task to each session it names (the rails first, steer.ts, then one `ledger.create` each: the
// ledger types the envelope into the worker and follows it to its answer). `to: "auto"` (alone) is P4's: AASC routes
// it (tools/delegateAuto.ts), when `mcp.autoRouting` is on. Fan-out is the same as prompt_send's: one session named, a
// refusal is the call's; several, each refusal is that session's result.
//
// What the central reads back: the worker's answer arrives already fenced as untrusted (the ledger fences it, Ruling
// 28), in the text AND in `data`, whole up to 20 000 characters (`answerTruncated` when it was cut: Ruling 48); the
// central's own task text, when it is echoed (task_get, task_list), is fenced here as
// `<untrusted source="task:T12" kind="task">`. Everything else (ids, states, times, the ledger's notes) is plain,
// and no refusal repeats what the central wrote.
//
// task_cancel presses Esc only while the task's own turn is current and the rails, minus the task's own lock, allow
// it (hands-off, a person active, the person's Esc hold); otherwise the task ends cancelled with nothing pressed, and
// the answer says which (Ruling 46).

import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import type { ActivityNote } from '../activity.js';
import { ANSWER_FORMAT_MAX, ANSWER_MAX, ANSWER_UNREAD_NOTE, NEW_WORKER_START_MS, TASK_TEXT_MAX, type CancelHow, type TaskRecord, type TaskState } from '../ledger.js';
import { assertNotShellLine, MAX_FAN_OUT } from '../policy.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { clipText, defineTool, fence, oneLine, plural, refOf, resolveTarget, SESSION_REF } from './define.js';
import { limitInput } from './shape.js';
import { checkSteerable, refusalNote, resolveTargets, sessionRefs } from './steer.js';
import { delegateAuto } from './delegateAuto.js';
import { ROUTE_INPUTS } from './routing.js';
import { ago } from './views.js';

const STATES: readonly TaskState[] = ['queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'failed', 'cancelled'];

/** A task that stays where it is until something happens outside the central's wait: it ended, or it needs a person. */
const SETTLED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled', 'blocked', 'stalled']);
const ENDED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed', 'cancelled']);

/** The longest task text given back whole (the central wrote it; it needs no more to recognise it). */
const TASK_ECHO_MAX = 4_000;
const NEW_WORKER_START_MINUTES = Math.round(NEW_WORKER_START_MS / 60_000);
const TITLE_MAX = 120;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const WAIT_DEFAULT_SEC = 30;
const WAIT_MAX_SEC = 50;
const MAX_WAIT_IDS = 8;

const TASK_ID = z
  .string()
  .regex(/^[Tt][0-9]{1,9}$/, 'A task id such as T12.')
  .describe('A task id as task_delegate gave it, such as T12.');

/** `t12` and `T12` are one id. */
const idOf = (id: string): string => id.toUpperCase();

// ---------------------------------------------------------------------------
// How a task is shown
// ---------------------------------------------------------------------------

/** The text inside a fence the ledger put around an answer (for its length). */
const FENCE_INNER = /^<untrusted [^>]*>([\s\S]*)<\/untrusted>$/;

/** How long the answer is, fence not counted; null until there is one. */
const answerChars = (t: TaskRecord): number | null =>
  t.answer === null ? null : (FENCE_INNER.exec(t.answer)?.[1] ?? t.answer).length;

const taskFence = (t: TaskRecord, kind: string, text: string): string => fence(`task:${t.taskId}`, kind, text);

/** A task in full: for task_get and task_wait. Its text and format are fenced, its answer already is. */
function fullView(t: TaskRecord) {
  const text = clipText(t.task, TASK_ECHO_MAX);
  return {
    taskId: t.taskId,
    sessionId: t.sessionId,
    shortId: shortIdOf(t.sessionId),
    state: t.state,
    task: taskFence(t, 'task', text.text),
    taskTruncated: text.truncated,
    answerFormat: t.answerFormat === null ? null : taskFence(t, 'answer-format', clipText(t.answerFormat, TASK_ECHO_MAX).text),
    createdAt: t.createdAt,
    sentAt: t.sentAt,
    updatedAt: t.updatedAt,
    error: t.error,
    answer: t.answer,
    answerChars: answerChars(t),
    answerTruncated: t.answerTruncated,
    ...routeFacts(t),
    history: t.history.map((h) => ({ at: h.at, state: h.state, note: h.note })),
  };
}

/** How AASC routed a task and where it moved it from: facts a central acts on, so in `data` (Ruling 66), not only in words. */
function routeFacts(t: TaskRecord) {
  return {
    route: t.route === null ? null : { by: t.route.by, decision: t.route.decision, reasons: [...t.route.reasons] },
    retargetedFrom: t.retargetedFrom,
  };
}

/** A task as a list row: a one-line fenced title, and how long its answer is, but not the answer. */
function rowView(t: TaskRecord) {
  return {
    taskId: t.taskId,
    sessionId: t.sessionId,
    shortId: shortIdOf(t.sessionId),
    state: t.state,
    title: taskFence(t, 'task', oneLine(t.task, TITLE_MAX)),
    createdAt: t.createdAt,
    sentAt: t.sentAt,
    updatedAt: t.updatedAt,
    error: t.error,
    answerChars: answerChars(t),
    ...routeFacts(t),
  };
}

/** What a state means for the central, and what to do about it. AASC's own words. */
function stateWords(t: TaskRecord): string {
  switch (t.state) {
    case 'queued':
      return `AASC has recorded it. It waits for its session to be ready, then types the prompt; a session that has not reported in yet (session_get shows started: false) gets up to ${NEW_WORKER_START_MINUTES} minutes.`;
    case 'sent':
      return 'AASC typed the prompt; the session has not taken it yet (it may be finishing another turn).';
    case 'running':
      return 'The session is working on it.';
    case 'blocked':
      return 'The session waits on a dialog during the task. request_list shows it; request_answer answers it (or the person can).';
    case 'stalled':
      return 'Its turn ended on an API fault (a rate limit, an overload or the network). It goes on when the turn is continued (a resume prompt); any other prompt ends it failed. task_cancel ends it.';
    case 'done':
      if (t.answer !== null) {
        return t.answerTruncated
          ? `The session finished; its answer is below, cut at ${ANSWER_MAX} characters.`
          : 'The session finished; its answer is below.';
      }
      return t.history.at(-1)?.note === ANSWER_UNREAD_NOTE
        ? 'The session finished; AASC could not read its answer.'
        : 'The session finished, and wrote no answer.';
    case 'failed':
      return t.error ?? 'It failed.';
    case 'cancelled':
      return 'It was cancelled.';
  }
}

const VERBS: Readonly<Record<TaskState, string>> = {
  queued: 'is queued',
  sent: 'is sent',
  running: 'is running',
  blocked: 'is blocked',
  stalled: 'is stalled',
  done: 'is done',
  failed: 'has failed',
  cancelled: 'was cancelled',
};

/** `T12 is done (session 3f2a1b9c). The session finished…` and, when there is an answer, its fenced block. */
function taskText(ctx: ToolContext, t: TaskRecord): string {
  const head = `${t.taskId} ${VERBS[t.state]} (session ${refOf(ctx)(t.sessionId)}). ${stateWords(t)}`;
  return t.state === 'done' && t.answer !== null ? `${head}\n${t.answer}` : head;
}

// ---------------------------------------------------------------------------
// task_delegate
// ---------------------------------------------------------------------------

/** One target's result: the task started there, or why none did. */
interface DelegateResult {
  ref: string;
  sessionId: string | null;
  shortId: string | null;
  taskId: string | null;
  state: TaskState | null;
  code: string | null;
  error: string | null;
  hint: string | null;
}

const isAuto = (ref: string): boolean => ref.trim().toLowerCase() === 'auto';

/** A target that got no task, and why, as that target's result. */
function notStarted(ref: string, session: Session | null, refusal: ToolError): DelegateResult {
  return {
    ref,
    sessionId: session?.sessionId ?? null,
    shortId: session === null ? null : shortIdOf(session.sessionId),
    taskId: null,
    state: null,
    code: refusal.code,
    error: refusal.message,
    hint: refusal.hint ?? null,
  };
}

/** Records the task in the ledger for one session: the result and the activity note, or the ledger's refusal (BUSY in a race, INVALID). */
function startTask(
  ctx: ToolContext,
  ref: string,
  session: Session,
  args: { task: string; answerFormat?: string },
): { result: DelegateResult; note: ActivityNote } | ToolError {
  try {
    const t = ctx.ledger.create({
      central: ctx.central,
      session,
      task: args.task,
      ...(args.answerFormat === undefined ? {} : { answerFormat: args.answerFormat }),
    });
    return {
      result: { ref, sessionId: t.sessionId, shortId: shortIdOf(t.sessionId), taskId: t.taskId, state: t.state, code: null, error: null, hint: null },
      note: {
        summary: `Delegated ${t.taskId}.`,
        targetSessionId: t.sessionId,
        taskId: t.taskId,
        detail: { chars: args.task.length, answerFormat: t.answerFormat !== null },
      },
    };
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
}

export const taskDelegate: ToolDef = defineTool({
  name: 'task_delegate',
  toolset: 'tasks',
  title: 'Hand a task to sessions',
  description:
    'Hands a task to one session, or up to 8, and tracks it: AASC types it into each one with a line saying it comes ' +
    'from you, and follows the session’s own hooks to its answer. One task per session at a time (a busy session is ' +
    'refused with BUSY). Gives a task id for each; then task_wait for the answers before you report. Same rails as ' +
    'prompt_send (scope, hands-off, the 60-second rule, a person’s Esc); a task that starts with ! is refused. Never ' +
    'ask a session to approve something on the person’s behalf: the person answers through request_list and the tools ' +
    'that wait for them. to: "auto" (alone) lets AASC pick: it reuses an idle session in the project, opens a new one ' +
    'of your own, or hands the task down to a room or project central, and says why; cli, project, model and newOnly ' +
    'steer it. Auto routing may be off in this AASC (UNAVAILABLE): then task_route and name the sessions by id. When ' +
    'the answer says confidence is low, name the project (project:) next time. answerFormat says how the answer should look.',
  risk: 'steers',
  phase: 2,
  input: {
    to: z
      .union([SESSION_REF, z.array(SESSION_REF).min(1).max(MAX_FAN_OUT)])
      .describe('The session to hand the task to, or up to 8 sessions (ids, or short ids of 6 or more characters from session_list), or "auto" alone for AASC to pick.'),
    task: z.string().min(1).max(TASK_TEXT_MAX).describe('What the session is to do, in words it can act on alone (at most 60 000 characters).'),
    answerFormat: z.string().max(ANSWER_FORMAT_MAX).optional().describe('How the answer should look, for example "a one-line verdict" (at most 2 000 characters).'),
    ...ROUTE_INPUTS,
  },
  async run(args, ctx) {
    const refs = sessionRefs(args.to);
    if (refs.some(isAuto)) {
      if (refs.length > 1) {
        throw new ToolError('INVALID', '"auto" must be the only target.', 'Pass to: "auto" alone, or name the sessions by id.');
      }
      return delegateAuto(ctx, args);
    }
    if (args.cli !== undefined || args.project !== undefined || args.model !== undefined || args.newOnly !== undefined) {
      throw new ToolError('INVALID', 'cli, project, model and newOnly are for to: "auto" only.', 'Leave them out when you name the sessions.');
    }
    if (args.task.trim() === '') throw new ToolError('INVALID', 'A task needs some text.', 'Say what the session should do.');
    assertNotShellLine(args.task);
    const targets = resolveTargets(ctx, refs);
    const lone = targets.length === 1;
    const results: DelegateResult[] = [];
    const notes: ActivityNote[] = [];
    for (const target of targets) {
      const checked = checkSteerable(ctx, target);
      if (checked.refusal !== null) {
        if (lone) throw checked.refusal;
        results.push(notStarted(checked.ref, checked.session, checked.refusal));
        if (!checked.logged) notes.push(refusalNote(checked.refusal));
        continue;
      }
      const begun = startTask(ctx, checked.ref, checked.session, args);
      if (begun instanceof ToolError) {
        // The ledger's own refusal (the lock lost to another central in a race): nobody has logged it yet.
        if (lone) throw begun;
        results.push(notStarted(checked.ref, checked.session, begun));
        notes.push(refusalNote(begun));
        continue;
      }
      results.push(begun.result);
      notes.push(begun.note);
    }
    const started = results.filter((r) => r.taskId !== null);
    const refused = results.length - started.length;
    const ids = started.map((r) => r.taskId);
    const lines = results.map((r, i) =>
      r.taskId === null
        ? `- ${r.sessionId === null ? `target ${i + 1}` : refOf(ctx)(r.sessionId)}: not started (${r.code}): ${r.error}`
        : `- ${r.taskId} to ${refOf(ctx)(r.sessionId ?? '')}`,
    );
    const follow = ids.length > 0 ? ` Call task_wait with ids ${JSON.stringify(ids)} for the answers.` : '';
    return {
      data: { requested: results.length, started: started.length, tasks: results },
      summary:
        lone
          ? `Task ${ids[0]} handed to ${refOf(ctx)(results[0].sessionId ?? '')}: AASC is typing it into the session.${follow}`
          : `Handed ${started.length} of ${plural(results.length, 'task')}${refused > 0 ? `; ${refused} not started` : ''}.${follow}\n${lines.join('\n')}`,
      activity: notes,
    };
  },
});

// ---------------------------------------------------------------------------
// task_wait, task_get, task_list, task_cancel
// ---------------------------------------------------------------------------

/** The central's own task, or NOT_FOUND (in its own words for an id from before a restart: Ruling 49). */
function ownTask(ctx: ToolContext, id: string): TaskRecord {
  const t = ctx.ledger.get(idOf(id));
  if (t !== null) return t;
  if (ctx.ledger.isFromBeforeRestart(idOf(id))) {
    throw new ToolError(
      'NOT_FOUND',
      'That task is from before AASC restarted; it ended then.',
      'task_list shows your tasks since; hand it out again (task_delegate) if it still matters.',
    );
  }
  throw new ToolError('NOT_FOUND', 'You have no task with that id.', 'task_list shows your tasks.');
}

export const taskWait: ToolDef = defineTool({
  name: 'task_wait',
  toolset: 'tasks',
  title: 'Wait for tasks',
  description:
    'Waits, up to 50 seconds (30 by default), until each of up to 8 of your tasks is settled: done (with its fenced ' +
    'answer), failed, cancelled, blocked on a dialog or stalled on an API fault. Answers at once for tasks already ' +
    'settled. On a timeout it says where each stands: wait again.',
  risk: 'read',
  phase: 2,
  input: {
    ids: z.array(TASK_ID).min(1).max(MAX_WAIT_IDS).describe('The tasks to wait for (T12…), up to 8.'),
    timeoutSec: z.number().int().min(1).max(WAIT_MAX_SEC).default(WAIT_DEFAULT_SEC).describe(`How long to wait, 1 to ${WAIT_MAX_SEC} seconds.`),
  },
  async run(args, ctx) {
    const ids = [...new Set(args.ids.map(idOf))];
    for (const id of ids) ownTask(ctx, id);
    const records = await ctx.ledger.wait(ids, args.timeoutSec * 1_000, ctx.signal);
    const pending = records.filter((t) => !SETTLED.has(t.state));
    const lead =
      pending.length > 0
        ? `Timed out after ${args.timeoutSec} s with ${pending.length} of ${plural(records.length, 'task')} still going; call task_wait again to keep waiting.`
        : records.length > 1
          ? `All ${records.length} tasks have settled.`
          : '';
    return {
      data: { timedOut: pending.length > 0, waitedFor: records.length, tasks: records.map(fullView) },
      summary: [lead, ...records.map((t) => taskText(ctx, t))].filter((line) => line !== '').join('\n'),
    };
  },
});

export const taskGet: ToolDef = defineTool({
  name: 'task_get',
  toolset: 'tasks',
  title: 'A task’s record',
  description:
    'Gives one of your tasks: its state and the history of its states, its text (fenced), its answer if it is done ' +
    '(up to 20 000 characters, fenced as untrusted) and why it failed if it did.',
  risk: 'read',
  phase: 2,
  input: { id: TASK_ID },
  async run(args, ctx) {
    const t = ownTask(ctx, args.id);
    const view = fullView(t);
    return {
      data: view,
      summary: `${taskText(ctx, t)}\nLast change ${ago(ctx.now() - t.updatedAt)}. Its text:\n${view.task}`,
    };
  },
});

export const taskList: ToolDef = defineTool({
  name: 'task_list',
  toolset: 'tasks',
  title: 'Your tasks',
  description:
    'Lists your own tasks, newest first (50 by default, up to 200): id, session, state and a one-line title (fenced). ' +
    'Filter by state or by session. Another central’s tasks are never listed. task_get gives a task’s answer.',
  risk: 'read',
  phase: 2,
  input: {
    state: z.enum(STATES as [TaskState, ...TaskState[]]).optional().describe('Only tasks in this state.'),
    sessionId: SESSION_REF.optional().describe('Only tasks handed to this session.'),
    limit: limitInput(LIST_MAX, LIST_DEFAULT),
  },
  async run(args, ctx) {
    const session = args.sessionId === undefined ? null : resolveTarget(ctx, args.sessionId);
    const oldestFirst = ctx.ledger.list({
      ...(args.state === undefined ? {} : { state: args.state }),
      ...(session === null ? {} : { sessionId: session.sessionId }),
    });
    const all = [...oldestFirst].reverse();
    const shown = all.slice(0, args.limit ?? LIST_DEFAULT);
    const rows = shown.map(rowView);
    const data = { total: all.length, count: shown.length, tasks: rows };
    if (all.length === 0) return { data, summary: 'You have no tasks that match.' };
    const lead = shown.length < all.length ? `Showing ${shown.length} of ${plural(all.length, 'task')}, newest first.` : `${plural(all.length, 'task')}, newest first.`;
    const lines = shown.map((t) => `${t.taskId} · ${t.state} · session ${refOf(ctx)(t.sessionId)} · ${JSON.stringify(oneLine(t.task, TITLE_MAX))}`);
    return { data, summary: `${lead}\n${fence('aasc', 'tasks', lines.join('\n'))}` };
  },
});

/**
 * May the cancel of `t` press Esc in its session? The rails as for any write (the policy, quietly: what the cancel did
 * instead is its own row), its own lock left out. Answers the refusal that holds it, or null when it may.
 */
function escRefusal(ctx: ToolContext, t: TaskRecord): ToolError | null {
  const id = ctx.resolveSessionId(t.sessionId) ?? t.sessionId;
  const session = ctx.sessions().find((s) => s.sessionId === id);
  if (session === undefined) return new ToolError('NOT_FOUND', 'The session is gone.');
  try {
    ctx.mayDrive(session, { ownTaskId: t.taskId, quiet: true });
    return null;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
}

/** What the cancel did, in AASC's words, for the central and for the activity row. */
function cancelWords(how: CancelHow, t: TaskRecord, held: ToolError | null, wasWaiting: boolean): { summary: string; row: string } {
  switch (how) {
    case 'ended':
      return {
        summary: `${t.taskId} had already ended (${t.state}): nothing was cancelled.`,
        row: `Asked to cancel ${t.taskId}; it had already ended (${t.state}).`,
      };
    case 'pressed':
      return { summary: `${t.taskId} was cancelled: AASC pressed Esc on its turn.`, row: `Cancelled ${t.taskId}: pressed Esc.` };
    case 'nothing-to-press':
      // A task cancelled while it was still `queued` was waiting for its new session to start (the ledger refuses a
      // queued one AASC is typing): nothing of it was ever typed.
      if (wasWaiting) {
        return {
          summary: `${t.taskId} was cancelled while it was waiting for its new session to start: nothing was typed and nothing was pressed.`,
          row: `Cancelled ${t.taskId} while it waited for its new session; nothing typed.`,
        };
      }
      return {
        summary: `${t.taskId} was cancelled. The session was no longer mid-turn in its terminal, so nothing was pressed.`,
        row: `Cancelled ${t.taskId}; nothing to press.`,
      };
    case 'turn-over':
      return {
        summary: `${t.taskId} was cancelled. Its turn had already ended, so nothing was pressed.`,
        row: `Cancelled ${t.taskId}; its turn had ended, nothing pressed.`,
      };
    case 'held':
      return {
        summary: `${t.taskId} was cancelled, and nothing was pressed: ${held?.message ?? 'the session may not be steered now.'}`,
        row: `Cancelled ${t.taskId}; nothing pressed (${held?.code ?? 'held'}).`,
      };
  }
}

export const taskCancel: ToolDef = defineTool({
  name: 'task_cancel',
  toolset: 'tasks',
  title: 'Cancel a task',
  description:
    'Cancels one of your own tasks and ends it. While its own turn is still running (or waiting on a dialog) and the ' +
    'session may be steered (not hands-off, no person active in it, not stopped by the person), AASC presses Esc on ' +
    'that turn; otherwise nothing is pressed, and the answer says so. A task still waiting for its new session to ' +
    'start can be cancelled: nothing was typed. A task AASC is typing into a session right now cannot be taken back ' +
    '(wait for it to start, then cancel it); one that already ended is left as it is.',
  risk: 'write',
  phase: 2,
  // Cancelling a task that has ended leaves it as it is, so asking twice does what asking once does.
  idempotent: true,
  input: { id: TASK_ID },
  async run(args, ctx) {
    const before = ownTask(ctx, args.id);
    const held = ENDED.has(before.state) ? null : escRefusal(ctx, before);
    const { task: after, how } = await ctx.ledger.cancel(before.taskId, ctx.central.centralId, { mayPress: held === null });
    const words = cancelWords(how, after, held, before.state === 'queued');
    return {
      // `heldBy`: the code of the rail that stopped the Esc (HANDS_OFF, HUMAN_ACTIVE…), for a central to act on.
      data: { ...fullView(after), pressed: how === 'pressed', heldBy: how === 'held' ? (held?.code ?? null) : null },
      summary: words.summary,
      activity: [{ summary: words.row, targetSessionId: after.sessionId, taskId: after.taskId }],
    };
  },
});

export const taskTools: readonly ToolDef[] = [taskDelegate, taskWait, taskGet, taskList, taskCancel];
