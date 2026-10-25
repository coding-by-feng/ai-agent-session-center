// tools/sessionEnd.ts — ending a session (the sessions toolset, P5, Task 4): stop its turn (`session_interrupt`), restart
// it in a new terminal (`session_restart`), kill its process (`session_kill`) and close its card (`session_close`). All
// four are `destructive`: runTool's gate asks the person on the card `confirm` answers, and runs nothing until they allow.
//
// `confirm`, in order (a refusal comes before any card, so the person is never bothered by one):
//   1. the card: `resolveTarget` (scope; a refusal never repeats the id), then the ending rails, `ctx.mayEnd` (P5-8):
//      itself, another central, an ops shell, a subagent, an AI popup, an external or an SSH card, then hands-off, a
//      person in the last 60 s or their Esc hold, and another central's task (BUSY). The caller's own task does not
//      block an end: the person is asked;
//   2. the tool's own checks (the table in the P5 plan);
//   3. the card, or null when none is needed:
//        interrupt  none on the caller's own worker (a person who drove it has adopted it, so a turn there is the
//                   central's own doing)
//        restart    none for the caller's own idle worker (ownIdle.ts `ownIdleReason`, P5-4)
//        kill       always (P5-5), the caller's own idle worker included
//        close      none for the caller's own idle worker; a pinned one asks, as the rule excludes pinned cards
// `run` asks 1 and 2 again. A run the person did not allow (`ctx.allowedByPerson()` false) whose card would be needed
// now is INVALID "That session changed; call again.": the check sits here, not in `confirm`, because the gate asks
// `confirm` again after an allow with `allowedByPerson` still false (Ruling P5-24).
//
// The card's summary names the session by its short id in AASC's words, never by its title. Its fingerprint (P5-3) is
// the terminal id and whether the card is pinned (P5-34: the person must have seen the pin clause), never a pid: a
// central's kill only closes the card's own terminal (Ruling P5-33), and tells the route which terminal it was allowed
// to end (`expectTerminalId`), so an approval carried out on another terminal runs nothing. `data` is
// `{ sessionId, … }` with the route's answer fields; the words never repeat what a route said.

import type { Session } from '../../../src/types/session.js';
import { startPending } from '../../heardTerminals.js';
import type { InternalResponse } from '../client.js';
import { changedRefusal } from '../confirm.js';
import { isOpen } from '../ledgerParts.js';
import { NOT_STARTED_ERROR, NOT_STARTED_HINT } from '../ledgerReroute.js';
import { openThroughRoute } from '../openWorker.js';
import { ownIdleReason } from '../ownIdle.js';
import { assertWithinCap, effectiveModeOf } from '../permissionCap.js';
import type { QueueItemLike } from '../queueOps.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError, type CliKind } from '../types.js';
import { openWorkerDepsFor } from '../workerDeps.js';
import { defineTool, isRecord, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { assertBareCommand, cliOf, foldersOf } from './sessionLife.js';

// ---------------------------------------------------------------------------
// What every description says (Ruling 65)
// ---------------------------------------------------------------------------

const RAILS_RULE =
  'Never yourself, another central, an ops shell, a subagent, an AI popup, an external or an SSH session; never a ' +
  'hands-off session, one a person drove in the last minute or holds with their Esc, nor one another central’s task ' +
  'holds (BUSY). Your own task there does not stop it: the person is asked.';
const ASK_RULE =
  'When the person must be asked, it answers NEEDS_CONFIRMATION: tell the person what you asked, then call ' +
  'confirm_wait; nothing happens until they allow it.';
const OWN_IDLE_RULE =
  'No card for your own idle worker: one you opened that nobody pinned, made hands-off or typed into, that holds no ' +
  'task, is idle or waiting, and has no queued prompt switched on. Anything else, a pinned card included, asks the ' +
  'person. If the session changed by the time it runs, it is refused (INVALID): call it again.';

// ---------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------

/** A turn runs, or the CLI shows a dialog: an Esc stops or declines it (promptSubmit.ts's interruptible statuses). */
const MID_TURN: ReadonlySet<string> = new Set(['working', 'prompting', 'approval', 'input']);

/** The shape of a Claude or Codex session id; the restart route's own pattern (apiRouter.ts CLAUDE_SESSION_UUID_RE). */
const CLI_SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const changedNow = (): ToolError =>
  new ToolError('INVALID', 'That session changed; call again.', 'Call the tool again: the person is asked if it needs asking now.');

const notStarted = (): ToolError => new ToolError('UNAVAILABLE', NOT_STARTED_ERROR, NOT_STARTED_HINT);

const noSafeTarget = (): ToolError =>
  new ToolError(
    'UNAVAILABLE',
    'AASC ends a session only through its own terminal, and that session has none it can close.',
    'Ask the person to end it in AASC.',
  );

/** The card `id` names, if the ending rails let the central end it. */
function endTarget(ctx: ToolContext, id: string): Session {
  const s = resolveTarget(ctx, id);
  ctx.mayEnd(s);
  return s;
}

/** What the card is about as AASC sees it now (P5-3, P5-34): its terminal, and whether it is pinned. AASC-made only. */
const fingerprintOf = (s: Session): string => `terminal:${s.terminalId ?? 'none'}|pinned:${s.pinned === true ? 1 : 0}`;

/** The queue's items as the route stores them; a queue with no record yet holds none. Throws when it cannot be read. */
async function readQueue(ctx: ToolContext, sessionId: string): Promise<readonly QueueItemLike[]> {
  const record = unwrap<unknown>(await ctx.client.get(`/sessions/${seg(sessionId)}/queue`));
  if (!isRecord(record)) throw new Error('the queue answer is not a record');
  if (record.items === null || record.items === undefined) return [];
  if (!Array.isArray(record.items)) throw new Error('the queue items are not a list');
  return record.items.filter(isRecord);
}

/** Does ending the card need the person's card? No when it is the caller's own idle worker (P5-4). */
async function needsCardUnlessOwnIdle(ctx: ToolContext, s: Session): Promise<boolean> {
  return (await ownIdleReason(ctx, s, (id) => readQueue(ctx, id))) !== null;
}

/** What a card about a pinned session adds (P5-5). */
const pinnedClause = (s: Session, words: string): string => (s.pinned === true ? `; it is pinned: ${words} and it will not come back` : '');

/** A route's refusals every tool here reads the same way; any other failure as `unwrap` reads it. */
function routeRefusal(r: InternalResponse<unknown>): ToolError | null {
  const error = isRecord(r.data) && typeof r.data.error === 'string' ? r.data.error : '';
  if (r.status === 409 && error === 'not_started') return notStarted();
  if (r.status === 409 && error === 'no_safe_target') return noSafeTarget();
  if (r.status === 409 && error === 'changed') return changedRefusal();
  if (r.status === 404) return new ToolError('NOT_FOUND', 'AASC no longer has that session, or its terminal.', 'Call session_list for the ids.');
  if (r.status === 403) return new ToolError('DENIED', 'Sessions are ended from this Mac only.', 'Tell the person; this should not happen for a central.');
  return null;
}

/** The route's answer without its envelope, or the refusal. */
function answerOf<T>(r: InternalResponse<unknown>): T {
  if (!r.ok) {
    const refusal = routeRefusal(r);
    if (refusal !== null) throw refusal;
  }
  return unwrap<T>(r);
}

// ---------------------------------------------------------------------------
// session_interrupt
// ---------------------------------------------------------------------------

/** The id of the caller's own open task in this session (or its terminal, which a re-key keeps), else null. */
function ownOpenTask(ctx: ToolContext, s: Session): string | null {
  const terminal = s.terminalId ?? null;
  const own = ctx.ledger
    .list()
    .find((t) => isOpen(t) && (t.sessionId === s.sessionId || (terminal !== null && t.terminalId === terminal)));
  return own?.taskId ?? null;
}

/** The interrupt's own checks (P5-7): a terminal, started, a turn or a dialog running, and not the caller's task. */
function assertInterruptible(ctx: ToolContext, s: Session): void {
  const nothing = new ToolError('INVALID', 'Nothing is running there to interrupt.', 'session_get shows what the session is doing.');
  if (!s.terminalId) throw nothing;
  if (startPending(s)) throw notStarted();
  if (!MID_TURN.has(s.status)) throw nothing;
  const task = ownOpenTask(ctx, s);
  if (task !== null) {
    throw new ToolError('INVALID', `That turn is your task ${task}: task_cancel stops it and ends the task.`, 'Call task_cancel with that task id.');
  }
}

const isOwnWorker = (ctx: ToolContext, s: Session): boolean => ctx.workers.isOwn(ctx.central.centralId, s);

const sessionInterrupt = defineTool({
  name: 'session_interrupt',
  toolset: 'sessions',
  title: 'Stop a session’s running turn',
  description:
    'Stops the turn a session is running: AASC presses Esc in its terminal, as a person would, and waits up to 10 s for ' +
    'the turn to stop. At a dialog the Esc declines it. Only while a turn runs or a dialog is open (INVALID otherwise: ' +
    'nothing is running there), and only once the session has reported that it started. A turn that is your own task ' +
    'is refused (INVALID): task_cancel stops it and ends the task. No card on your own worker (one you opened and ' +
    `nobody typed into); any other session asks the person. ${ASK_RULE} ${RAILS_RULE}`,
  risk: 'destructive',
  phase: 5,
  input: { id: SESSION_REF },
  confirm(args, ctx) {
    const s = endTarget(ctx, args.id);
    assertInterruptible(ctx, s);
    if (isOwnWorker(ctx, s)) return null;
    return {
      summary: `stop the running turn of session ${refOf(ctx)(s.sessionId)} (Esc; an open dialog is declined)`,
      targetSessionId: s.sessionId,
      fingerprint: fingerprintOf(s),
    };
  },
  async run(args, ctx) {
    const s = endTarget(ctx, args.id);
    assertInterruptible(ctx, s);
    if (!ctx.allowedByPerson() && !isOwnWorker(ctx, s)) throw changedNow();
    const body = answerOf<{ pressed?: unknown }>(await ctx.client.post(`/sessions/${seg(s.sessionId)}/interrupt`, { confirm: true }));
    const pressed = body.pressed === true;
    const ref = refOf(ctx)(s.sessionId);
    return {
      data: { sessionId: s.sessionId, pressed },
      summary: pressed
        ? `Pressed Esc in session ${ref}: its turn stopped, or a dialog was declined. session_get shows where it is now.`
        : `Nothing was running in session ${ref} by the time AASC looked: no key was pressed.`,
      activity: [{ summary: pressed ? 'interrupted a turn' : 'found no turn to interrupt', targetSessionId: s.sessionId, detail: { pressed } }],
    };
  },
});

// ---------------------------------------------------------------------------
// session_restart
// ---------------------------------------------------------------------------

/** The restart's own checks (P5-9), before any card: not ended, a CLI session id, the relaunch rule, the cap. */
function assertRestartable(ctx: ToolContext, s: Session): CliKind {
  if (s.status === 'ended') {
    throw new ToolError('INVALID', 'That session has ended: a restart is for a running one.', 'Use session_resume to bring it back.');
  }
  const cli = cliOf(s, 'Only Claude Code and Codex sessions are restarted.');
  if (!CLI_SESSION_ID.test(s.sessionId)) {
    throw new ToolError(
      'UNAVAILABLE',
      'That session has not reported its CLI session id yet, so a restart could not bring its conversation back.',
      'Wait for it to report in (session_wait), or ask the person.',
    );
  }
  assertBareCommand(s, 'Ask the person to restart it in AASC, or pick another session.');
  assertWithinCap(ctx, effectiveModeOf(s));
  return cli;
}

const sessionRestart = defineTool({
  name: 'session_restart',
  toolset: 'sessions',
  title: 'Restart a session',
  description:
    'Restarts a running session as the toolbar’s Restart does: its agent stops (its turn, if any, ends), and AASC opens ' +
    'a new terminal in the same place and resumes the same conversation there. Not an ended session (INVALID: use ' +
    'session_resume), nor one that has not reported its CLI session id yet (UNAVAILABLE). Only a session started as a ' +
    'bare claude or codex command with no flags but the ones AASC launches with, never looser than your own permission ' +
    'mode, and only when the folder it opens in is in your scope. It counts against your 10 opens a minute. After a ' +
    `restart the session is no longer one of your own: it is the person’s. ${OWN_IDLE_RULE} ${ASK_RULE} ${RAILS_RULE}`,
  risk: 'destructive',
  phase: 5,
  input: { id: SESSION_REF },
  async confirm(args, ctx): Promise<ConfirmAsk | null> {
    const s = endTarget(ctx, args.id);
    assertRestartable(ctx, s);
    if (!(await needsCardUnlessOwnIdle(ctx, s))) return null;
    return {
      summary: `restart session ${refOf(ctx)(s.sessionId)} in a new terminal (its turn, if any, ends)`,
      targetSessionId: s.sessionId,
      fingerprint: fingerprintOf(s),
    };
  },
  async run(args, ctx): Promise<ToolResult> {
    const s = endTarget(ctx, args.id);
    const cli = assertRestartable(ctx, s);
    if (!ctx.allowedByPerson() && (await needsCardUnlessOwnIdle(ctx, s))) throw changedNow();
    const call = async (): Promise<InternalResponse<unknown>> => {
      const r = await ctx.client.post(`/sessions/${seg(s.sessionId)}/restart-terminal`, { confirm: true });
      const refusal = r.ok ? null : routeRefusal(r);
      if (refusal !== null && refusal.code !== 'NOT_FOUND') throw refusal;
      return r;
    };
    const opened = await openThroughRoute(ctx, { cli, ...foldersOf(s), own: false, mode: effectiveModeOf(s), call }, openWorkerDepsFor(ctx));
    return {
      data: { sessionId: s.sessionId, terminalId: opened.terminalId, own: false },
      summary:
        `Restarting session ${refOf(ctx)(s.sessionId)} in a new terminal, ${shortIdOf(opened.terminalId)}; it is no longer ` +
        'one of your own sessions. session_wait shows when it is back.',
      activity: [{ summary: 'restarted a session', targetSessionId: s.sessionId, detail: { terminalId: opened.terminalId } }],
    };
  },
});

// ---------------------------------------------------------------------------
// session_kill
// ---------------------------------------------------------------------------

/** The kill's own checks (P5-33): not ended, and in a terminal of its own (a kill signals no pid). Its terminal id. */
function assertKillable(s: Session): string {
  if (s.status === 'ended') {
    throw new ToolError('INVALID', 'That session has ended: there is nothing left to kill.', 'Use session_close to remove its card.');
  }
  if (!s.terminalId) throw noSafeTarget();
  return s.terminalId;
}

const sessionKill = defineTool({
  name: 'session_kill',
  toolset: 'sessions',
  title: 'Kill a session',
  description:
    'Kills a session: AASC closes its terminal, its agent and every process under it end, and its card stays as ended. ' +
    'A kill always asks the person, even your own idle worker. A pinned session is unpinned and does not come back. ' +
    'AASC ends a session only through its own terminal: one with none (a card restored after AASC restarted, say), or ' +
    'whose terminal AASC cannot close alone, is refused (UNAVAILABLE), as is a kill a process survived. Not an ended ' +
    `session (INVALID: session_close removes its card). ${ASK_RULE} ${RAILS_RULE}`,
  risk: 'destructive',
  phase: 5,
  input: { id: SESSION_REF },
  confirm(args, ctx) {
    const s = endTarget(ctx, args.id);
    assertKillable(s);
    return {
      summary: `kill session ${refOf(ctx)(s.sessionId)} (its process and terminal end)${pinnedClause(s, 'a kill unpins it')}`,
      targetSessionId: s.sessionId,
      fingerprint: fingerprintOf(s),
    };
  },
  async run(args, ctx) {
    const s = endTarget(ctx, args.id);
    const terminalId = assertKillable(s);
    // A kill always asks (P5-5): a run the person did not allow is one whose card was never answered.
    if (!ctx.allowedByPerson()) {
      throw new ToolError('INVALID', 'A kill always asks the person, and they have not allowed this one.', 'Call session_kill again: the person is asked.');
    }
    // The terminal the fingerprint vouched for: the route ends nothing in another (409 changed).
    const r = await ctx.client.post(`/sessions/${seg(s.sessionId)}/kill`, { confirm: true, expectTerminalId: terminalId });
    if (!r.ok && r.status === 500) {
      throw new ToolError(
        'UNAVAILABLE',
        'A process in that session’s terminal survived the kill: its terminal was closed and its card unpinned, but the card was not removed.',
        'Tell the person: it may need ending by hand.',
      );
    }
    const body = answerOf<{ killedPid?: unknown; terminalId?: unknown; processShared?: unknown }>(r);
    const killedPid = typeof body.killedPid === 'number' ? body.killedPid : null;
    const closed = typeof body.terminalId === 'string' ? body.terminalId : null;
    const ref = refOf(ctx)(s.sessionId);
    return {
      data: { sessionId: s.sessionId, killedPid, terminalId: closed, processShared: body.processShared === true },
      summary:
        killedPid === null
          ? `Ended session ${ref}: its terminal closed, and its card shows it ended.`
          : `Killed session ${ref}: its process and terminal ended, and its card shows it ended.`,
      activity: [{ summary: 'killed a session', targetSessionId: s.sessionId, detail: { killedPid, terminalId: closed } }],
    };
  },
});

// ---------------------------------------------------------------------------
// session_close
// ---------------------------------------------------------------------------

const sessionClose = defineTool({
  name: 'session_close',
  toolset: 'sessions',
  title: 'Close a session',
  description:
    'Closes a session and removes its card: its terminal (and its commands terminal) close, and the card leaves every ' +
    `device. An ended session’s card can be closed too. ${OWN_IDLE_RULE} A pinned session asks, and does not come ` +
    `back. ${ASK_RULE} ${RAILS_RULE}`,
  risk: 'destructive',
  phase: 5,
  input: { id: SESSION_REF },
  async confirm(args, ctx): Promise<ConfirmAsk | null> {
    const s = endTarget(ctx, args.id);
    if (!(await needsCardUnlessOwnIdle(ctx, s))) return null;
    return {
      summary: `close session ${refOf(ctx)(s.sessionId)} and remove its card${pinnedClause(s, 'closing it removes the pin')}`,
      targetSessionId: s.sessionId,
      fingerprint: fingerprintOf(s),
    };
  },
  async run(args, ctx): Promise<ToolResult> {
    const s = endTarget(ctx, args.id);
    if (!ctx.allowedByPerson() && (await needsCardUnlessOwnIdle(ctx, s))) throw changedNow();
    const body = answerOf<{ removed?: unknown }>(await ctx.client.del(`/sessions/${seg(s.sessionId)}`));
    const removed = body.removed === true;
    return {
      data: { sessionId: s.sessionId, removed },
      summary: removed
        ? `Closed session ${refOf(ctx)(s.sessionId)}: its terminal ended and its card is gone.`
        : `Session ${refOf(ctx)(s.sessionId)} was already gone.`,
      activity: [{ summary: 'closed a session', targetSessionId: s.sessionId, detail: { removed } }],
    };
  },
});

export const endTools: readonly ToolDef[] = [sessionInterrupt, sessionRestart, sessionKill, sessionClose];
