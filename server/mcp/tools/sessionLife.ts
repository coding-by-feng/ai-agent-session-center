// tools/sessionLife.ts — relaunching a card (the sessions toolset, P3, Ruling P3-8): resume and reconnect bring an ended
// card back in place; fork and clone open a new session from one, which becomes the central's own worker.
//
// The rails, in order:
//   1. the card: `resolveTarget` (a history id with no card is NOT_FOUND, and the hint says to resume it from History
//      in AASC, Ruling P3-9); then resume and reconnect ask `ctx.mayRelaunch` (scope, kind, ended only, hands-off, the
//      person and the lock), fork and clone `ctx.mayEdit(card, { asSource: true })` (scope and kind only: the source
//      card is left as it is);
//   2. the stored commands (relaunchRule.ts, Rulings P3-8 and P3-23): every route here types the card's stored command
//      again, or a line built from it, and that command is the `ps` args, where a title's words are loose words. So
//      each one a route may type must be a bare claude or codex with no shell syntax and only the flags AASC's own
//      builders launch with, judged as the route types it: a Claude line's name rebuilt from the card's title
//      (`relaunchLineOf`, Ruling P3-36). Resume is held to it too: its route types a stored command that is neither CLI
//      as it was stored;
//   3. `openThroughRoute` (openWorker.ts): the folder rules on the folder the route opens in (the SSH config's
//      workingDir when the card has an SSH user, as every AASC-launched card does, else its folder) and on the card's
//      own folder too (Ruling P3-24), the permission cap on the mode the card would relaunch in (permissionCap.ts
//      `effectiveModeOf`: the looser of the card's mode and its commands') set against the central's own card, the plan
//      window, then the budgets. Fork and clone are `own` (8 live, 10 a minute; they become the central's workers,
//      recorded in the folder that opens); resume and reconnect count against the minute's opens only.
//
// A resume never types into a terminal that is still open (C-M7): the route answers a central TERMINAL_OPEN instead,
// and the tool says UNAVAILABLE. A fork's title passes the title rule (titleRule.ts): an explicit one is refused, and so
// is a fork or a clone of a card whose own title fails it, because those routes type `-n "Fork of <title>"` /
// `-n "Clone of <title>"` into the new card's command, and `ps` stores those words back loose.
//
// No POST carries a body: the routes read the card, and the cap is read from the cards, never from a request.
// `data` is `{ sourceSessionId, terminalId, newTerminal, own }`; the words never repeat a title or a command.

import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import type { ActivityNote } from '../activity.js';
import type { InternalResponse } from '../client.js';
import { openThroughRoute } from '../openWorker.js';
import { effectiveModeOf } from '../permissionCap.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { RELAUNCH_REFUSAL, relaunchCommandRefusal, relaunchLineOf, storedCommandsOf, TERMINAL_OPEN_CODE } from '../relaunchRule.js';
import { shortIdOf, toSessionCard } from '../scope.js';
import { titleRefusal } from '../titleRule.js';
import { ToolError, type CliKind } from '../types.js';
import { openWorkerDepsFor } from '../workerDeps.js';
import { defineTool, isRecord, refOf, resolveTarget, seg, SESSION_REF } from './define.js';

/** What every relaunch's description says of the rules it applies (Ruling 65). */
const KIND_RULE = 'Never a hands-off session (resume, reconnect), another central or your own, an AI popup, an external or an SSH session.';
const COMMAND_RULE =
  'Only a session started as a bare claude or codex command with no flags but the ones AASC launches with (model, ' +
  'effort, permission mode, resume, a one-word or quoted name, which AASC rebuilds from the session’s title; Codex’s ' +
  'sandbox and approval) and no other words, never looser than your own permission mode ' +
  '(the session’s mode and its stored command’s, set against your own card’s), and only when both the folder it ' +
  'works in and the folder it opens in are in your scope.';
const OWN_RULE = 'The new session is one of your own sessions (at most 8 open, 10 opens a minute).';
const HISTORY_HINT = 'A history id is not a card: resume it from History in AASC, or call session_list for the card ids.';

/** The card `id` names; for a resume, a miss says where a history row is resumed instead. */
function cardFor(ctx: ToolContext, id: string, history: boolean): Session {
  try {
    return resolveTarget(ctx, id);
  } catch (err) {
    if (history && err instanceof ToolError && err.code === 'NOT_FOUND') throw new ToolError('NOT_FOUND', err.message, HISTORY_HINT);
    throw err;
  }
}

/**
 * INVALID unless every stored command a route may type for the card passes the relaunch rule, as the route types it
 * (its name rebuilt from the card's title); never repeating one. session_restart (sessionEnd.ts) asks the same.
 */
export function assertBareCommand(s: Session, hint = 'Ask the person to relaunch it in AASC, or pick another session.'): void {
  if (storedCommandsOf(s).some((command) => relaunchCommandRefusal(relaunchLineOf(command, s.title)) !== null)) {
    throw new ToolError('INVALID', RELAUNCH_REFUSAL, hint);
  }
}

/** The CLI the card runs; INVALID when AASC does not know it. */
export function cliOf(s: Session, hint = 'Only Claude Code and Codex sessions are relaunched.'): CliKind {
  const cli = toSessionCard(s, []).cli;
  if (cli === null) throw new ToolError('INVALID', 'AASC does not know which agent that session runs.', hint);
  return cli;
}

interface Relaunch {
  /** The route under /sessions/:id/. */
  route: 'resume' | 'reconnect-terminal' | 'fork' | 'clone';
  own: boolean;
}

/**
 * The folder a relaunch route opens the card in (apiRouter.ts: the SSH config's workingDir, or home, when the card has
 * an SSH user; its folder otherwise), and the card's own folder when that is another. session_restart opens there too.
 */
export function foldersOf(s: Session): { folder: string; alsoJudged: string[] } {
  const cfg = s.sshConfig;
  if (!cfg?.username) return { folder: s.projectPath, alsoJudged: [] };
  const opens = cfg.workingDir || '~';
  return { folder: opens, alsoJudged: opens === s.projectPath ? [] : [s.projectPath] };
}

/** The route's answer that the card's terminal is still open (resume only). */
function terminalStillOpen(res: InternalResponse<unknown>): boolean {
  return res.status === 409 && isRecord(res.data) && res.data.code === TERMINAL_OPEN_CODE;
}

/** The checks every open passes, then the route; answers what was opened. */
async function relaunch(ctx: ToolContext, s: Session, r: Relaunch): Promise<{ terminalId: string; newTerminal: boolean }> {
  const call = async (): Promise<InternalResponse<unknown>> => {
    const res = await ctx.client.post(`/sessions/${seg(s.sessionId)}/${r.route}`);
    if (terminalStillOpen(res)) {
      throw new ToolError(
        'UNAVAILABLE',
        'That session’s terminal is still open, so AASC does not type a resume into it for a central.',
        'Ask the person, or close its terminal first.',
      );
    }
    return res;
  };
  return openThroughRoute(ctx, { cli: cliOf(s), ...foldersOf(s), own: r.own, mode: effectiveModeOf(s), call }, openWorkerDepsFor(ctx));
}

/** The answer of a relaunch: the ids in `data`, AASC's words in the summary and the row. */
function answer(
  ctx: ToolContext,
  s: Session,
  opened: { terminalId: string; newTerminal: boolean },
  own: boolean,
  words: { summary: string; row: string },
  extra: Record<string, unknown> = {},
): ToolResult {
  const note: ActivityNote = own
    ? { summary: words.row, targetSessionId: opened.terminalId, detail: { sourceSessionId: s.sessionId } }
    : { summary: words.row, targetSessionId: s.sessionId, detail: { terminalId: opened.terminalId } };
  return {
    data: { sourceSessionId: s.sessionId, terminalId: opened.terminalId, newTerminal: opened.newTerminal, own, ...extra },
    summary: words.summary,
    activity: [note],
  };
}

// ---------------------------------------------------------------------------
// session_resume, session_reconnect
// ---------------------------------------------------------------------------

const sessionResume = defineTool({
  name: 'session_resume',
  toolset: 'sessions',
  title: 'Resume an ended session',
  description:
    'Resumes an ended session in place: AASC opens a new terminal for it and types its resume line there, and the ' +
    'card carries on with its conversation; never into a terminal that is still open (UNAVAILABLE: ask the person, or ' +
    'close it first). Ended sessions only; not within a minute of the person driving it, nor ' +
    `while a central’s task holds it. ${KIND_RULE} ${COMMAND_RULE} It counts against your 10 opens a minute and stays ` +
    'the person’s session, not one of yours. Takes a card id from session_list: a history id is not a card (resume it ' +
    'from History in AASC).',
  risk: 'write',
  phase: 3,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = cardFor(ctx, args.id, true);
    ctx.mayRelaunch(s);
    assertBareCommand(s);
    const opened = await relaunch(ctx, s, { route: 'resume', own: false });
    const ref = refOf(ctx)(s.sessionId);
    const where = opened.newTerminal ? `in a new terminal, ${shortIdOf(opened.terminalId)}` : 'in its terminal';
    return answer(ctx, s, opened, false, {
      summary: `Resuming session ${ref} ${where}; session_wait or session_get shows when it is back.`,
      row: 'resumed a session',
    });
  },
});

const sessionReconnect = defineTool({
  name: 'session_reconnect',
  toolset: 'sessions',
  title: 'Reconnect an ended session',
  description:
    'Reconnects an ended session: AASC opens a new terminal for its card and starts it with the command it was ' +
    'started with. Ended sessions only, and only one AASC knows the start command of; not within a minute of the ' +
    `person driving it, nor while a central’s task holds it. ${KIND_RULE} ${COMMAND_RULE} It counts against your 10 ` +
    'opens a minute and stays the person’s session, not one of yours.',
  risk: 'write',
  phase: 3,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = cardFor(ctx, args.id, false);
    ctx.mayRelaunch(s);
    // The route's own condition (apiRouter.ts reconnect-terminal), asked before the minute's budget is spent.
    if (s.source !== 'ssh' && !s.startupCommand) {
      throw new ToolError('INVALID', 'AASC does not know the command that session was started with.', 'Use session_resume, or ask the person.');
    }
    assertBareCommand(s);
    // The route always opens a new PTY (its answer does not say so, as resume's does).
    const opened = { ...(await relaunch(ctx, s, { route: 'reconnect-terminal', own: false })), newTerminal: true };
    return answer(ctx, s, opened, false, {
      summary: `Reconnecting session ${refOf(ctx)(s.sessionId)} in a new terminal, ${shortIdOf(opened.terminalId)}.`,
      row: 'reconnected a session',
    });
  },
});

// ---------------------------------------------------------------------------
// session_fork, session_clone
// ---------------------------------------------------------------------------

/**
 * INVALID when the card's own title fails the title rule: the fork and clone routes type `-n "Fork of <title>"` /
 * `-n "Clone of <title>"` (or the folder's name) into the new card's command, where it would be stored back as loose
 * words. Never repeating the title.
 */
function assertCopyableTitle(s: Session, copy: 'fork' | 'clone'): void {
  if (titleRefusal(s.title || s.projectName) !== null) {
    throw new ToolError(
      'INVALID',
      `This session’s title holds characters a ${copy} would carry into its command.`,
      'Ask the person to rename it, or rename it with session_set_title first.',
    );
  }
}

/** What fork's and clone's descriptions say of that rule (Ruling 65). */
const SOURCE_TITLE_RULE = (copy: 'forked' | 'cloned'): string =>
  `A session whose own title breaks the title rule (shell syntax, quotes, wildcards, line breaks or a word starting ` +
  `with a dash) is not ${copy} (INVALID): rename it with session_set_title first, or ask the person.`;

/** Sets the new fork's title; false when the route refused it (the fork is open all the same). */
async function titleFork(ctx: ToolContext, terminalId: string, title: string): Promise<boolean> {
  const r = await ctx.client.put(`/sessions/${seg(terminalId)}/title`, { title });
  return r.ok;
}

const sessionFork = defineTool({
  name: 'session_fork',
  toolset: 'sessions',
  title: 'Fork a session',
  description:
    'Forks a session: a new session in the same folder that starts from its conversation so far, and goes its own ' +
    'way from there. The source is left as it is, so it may be running or hands-off. ' +
    `${OWN_RULE} Never another central or your own, an AI popup, an external or an SSH session. ${COMMAND_RULE} ` +
    'With title, the new session’s card gets that title: plain words, with no shell syntax, quotes, wildcards or line ' +
    'breaks and no word starting with a dash (INVALID otherwise). Without one it is "Fork of" the source’s title. ' +
    SOURCE_TITLE_RULE('forked'),
  risk: 'write',
  phase: 3,
  input: { id: SESSION_REF, title: z.string().min(1).max(500).optional().describe('The new session’s title (1–500 characters, plain words).') },
  async run(args, ctx) {
    if (args.title !== undefined) {
      const bad = titleRefusal(args.title);
      if (bad !== null) throw new ToolError('INVALID', bad, 'Give a title of plain words, or leave it out.');
    }
    const s = cardFor(ctx, args.id, false);
    ctx.mayEdit(s, { asSource: true });
    // The title first: an unsafe one also fails the command rule (it is typed into the rebuilt name), and these words
    // say what to do about it.
    assertCopyableTitle(s, 'fork');
    assertBareCommand(s);
    const opened = await relaunch(ctx, s, { route: 'fork', own: true });
    const titled = args.title === undefined ? null : await titleFork(ctx, opened.terminalId, args.title);
    const named = titled === false ? ' AASC could not set its title.' : '';
    return answer(
      ctx,
      s,
      opened,
      true,
      {
        summary: `Forked session ${refOf(ctx)(s.sessionId)} into one of your own, ${shortIdOf(opened.terminalId)}; it is starting.${named}`,
        row: 'forked a session into one of its own',
      },
      titled === null ? {} : { titled },
    );
  },
});

const sessionClone = defineTool({
  name: 'session_clone',
  toolset: 'sessions',
  title: 'Clone a session',
  description:
    'Clones a session: a new session in the same folder started with the same command, model and effort, and a ' +
    'fresh conversation. The source is left as it is, so it may be running or hands-off. ' +
    `${OWN_RULE} Never another central or your own, an AI popup, an external or an SSH session. ${COMMAND_RULE} ` +
    `Its title is "Clone of" the source’s title. ${SOURCE_TITLE_RULE('cloned')}`,
  risk: 'write',
  phase: 3,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = cardFor(ctx, args.id, false);
    ctx.mayEdit(s, { asSource: true });
    // The title first: an unsafe one also fails the command rule (it is typed into the rebuilt name), and these words
    // say what to do about it.
    assertCopyableTitle(s, 'clone');
    assertBareCommand(s);
    const opened = await relaunch(ctx, s, { route: 'clone', own: true });
    return answer(ctx, s, opened, true, {
      summary: `Cloned session ${refOf(ctx)(s.sessionId)} into one of your own, ${shortIdOf(opened.terminalId)}; it is starting.`,
      row: 'cloned a session into one of its own',
    });
  },
});

export const lifeTools: readonly ToolDef[] = [sessionResume, sessionReconnect, sessionFork, sessionClone];
