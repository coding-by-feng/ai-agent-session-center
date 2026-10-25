// tools/queueWrite.ts — the queue toolset's P2 writes: what a central does to a session's shared prompt queue. This
// module holds the tools about the prompts themselves (add, edit, remove, move, on/off, timing, ⚡ NOW) and files the
// whole set (`queueWriteTools`); the chain steps are in queueWriteSteps.ts and the automation switches in
// queueWriteAutomation.ts. The queue is read by queue_get, queue_list_all and queue_sent (queue.ts).
//
// Every tool names a session, which must be one the central may steer (`steerTarget`: scope, then `ctx.mayDrive`), and
// changes the stored queue in one read-modify-write (queueOps.ts). The desktop window runs the queue, so a write that
// finds no window says so. P2 writes text only (Ruling P2-1), and a prompt a central adds is added paused (Ruling P2-2):
// a person turns it on in AASC. In the central's own worker (a session it opened itself, workers.ts) it is added on
// (Ruling P4-12). For the same reason a prompt that is on is not changed or moved in any other session (Rulings 43 and
// 53, `lockIfOn`): the lock says no inside the write.

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import {
  addItem,
  editItem,
  fireNow,
  MAX_LOOP_INTERVAL_MS,
  MAX_WINDOWS,
  MIN_LOOP_INTERVAL_MS,
  moveItem,
  removeItem,
  setItemEnabled,
  setItemSchedule,
  type ScheduleInput,
} from '../queueOps.js';
import { isOwnWorker, reordersEnabled } from '../unattended.js';
import { defineTool, SESSION_REF } from './define.js';
import {
  CLOCK_TIME,
  ITEM_ID,
  itemAnswer,
  lockIfOn,
  lockUnattended,
  nameOf,
  ON_LOCK,
  OWN_WORKERS_ONLY,
  PLACE,
  positionOf,
  PROMPT_TEXT,
  QUIET_WINDOW,
  RAILS,
  removedAnswer,
  requireWindow,
  steerTarget,
  steerTargetForText,
  serverDeps,
  startTarget,
  type QueueWriteDeps,
  writeOp,
} from './queueWriteKit.js';
import { automationTools } from './queueWriteAutomation.js';
import { stepTools } from './queueWriteSteps.js';
import { isoOrNull } from './shape.js';
import { waitsOnPerson } from './views.js';

/** The paused-add words, said in the answer and in the tool's description. */
const ADDED_PAUSED = 'Added paused — turn it on in AASC, or it runs once a human enables it.';

/** What an add into the central's own worker says instead (Ruling P4-12). */
const ADDED_ON = 'It is on: the AASC window sends it when the session is ready.';

/** A date with no time, which JavaScript reads as midnight UTC (B-M5). */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `runAt` as unix ms. A date alone is midnight on the Mac, as a date and time with no zone is that time on the Mac. */
function runAtMs(value: string): number {
  const day = DATE_ONLY.exec(value);
  return day === null ? Date.parse(value) : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
}

const addItemTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_add_item',
    toolset: 'queue',
    title: 'Queue a prompt for a session',
    description:
      'Adds one prompt to a session’s queue, last or at `position` (0 is first). It is plain text that the AASC ' +
      'window types into the session when the session is ready (images come later). In a session the central did ' +
      'not open, the prompt is added paused and a central cannot turn it on: it does not run until a person turns it ' +
      'on in AASC, so tell them it is waiting. In the central’s own worker (a session it opened itself) it is added ' +
      'on. ' +
      `Answers with the prompt as stored (id, position, paused; its text fenced as untrusted data). ${RAILS}`,
    risk: 'steers',
    phase: 2,
    input: {
      id: SESSION_REF,
      text: PROMPT_TEXT,
      position: PLACE.optional().describe('Where in the queue it goes: 0 is first. Leave out to add it last.'),
    },
    async run(args, ctx) {
      // Ruling 60 holds in the central's own worker too: the text is checked before the rails and before anything is written.
      const s = await steerTargetForText(ctx, args.id, args.text);
      const on = isOwnWorker(ctx, s);
      const change = await writeOp(deps, ctx, s, (state) =>
        addItem(state, { sessionId: s.sessionId, text: args.text, position: args.position, disabled: !on }, ctx.now()),
      );
      const { itemId } = change.result;
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId,
        said: `Queued a prompt for session ${nameOf(ctx, s)}. ${on ? ADDED_ON : ADDED_PAUSED}`,
        note: {
          summary: on ? 'Queued a prompt, on (its own worker)' : 'Queued a prompt, paused',
          targetSessionId: s.sessionId,
          detail: { itemId, position: positionOf(change.items, itemId) },
        },
      });
    },
  });

const editItemTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_edit_item',
    toolset: 'queue',
    title: 'Change the text of a queued prompt',
    description:
      'Replaces the text of one queued prompt (its id is in queue_get). Its timing, chain steps, images and paused ' +
      `flag stay as they are. ${ON_LOCK} Answers with the prompt as stored, its text fenced as untrusted data. ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID, text: PROMPT_TEXT },
    async run(args, ctx) {
      const s = await steerTargetForText(ctx, args.id, args.text);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return editItem(state, { itemId: args.itemId, text: args.text });
      });
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Changed the text of a queued prompt of session ${nameOf(ctx, s)}.`,
        note: { summary: 'Edited a queued prompt', targetSessionId: s.sessionId, detail: { itemId: args.itemId } },
      });
    },
  });

const removeItemTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_remove_item',
    toolset: 'queue',
    title: 'Remove a queued prompt',
    description:
      'Takes one prompt out of a session’s queue. The others keep their places. It cannot be undone: the text is ' +
      `not kept. ${RAILS}`,
    risk: 'write',
    phase: 2,
    input: { id: SESSION_REF, itemId: ITEM_ID },
    async run(args, ctx) {
      const s = steerTarget(ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => removeItem(state, { itemId: args.itemId }));
      return removedAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Removed a queued prompt from session ${nameOf(ctx, s)}.`,
        note: { summary: 'Removed a queued prompt', targetSessionId: s.sessionId, detail: { itemId: args.itemId } },
      });
    },
  });

const moveItemTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_move_item',
    toolset: 'queue',
    title: 'Move a queued prompt',
    description:
      'Moves one queued prompt to a place in the queue: 0 is first, a place past the end is last. The queue is ' +
      'numbered again from 0. Moving a prompt that is on, or a move that changes the order of the prompts that are on, ' +
      `changes what AASC sends by itself: ${OWN_WORKERS_ONLY} Answers with ` +
      `where it was and where it went. ${RAILS}`,
    risk: 'write',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID, position: PLACE.describe('The place to move it to: 0 is first.') },
    async run(args, ctx) {
      const s = steerTarget(ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        const moved = moveItem(state, { itemId: args.itemId, position: args.position });
        if (reordersEnabled(state.items, moved.items)) lockUnattended(deps, ctx, s, 'loosen');
        return moved;
      });
      const { from, to } = change.result;
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Moved a queued prompt of session ${nameOf(ctx, s)} from place ${from} to place ${to}.`,
        note: { summary: 'Moved a queued prompt', targetSessionId: s.sessionId, detail: { itemId: args.itemId, from, to } },
        extra: { moved: { from, to } },
      });
    },
  });

const setEnabledTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_set_item_enabled',
    toolset: 'queue',
    title: 'Turn a queued prompt on or off',
    description:
      'Turns one queued prompt off, which is always allowed: the scheduler skips it, and it keeps its place, timing ' +
      'and steps. Turning one ON lets AASC send it into the session on its own, an unattended run. ' +
      `${OWN_WORKERS_ONLY} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID, enabled: z.boolean().describe('true turns the prompt on, false turns it off.') },
    async run(args, ctx) {
      // Turning a prompt on starts an unattended run (Ruling 42); turning one off never does.
      const s = args.enabled ? startTarget(deps, ctx, args.id) : steerTarget(ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => setItemEnabled(state, { itemId: args.itemId, enabled: args.enabled }));
      const word = args.enabled ? 'on' : 'off';
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Turned a queued prompt of session ${nameOf(ctx, s)} ${word}.${args.enabled ? ' It can now run on its own when the session is ready.' : ''}`,
        note: { summary: `Turned a queued prompt ${word}`, targetSessionId: s.sessionId, detail: { itemId: args.itemId } },
      });
    },
  });

const setScheduleTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_set_item_schedule',
    toolset: 'queue',
    title: 'Set when a queued prompt runs',
    description:
      'Sets when one queued prompt runs. type "once": as soon as the session is ready. "loop": again and again every ' +
      'intervalMs (1 second to 30 days), with an optional firstFireOfDay (HH:MM, local) and quiet-hours ' +
      'excludeWindows (local HH:MM). "schedule": once at runAt, an ISO 8601 time in the future (with no zone it is the ' +
      'Mac’s local time; a date alone is midnight there). A field that does not belong to the type is refused. It does ' +
      `not turn the prompt on. ${ON_LOCK} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: {
      id: SESSION_REF,
      itemId: ITEM_ID,
      type: z.enum(['once', 'loop', 'schedule']).describe('How it runs.'),
      intervalMs: z.number().int().min(MIN_LOOP_INTERVAL_MS).max(MAX_LOOP_INTERVAL_MS).optional().describe('A loop only, and required for one: milliseconds between runs.'),
      runAt: z
        .string()
        .max(40)
        .refine((value) => isoOrNull(value) !== null, 'runAt is not an ISO 8601 date and time, like 2026-10-25T09:00:00+10:00.')
        .optional()
        .describe(
          'A schedule only, and required for one: when to run it, ISO 8601, in the future. With no zone it is the Mac’s ' +
            'local time, and a date alone (2026-10-25) is midnight on the Mac, not midnight UTC.',
        ),
      firstFireOfDay: CLOCK_TIME.nullable().optional().describe('A loop only: it does not run before this time of day. null clears it.'),
      excludeWindows: z.array(QUIET_WINDOW).max(MAX_WINDOWS).optional().describe('A loop only: quiet hours in which it does not start. An empty list clears them.'),
    },
    async run(args, ctx) {
      const s = steerTarget(ctx, args.id);
      const input: ScheduleInput = {
        itemId: args.itemId,
        type: args.type,
        intervalMs: args.intervalMs,
        runAt: args.runAt === undefined ? undefined : runAtMs(args.runAt),
        firstFireOfDay: args.firstFireOfDay,
        excludeWindows: args.excludeWindows,
      };
      const change = await writeOp(deps, ctx, s, (state) => {
        lockIfOn(deps, ctx, s, state.items, args.itemId);
        return setItemSchedule(state, input, ctx.now());
      });
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Set a queued prompt of session ${nameOf(ctx, s)} to run as ${args.type === 'once' ? 'once' : `a ${args.type}`}.`,
        note: { summary: 'Changed the timing of a queued prompt', targetSessionId: s.sessionId, detail: { itemId: args.itemId, type: args.type } },
      });
    },
  });

const fireNowTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_fire_now',
    toolset: 'queue',
    title: 'Start a queued prompt now (⚡ NOW)',
    description:
      'Starts one queued prompt, with its whole before and after chain, right away: past the idle guard, quiet hours ' +
      'and the auto-send switch. That is an unattended run. ' +
      `${OWN_WORKERS_ONLY} Where allowed, a ` +
      'prompt already partway through its chain has the step it waits on released instead; the AASC window carries it ' +
      'out as soon as the session can take it, so a window must be open (NO_WINDOW otherwise); and it is refused for a ' +
      'session that waits on an approval, a question or a plan (answer it first), for a paused prompt and for a paused ' +
      'queue. ' +
      RAILS,
    risk: 'steers',
    phase: 2,
    input: { id: SESSION_REF, itemId: ITEM_ID },
    async run(args, ctx) {
      const s = startTarget(deps, ctx, args.id);
      // A flagged prompt is typed past the idle guard, so into an open dialog too, and its Enter would answer it
      // (the phone's ⚡ refuses the same way). The other writes wait for the scheduler, which sends only when ready.
      if (waitsOnPerson(s)) {
        throw new ToolError(
          'BUSY',
          'That session is waiting on an answer (an approval, a question or a plan).',
          'Answer it first (request_list shows it, request_answer answers it), then start the prompt.',
        );
      }
      await requireWindow(ctx);
      const change = await writeOp(deps, ctx, s, (state) => fireNow(state, { itemId: args.itemId }));
      const { resumed } = change.result;
      const where = `of session ${nameOf(ctx, s)}`;
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: resumed
          ? `A queued prompt ${where} was partway through its chain: released the step it waits on. The AASC window sends it as soon as the session can take it.`
          : `Started a queued prompt ${where} now: the AASC window sends it as soon as the session can take it.`,
        note: {
          summary: resumed ? 'Released the step a queued chain waits on' : 'Started a queued prompt now',
          targetSessionId: s.sessionId,
          detail: { itemId: args.itemId },
        },
        extra: { resumed },
      });
    },
  });

/**
 * The 15 queue writes over `deps` (the store they change). The registry gets them over the server's own store
 * (`queueWriteTools`); a test passes its own.
 */
export function createQueueWriteTools(deps: QueueWriteDeps): readonly ToolDef[] {
  return [
    addItemTool(deps),
    editItemTool(deps),
    removeItemTool(deps),
    moveItemTool(deps),
    setEnabledTool(deps),
    setScheduleTool(deps),
    fireNowTool(deps),
    ...stepTools(deps),
    ...automationTools(deps),
  ];
}

/** The queue writes the registry offers (tools/index.ts), over the server's own queue store. */
export const queueWriteTools: readonly ToolDef[] = createQueueWriteTools(serverDeps);
