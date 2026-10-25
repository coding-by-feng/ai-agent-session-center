// tools/keys.ts — the prompts toolset's key tools (P3, Task 13): `key_send` presses one safe key in a session's terminal,
// `terminal_clear` empties a terminal's output. Both call the routes of server/sessionKeysRouter.ts through the loopback
// client, which answer this Mac only.
//
// key_send exists for the menus a CLI shows that no hook reports (a bare `/review` opens Codex's preset menu). Its
// keys are `KEY_BYTES` by name only (esc, enter, tab, up, down, 1–9); the route types the bytes. There is no ctrl-c
// (Ruling P3-11: a second one ends the CLI). Before the route, the steering rails (`ctx.mayDrive`, the lock of the
// central's own task in that session let through, as request_answer does) and the start rule (`startPending`: a card
// that has not reported that it started may be showing its trust question, Ruling P4-58), which the central reads as
// UNAVAILABLE: it passes once the card starts (as queue_put's start rule, finding D-M5). The route then refuses esc
// mid-turn, an answering key while a dialog is open, any other key when no menu is known open (a dialog AASC tracks,
// or the mark command_run sets when it types Codex's `/review`, server/mcp/menuMark.ts, used up by the first enter,
// digit or esc it lets through) and a second esc within 2 s on a card with neither (finding D-I1, ruling P3-37). Those reach the central as INVALID with fixed hints: waiting does not make
// such a key right, opening a menu first does.
// terminal_clear goes through the full rails too: it changes what the person sees in that terminal.

import { z } from 'zod';
import { startPending } from '../../heardTerminals.js';
import { KEY_NAMES } from '../../sessionKeysRouter.js';
import type { Session } from '../../../src/types/session.js';
import type { InternalResponse } from '../client.js';
import { NOT_STARTED_ERROR, NOT_STARTED_HINT } from '../ledgerReroute.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';

/** A task that has not ended. */
const OPEN_TASK: ReadonlySet<string> = new Set(['queued', 'sent', 'running', 'blocked', 'stalled']);

/** The id of the central's own open task in this session (or its terminal, which a re-key keeps), else null. */
function ownOpenTask(ctx: ToolContext, session: Session): string | null {
  const terminal = session.terminalId ?? null;
  const own = ctx.ledger
    .list()
    .find((t) => OPEN_TASK.has(t.state) && (t.sessionId === session.sessionId || (terminal !== null && t.terminalId === terminal)));
  return own?.taskId ?? null;
}

const notStarted = (): ToolError => new ToolError('UNAVAILABLE', NOT_STARTED_ERROR, NOT_STARTED_HINT);

/** The keys route's 409s, in fixed words. */
const KEY_REFUSALS: Readonly<Record<string, () => ToolError>> = {
  not_started: notStarted,
  agent_not_running: () =>
    new ToolError('INVALID', 'The agent is not in front of that terminal: a key would reach the shell.', 'Ask the person to reconnect the session.'),
  mid_turn: () =>
    new ToolError('INVALID', 'esc is not pressed while the session works or shows a dialog.', 'Do not press it: that would interrupt the turn. Wait for it with session_wait.'),
  awaiting_answer: () =>
    new ToolError('INVALID', 'The session shows a dialog: a digit, enter or tab would answer it.', 'Look at it with request_list and answer it with request_answer; the person answers what you may not.'),
  no_menu: () =>
    new ToolError(
      'INVALID',
      'The session shows no menu AASC knows is open: on its prompt, up and enter would replay an earlier prompt, and enter would send the person’s draft.',
      'Keys answer a dialog request_list shows, or the menu command_run opened with review, until the first enter, digit or esc there. Send words with prompt_send.',
    ),
  double_esc: () =>
    new ToolError(
      'INVALID',
      'A second esc this soon on a session with no menu open would open rewind.',
      'Do not press it again; watch the session with session_get or terminal_read.',
    ),
};

/** A key or clear route's refusal as a central reads it. */
function keyRouteFailure(r: InternalResponse<unknown>): ToolError {
  const error = isRecord(r.data) && typeof r.data.error === 'string' ? r.data.error : '';
  const refusal = r.status === 409 ? KEY_REFUSALS[error] : undefined;
  if (refusal !== undefined) return refusal();
  if (r.status === 404) return new ToolError('NOT_FOUND', 'AASC has no terminal for that session now.', 'Call session_list for the sessions you can reach.');
  if (r.status === 403) return new ToolError('DENIED', 'Keys and clears are pressed from this Mac only.', 'Tell the person; this should not happen for a central.');
  if (r.status === 400) return new ToolError('INVALID', 'That key is not one AASC presses.', 'Pass esc, enter, tab, up, down or a digit 1 to 9.');
  unwrap(r);
  return new ToolError('UPSTREAM', 'AASC answered in a way it should not.', 'Try it once more.');
}

const keySend = defineTool({
  name: 'key_send',
  toolset: 'prompts',
  title: 'Press a key in a session',
  description:
    'Presses one key in a session’s terminal, for a menu its CLI shows that request_list does not (a bare /review ' +
    'in Codex opens its preset menu): esc, enter, tab, up, down, or a digit 1 to 9. There is no ctrl-c: a second ' +
    'one ends the CLI. Keys other than esc go only to a menu AASC knows is open: a dialog AASC tracks, or the menu ' +
    'command_run opened with Codex’s review in an idle session. That menu stays known open, while the session is ' +
    'not mid-turn, until the first enter, digit or esc in it ' +
    '(each picks, confirms or closes it; up, down and tab keep it), a hook more than 5 s after it was typed, or ' +
    '60 s; otherwise keys are refused (on the prompt, up and enter would replay an earlier prompt). esc is refused mid-turn ' +
    '(working, prompting, approval, input): that would interrupt the turn; with no menu known open, a second esc ' +
    'within 2 s is refused: it would open rewind. ' +
    '1 to 9, enter and tab are refused while a dialog AASC tracks is open: answer it with request_answer, which never ' +
    'sends allow_always. Every key is refused on a card that has not started (its first question, such as trusting ' +
    'the folder, is the person’s). A session a person drove in the last minute, or that is hands-off, is refused; ' +
    'the session of your own open task can be keyed.',
  risk: 'steers',
  phase: 3,
  input: {
    id: SESSION_REF,
    key: z.enum(KEY_NAMES).describe('esc, enter, tab, up, down, or a digit 1 to 9.'),
  },
  async run(args, ctx) {
    const session = resolveTarget(ctx, args.id);
    const ownTask = ownOpenTask(ctx, session);
    ctx.mayDrive(session, ownTask === null ? undefined : { ownTaskId: ownTask });
    if (startPending(session)) throw notStarted();
    const answer = await ctx.client.post(`/sessions/${seg(session.sessionId)}/keys`, { key: args.key });
    if (!answer.ok) throw keyRouteFailure(answer);
    const ref = refOf(ctx)(session.sessionId);
    return {
      data: { id: session.sessionId, shortId: shortIdOf(session.sessionId), key: args.key, sent: true },
      summary: `Pressed ${args.key} in ${ref}. Watch the session (session_get, terminal_read) for what it did.`,
      activity: [{ summary: `Pressed ${args.key}.`, targetSessionId: session.sessionId, detail: { key: args.key } }],
    };
  },
});

const terminalClear = defineTool({
  name: 'terminal_clear',
  toolset: 'prompts',
  title: 'Clear a session’s terminal output',
  description:
    'Clears the output of a session’s terminal, as the toolbar’s Clear output does, on every device that shows it. ' +
    'Nothing is typed and the session goes on. The same rails as a prompt: a session a person drove in the last ' +
    'minute, or that is hands-off, is refused, and so are a central, an ops shell, a subagent and an external card.',
  risk: 'write',
  phase: 3,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const session = resolveTarget(ctx, args.id);
    ctx.mayDrive(session);
    const terminalId = session.terminalId;
    if (!terminalId) throw new ToolError('INVALID', 'That session has no terminal.', 'Pick another session.');
    const answer = await ctx.client.post(`/terminals/${seg(terminalId)}/clear`);
    if (!answer.ok) throw keyRouteFailure(answer);
    const ref = refOf(ctx)(session.sessionId);
    return {
      data: { id: session.sessionId, shortId: shortIdOf(session.sessionId), terminalId, cleared: true },
      summary: `Cleared the terminal output of ${ref}.`,
      activity: [{ summary: 'Cleared a terminal’s output.', targetSessionId: session.sessionId }],
    };
  },
});

export const keyTools: readonly ToolDef[] = [keySend, terminalClear];
