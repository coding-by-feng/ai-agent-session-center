// tools/sessionCreate.ts — `session_create`: a central opens a session of its own (a P3 tool of the catalog, built
// with P4, which needs it). Everything it opens goes through openWorker.ts, the one way a central opens a session: the
// launch rule and its scope on the folder (as written and real), the permission cap from its card (Ruling P4-5), the
// budgets, the exact POST /terminals body, the own-worker record (Ruling P4-3) and the room filing.
//
// What the central leaves out comes from the folder's profile (projectIndex.ts `profileOf`: the CLI, model, effort and
// room of the folder's newest session): the model and effort only when that session ran the same CLI. The room is
// named by id or by its exact name among the rooms the central sees; a room central's worker always goes into its own
// room. With `firstTask`, the task is recorded at once and typed once the new session has started (Ruling P4-6).
//
// The title passes the title rule (titleRule.ts, Ruling P3-23): one the central gives is refused by openWorker
// (INVALID); the default, the first task's words (router.ts `shortTitle`) or the folder's name, is cleaned.
//
// Refusals come from openWorker in AASC's words (they never repeat the folder, the title or the room); runTool logs
// each with its code. The activity rows are openWorker's note and the task's: ids and AASC's words only.

import { basename } from 'node:path';
import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import type { ActivityNote } from '../activity.js';
import { newWorkerCard } from '../autoRoute.js';
import { expandHomePath } from '../launchRule.js';
import { TASK_TEXT_MAX } from '../ledger.js';
import { isEffortFor, openWorker, openedWorkerNote } from '../openWorker.js';
import { assertNotShellLine } from '../policy.js';
import { profileOf } from '../projectIndex.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortTitle } from '../router.js';
import { shortIdOf } from '../scope.js';
import { cleanTitle } from '../titleRule.js';
import { ToolError, type CliKind } from '../types.js';
import { openWorkerDepsFor } from '../workerDeps.js';
import { defineTool, visibleRooms } from './define.js';

/** A model name the terminals route takes (`--model <id>`). */
const MODEL = /^[a-zA-Z0-9._-]{1,100}$/;

/** The room the central named, by id or exact name among the rooms it sees; NOT_FOUND (never repeating it) otherwise. */
function namedRoom(ctx: ToolContext, room: string): string {
  const rooms = visibleRooms(ctx);
  const found = rooms.find((r) => r.id === room) ?? rooms.find((r) => r.name === room);
  if (found === undefined) throw new ToolError('NOT_FOUND', 'You see no room with that id or name.', 'room_list shows the rooms.');
  return found.id;
}

interface Settings {
  model?: string;
  effort?: string;
  roomId?: string;
}

/** What the folder's profile adds to what the central asked for. */
async function fromProfile(ctx: ToolContext, folder: string, home: string, cli: CliKind, asked: Settings): Promise<Settings> {
  const absolute = expandHomePath(folder, home);
  if (absolute === null) return asked;
  const profile = await profileOf(ctx, absolute);
  const same = profile.cli === cli;
  const model = asked.model ?? (same && profile.model !== null && MODEL.test(profile.model) ? profile.model : undefined);
  const effort = asked.effort ?? (same && profile.effort !== null && isEffortFor(cli, profile.effort) ? profile.effort : undefined);
  // A room central's worker goes into its own room (openWorker files it there when none is named).
  const roomId = asked.roomId ?? (ctx.central.kind === 'room' ? undefined : (profile.roomId ?? undefined));
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(roomId === undefined ? {} : { roomId }),
  };
}

/** The task of `firstTask`, recorded on the new card: its id and state, or why it was not started. */
function startFirstTask(ctx: ToolContext, card: Session, task: string): { taskId: string | null; taskState: string | null; refusal: ToolError | null } {
  try {
    ctx.mayDrive(card);
    const t = ctx.ledger.create({ central: ctx.central, session: card, task });
    return { taskId: t.taskId, taskState: t.state, refusal: null };
  } catch (err) {
    if (err instanceof ToolError) return { taskId: null, taskState: null, refusal: err };
    throw err;
  }
}

const sessionCreate: ToolDef = defineTool({
  name: 'session_create',
  toolset: 'sessions',
  title: 'Open a session',
  description:
    'Opens a new Claude or Codex session of your own in a project folder, and files it into a room. What you leave ' +
    'out (model, effort, room) is copied from the folder’s newest session; a room central’s session always goes into ' +
    'its own room. Never looser than your own permission mode; at most 8 of your own open, 10 opens a minute. A title ' +
    'is plain words: no shell syntax, quotes, wildcards or line breaks, and no word starting with a dash (INVALID ' +
    'otherwise); the default one is cleaned of those. With firstTask, AASC hands it that task once it has started and ' +
    'gives the task id: task_wait for the answer.',
  risk: 'write',
  phase: 3,
  input: {
    agent: z.enum(['claude', 'codex']).describe('The CLI the session runs.'),
    folder: z.string().min(1).max(4_096).describe('The project folder (absolute or ~/…; project_resolve lists them).'),
    model: z.string().min(1).max(100).optional().describe('The model it starts with, as the CLI takes it.'),
    effort: z.string().min(1).max(20).optional().describe('Its effort (Claude: low … max, ultracode; Codex: minimal … xhigh).'),
    permissionMode: z.string().min(1).max(40).optional().describe('plan, default, acceptEdits, auto, dontAsk or bypassPermissions; never looser than yours. Claude only.'),
    title: z.string().min(1).max(500).optional().describe('Its title, plain words (by default the first task’s words, else the folder’s name).'),
    room: z.string().min(1).max(200).optional().describe('The room to file it into, by id or exact name.'),
    firstTask: z.string().min(1).max(TASK_TEXT_MAX).optional().describe('A task to hand it once it has started (at most 60 000 characters).'),
  },
  async run(args, ctx) {
    if (args.firstTask !== undefined) {
      if (args.firstTask.trim() === '') throw new ToolError('INVALID', 'A task needs some text.', 'Say what the session should do.');
      assertNotShellLine(args.firstTask);
    }
    const deps = openWorkerDepsFor(ctx);
    const roomId = args.room === undefined ? undefined : namedRoom(ctx, args.room);
    const settings = await fromProfile(ctx, args.folder, deps.home, args.agent, {
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.effort === undefined ? {} : { effort: args.effort }),
      ...(roomId === undefined ? {} : { roomId }),
    });
    const title = args.title ?? (args.firstTask !== undefined ? shortTitle(args.firstTask) : cleanTitle(basename(args.folder)));
    const w = await openWorker(
      ctx,
      {
        cli: args.agent,
        folder: args.folder,
        title,
        ...settings,
        ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
      },
      deps,
    );
    const notes: ActivityNote[] = [openedWorkerNote(w)];
    const task = args.firstTask === undefined ? null : startFirstTask(ctx, newWorkerCard(ctx, w), args.firstTask);
    if (task?.taskId) notes.push({ summary: `Delegated ${task.taskId} to its new session.`, targetSessionId: w.terminalId, taskId: task.taskId });
    if (task?.refusal) notes.push({ summary: `First task not started (${task.refusal.code}).`, targetSessionId: w.terminalId, outcome: 'refused' });

    const data = {
      sessionId: w.sessionId,
      terminalId: w.terminalId,
      shortId: shortIdOf(w.sessionId),
      folder: w.folder,
      cli: w.cli,
      model: w.model,
      effort: w.effort,
      permissionMode: w.permissionMode,
      roomId: w.roomId,
      filed: w.filed,
      note: w.note,
      taskId: task?.taskId ?? null,
      taskState: task?.taskState ?? null,
      taskError: task?.refusal ? { code: task.refusal.code, message: task.refusal.message, hint: task.refusal.hint ?? null } : null,
    };
    const opened = `Opened a ${w.cli} session of your own, ${shortIdOf(w.sessionId)}; it is starting.`;
    const room = w.roomId === null ? '' : w.filed ? ' Filed into its room.' : ` Room: ${w.note ?? 'not filed'}.`;
    const follow =
      task === null
        ? ''
        : task.taskId !== null
          ? ` Task ${task.taskId} waits for it to start, then AASC types it in; call task_wait with ids ["${task.taskId}"] for the answer.`
          : ` The first task was not started (${task.refusal?.code}): ${task.refusal?.message}`;
    return { data, summary: `${opened}${room}${follow}`, activity: notes };
  },
});

export const sessionCreateTools: readonly ToolDef[] = [sessionCreate];
