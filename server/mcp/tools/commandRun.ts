// tools/commandRun.ts — `command_run` (the prompts toolset, P2): run a slash command or a skill in one session.
//
// What may be run is an allow-list, and it is the whole of this tool's safety (prompt_send refuses any text that starts
// as a slash command, so there is no way round it):
//   * a command or skill of that session's catalog (`GET /commands` for its CLI and folder: the project's, the person's,
//     a plugin's, and the skills Codex preinstalls, which the catalog files as built-in), by the name command_list shows
//     it under, with or without its `/` or `$`;
//   * the safe built-ins `compact`, `model` and `effort`, whether or not the catalog lists them; `model` and `effort`
//     only with their choice (`/model sonnet`: bare, they open a picker that would catch the next prompt);
//   * the run-only built-ins `review` (Codex) and `code-review` (Claude), when the catalog lists them (Ruling P3-16),
//     `review` typed bare, `code-review` with exactly one level (low, medium, high, xhigh, max: bare, it reuses the
//     person's last level, which may be ultra; never `ultra` or a `--` option; finding D-I2, ruling P3-37). A bare
//     `/review` opens Codex's preset menu, which the central answers with key_send: typing it marks the terminal's
//     menu known open (menuMark.ts, finding D-I1), which the keys route needs for any key but esc; only when the card
//     is idle as it is sent (mid-turn no menu opens, ruling P3-40). `/code-review` marks nothing. Queued text never holds them (commandRules.ts), because that menu would catch the next queued prompt;
//   * never `clear` (and its aliases `reset`, `new`), `exit` (and `quit`), `logout`, `login`, `permissions`, `hooks`,
//     `mcp` or `config`, whatever a project or a plugin calls its own command, and no other built-in command even though
//     the catalog lists it (`/status`, `/context`, `/cost`, `/delete`, `/rewind`...).
// The words typed are the catalog entry's own (`invokeToken`: `/name`, a plugin's `/plugin:name`, a Codex skill's
// `$name`), never the central's string, and a token that is not one clean word is never typed. The arguments follow it.
// The prompt then goes the way prompt_send's does: the same rails, route and request key (promptSend.ts `sendPrompts`).
// The lists and the catalog filter live in commandRules.ts, which the queue's text check uses too (Ruling 60).

import { z } from 'zod';
import type { CommandEntry } from '../../commandIndex.js';
import {
  catalogEntries, isRunOnlyBuiltin, isUnsafeBuiltin, NEVER_COMMANDS, OPENS_MENU, runOnlyArgsRefusal, SAFE_BUILTINS,
} from '../commandRules.js';
import { markMenuOpen } from '../menuMark.js';
import type { ToolDef } from '../registry.js';
import { toSessionCard } from '../scope.js';
import { ToolError } from '../types.js';
import { displayName, invokeToken, sigilOf } from './commandToken.js';
import { defineTool, refOf, resolveTarget, SESSION_REF, unwrap } from './define.js';
import { sendPrompts } from './promptSend.js';

/** A card at its prompt: `/review` typed now opens its menu (mid-turn it opens none, ruling P3-40). */
const IDLE_STATUS: ReadonlySet<string> = new Set(['idle', 'waiting']);

/** The safe built-ins that open a picker when typed bare: a central sends them with their choice only. */
const NEEDS_CHOICE: ReadonlySet<string> = new Set(['/model', '/effort']);

/** The arguments, cut so the whole text (a name of up to 80 characters, a space, these) fits the route's 65 536. */
const ARGS_MAX = 60_000;

const NAME = /^[/$]?[A-Za-z0-9][A-Za-z0-9_:.-]*$/;

interface Wanted {
  /** The sigil the central wrote, or null when it wrote the name alone. */
  sigil: '/' | '$' | null;
  /** The name as written, without the sigil. */
  bare: string;
}

function parseWanted(name: string): Wanted {
  const first = name[0];
  return first === '/' || first === '$' ? { sigil: first, bare: name.slice(1) } : { sigil: null, bare: name };
}

// ---------------------------------------------------------------------------
// The refusals (AASC's words: they never repeat the name the central wrote)
// ---------------------------------------------------------------------------

const neverRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'A central never runs the commands that clear, end or reconfigure a session (clear, reset, new, exit, quit, login, logout, permissions, hooks, mcp, config).',
    'Ask the person to do that in the session itself; command_list shows the commands and skills you may run.',
  );

const unsafeBuiltinRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'That is a built-in command a central does not run: only compact, model and effort, and review or code-review where the catalog lists them.',
    'command_list shows the commands and skills of the session’s catalog.',
  );

const unknownRefusal = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That command is not in the session’s catalog.',
    'command_list (with its agent and folder) shows the commands and skills it has; the safe built-ins are compact, model and effort.',
  );

const needsChoiceRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'model and effort open a picker when sent bare, and the picker would catch the next prompt.',
    'Give the choice in args: args sonnet, args high.',
  );

const ambiguousRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'That name fits more than one command or skill.',
    'Write it with its sigil, / or $, as command_list shows it in invoke.',
  );

const unknownCliRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'AASC does not know which agent that session runs, so it cannot tell which commands it has.',
    'Commands run in Claude Code and Codex sessions only.',
  );

// ---------------------------------------------------------------------------
// Choosing the command
// ---------------------------------------------------------------------------

/**
 * The words to type for `wanted`. An entry is looked for in three steps, the first that finds any deciding it: its token
 * as written (`/deploy`, `$review`), its name as the catalog shows it (a plugin's is `plugin:name`), its bare name. More
 * than one distinct token in the step is ambiguous (a Codex prompt and a skill of one name); a built-in that is not safe
 * is refused. Not in the catalog: only the safe built-ins are typed.
 */
export function chooseCommand(wanted: Wanted, entries: readonly CommandEntry[]): string {
  const written = `${wanted.sigil ?? ''}${wanted.bare}`;
  const fits = (e: CommandEntry): boolean => wanted.sigil === null || sigilOf(e) === wanted.sigil;
  const steps: Array<(e: CommandEntry) => boolean> = [
    (e) => invokeToken(e) === written,
    (e) => displayName(e) === wanted.bare && fits(e),
    (e) => e.name === wanted.bare && fits(e),
  ];
  for (const step of steps) {
    const hits = entries.filter(step);
    if (hits.length === 0) continue;
    const tokens = [...new Set(hits.map(invokeToken))];
    if (tokens.length > 1) throw ambiguousRefusal();
    if (hits.some((e) => isUnsafeBuiltin(e) && !isRunOnlyBuiltin(e))) throw unsafeBuiltinRefusal();
    return tokens[0];
  }
  const builtin = wanted.bare.toLowerCase();
  if (SAFE_BUILTINS.has(builtin) && wanted.sigil !== '$') return `/${builtin}`;
  throw unknownRefusal();
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const commandRun: ToolDef = defineTool({
  name: 'command_run',
  toolset: 'prompts',
  title: 'Run a command or skill in a session',
  description:
    'Runs a slash command or skill in one session: one from its catalog (command_list shows them; give the name as ' +
    'listed, with or without its / or $), or a safe built-in: compact, model, effort. review (Codex) and code-review ' +
    '(Claude) run when the session’s catalog lists them. review is typed bare; code-review needs exactly one level ' +
    'in args: low, medium, high, xhigh or max (bare, it reuses the person’s last level, which may be ultra). Never ' +
    'ultra and no -- option (--comment, --post, --fix): those are the person’s. A bare /review sent to an idle ' +
    'session opens Codex’s preset menu (mid-turn it opens none): answer it with key_send (up, down, then enter), ' +
    'which AASC lets into that menu (data.menuKnownOpen) while the session is not mid-turn, until ' +
    'the first enter, digit or esc, a hook more than 5 s after it was typed, or 60 s; code-review opens none. ' +
    'Never clear, reset, new, exit, quit, login, logout, permissions, hooks, mcp or ' +
    'config, and no other built-in command. args goes after the name ' +
    '(model and effort need their choice: args sonnet, args high). It is typed the way a Claude command (/name) or a ' +
    'Codex skill ($name) is, through the same rails and route as prompt_send; prompt_status with the key says how ' +
    'the typing ended.',
  risk: 'steers',
  phase: 2,
  input: {
    id: SESSION_REF,
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(NAME, 'One word: a command or skill name, with its / or $ if you like.')
      .describe('The command or skill, as command_list shows it (name or invoke), or a safe built-in.'),
    args: z.string().max(ARGS_MAX).optional().describe('What goes after the name (at most 60 000 characters).'),
  },
  async run(args, ctx) {
    const wanted = parseWanted(args.name);
    if (NEVER_COMMANDS.has(wanted.bare.toLowerCase())) throw neverRefusal();
    const session = resolveTarget(ctx, args.id);
    const card = toSessionCard(session, []);
    if (card.cli === null) throw unknownCliRefusal();
    const query = { cli: card.cli, ...(card.project === null ? {} : { projectPath: card.project }) };
    const entries = catalogEntries(unwrap<unknown>(await ctx.client.get('/commands', query)));
    const token = chooseCommand(wanted, entries);
    const runOnly = entries.some((e) => isRunOnlyBuiltin(e) && invokeToken(e) === token);
    const runOnlyRefusal = runOnly ? runOnlyArgsRefusal(token.slice(1), args.args) : null;
    if (runOnlyRefusal !== null) throw runOnlyRefusal;
    const bare = args.args === undefined || args.args.trim() === '';
    if (bare && NEEDS_CHOICE.has(token.toLowerCase())) throw needsChoiceRefusal();
    const text = bare ? token : `${token} ${runOnly ? args.args?.trim() : args.args}`;
    const outcome = await sendPrompts(ctx, {
      refs: [args.id],
      text,
      images: [],
      mode: 'now',
      tookWords: `Ran ${token}.`,
    });
    const [r] = outcome.results;
    const terminalId = session.terminalId ?? '';
    const opensMenu = runOnly && OPENS_MENU.has(token.slice(1).toLowerCase()) && IDLE_STATUS.has(session.status);
    const menuKnownOpen = opensMenu && r.accepted && terminalId !== '';
    if (menuKnownOpen) markMenuOpen(terminalId, ctx.now());
    const ref = refOf(ctx)(session.sessionId);
    return {
      data: {
        id: r.sessionId,
        shortId: r.shortId,
        command: token,
        key: r.key,
        accepted: r.accepted,
        code: r.code,
        reason: r.reason,
        error: r.error,
        hint: r.hint,
        menuKnownOpen,
      },
      summary: r.accepted
        ? `Ran ${token} in ${ref} (key ${r.key}): AASC is typing it. prompt_status with that key says how the typing ended; a slash command is not confirmed, so watch the session for its effect.${menuKnownOpen ? ' If it shows a menu, key_send answers it until the first enter, digit or esc, a hook more than 5 s later, or 60 s.' : ''}`
        : `Not run in ${ref}: ${r.error} ${r.hint ?? ''}`.trim(),
      activity: outcome.notes,
    };
  },
});
