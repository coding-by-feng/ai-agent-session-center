// commandRules.ts — which slash commands a central may have typed into a session, in one place, for the two ways its
// words reach a CLI as a command: `command_run` (tools/commandRun.ts) and the text a central queues — a prompt, a chain
// step, the resume prompt — which the window's scheduler types as stored (Ruling 60).
//
// The rule is command_run's allow-list: never the commands that clear, end or reconfigure a session; of the CLIs'
// built-ins only compact, model and effort, those two with their choice (bare, they open a picker that catches the next
// prompt); anything else only when the session's catalog (`GET /commands`) holds it. `review` (Codex) and `code-review`
// (Claude) are run-only built-ins (Ruling P3-16): command_run runs them when the catalog lists them, and queued text
// never does, because bare `/review` opens a menu that would catch the next queued prompt. command_run types `review`
// bare and `code-review` with exactly one level of `CODE_REVIEW_LEVELS` (finding D-I2, ruling P3-37): `ultra` starts a
// billed cloud review that uploads the branch, bare `code-review` reuses the person's last level (which may be ultra),
// `--comment`/`--post` post to GitHub as the person and `--fix` edits the tree, so anything else is refused
// (`runOnlyArgsRefusal`). Only `review` opens a menu a central answers with key_send (`OPENS_MENU`). Queued text is typed as the central
// wrote it, not as a catalog token, so it must be the token exactly: the CLI's slash menu completes a name it does not
// know to one it does, and a near miss (`/logou`) would run as the command it becomes.
//
// Pure: the caller fetches the catalog. Refusals are AASC's words and never repeat the text.

import { BUILTIN_COMMAND_NAMES, type CommandEntry } from '../commandIndex.js';
import { invokeToken } from './tools/commandToken.js';
import { ToolError } from './types.js';

/** Commands a central never runs (with the CLIs' own aliases: `/reset` and `/new` clear, `/quit` exits). */
export const NEVER_COMMANDS: ReadonlySet<string> = new Set([
  'clear',
  'reset',
  'new',
  'exit',
  'quit',
  'logout',
  'login',
  'permissions',
  'hooks',
  'mcp',
  'config',
]);

/** The built-ins a central may run, even when the catalog does not list them. */
export const SAFE_BUILTINS: ReadonlySet<string> = new Set(['compact', 'model', 'effort']);

/**
 * The built-ins command_run runs when the session's catalog lists them, and queued text never does (Ruling P3-16):
 * Codex's `/review` (bare, it opens its preset menu, which the central answers with key_send) and Claude's
 * `/code-review`. `queuedCommandVerdict` and `catalogRefusal` leave them unsafe.
 */
export const RUN_ONLY_BUILTINS: ReadonlySet<string> = new Set(['review', 'code-review']);

/** The one argument `/code-review` may take from a central: its level. Never `ultra`, never a `--` option. */
export const CODE_REVIEW_LEVELS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The run-only built-ins whose menu a central answers with key_send: command_run marks it open (menuMark.ts). */
export const OPENS_MENU: ReadonlySet<string> = new Set(['review']);

/** The safe built-ins that open a picker when typed bare. */
const NEEDS_CHOICE: ReadonlySet<string> = new Set(['model', 'effort']);

/**
 * What the CLI's input drops or skips around a word: whitespace and every format character (`\p{Cf}`: zero-width
 * spaces and joiners, U+2060, U+FEFF, soft hyphen, bidi marks, invisible operators). Not a fixed list (Ruling P4-49 N3).
 */
const WORD_END = /[\s\p{Cf}]/u;
const WORD_END_ALL = /[\s\p{Cf}]/gu;

/** The run of whitespace and format characters before the first word, which the CLI skips. */
const LEADING_RUN = /^[\s\p{Cf}]+/u;

/** Text without its leading run of whitespace and format characters, as the CLI reads where the first word starts. */
export const stripLeadingRun = (text: string): string => text.replace(LEADING_RUN, '');

/** A catalog token the CLI takes as one clean word, with its sigil. */
const CLEAN_TOKEN = /^[/$][A-Za-z0-9][A-Za-z0-9_:.-]*$/;

export interface LeadingCommand {
  /** The name after the `/`, as written. */
  name: string;
  /** Nothing but whitespace follows it. */
  bare: boolean;
}

/** A name the CLI has as a command of its own (never-list or built-in): a word starting with it is never a path (Ruling P4-49 N1). */
const namesCommand = (segment: string): boolean => {
  const name = segment.toLowerCase();
  return NEVER_COMMANDS.has(name) || BUILTIN_COMMAND_NAMES.has(name);
};

/**
 * The slash command `text` starts with, as the CLI reads typed text; null for words, a path or a `$` skill. Any first
 * word that starts with `/` is a command, whatever follows it (`/`, `/_clear`, `/1`, `/éxit`): the name is the whole
 * word, punctuation included (`/clear!` is not `/clear`), because the CLI's slash menu completes a near miss to the
 * command it nearly is, so a name is matched exactly and never cut where a pattern stops (Rulings P4-29, P4-38). The
 * word is a path only when it holds a second `/` and a further character after it (`/Users/me/x.md`; `/clear/` is a
 * command named `clear/`), and never one when its first segment is itself a never-list or built-in command name
 * (`/logout/a` is `/logout`, nearly). The ASCII `/` only: the CLIs key on it, so a full-width one is words.
 */
export function leadingCommand(text: string): LeadingCommand | null {
  const start = stripLeadingRun(text);
  if (!start.startsWith('/')) return null;
  const end = start.search(WORD_END);
  const word = end === -1 ? start : start.slice(0, end);
  const second = word.indexOf('/', 1);
  if (second !== -1 && second < word.length - 1 && !namesCommand(word.slice(1, second))) return null;
  const rest = end === -1 ? '' : start.slice(end);
  return { name: word.slice(1), bare: rest.replace(WORD_END_ALL, '') === '' };
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

const neverRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'A central never queues the commands that clear, end or reconfigure a session (clear, reset, new, exit, quit, login, logout, permissions, hooks, mcp, config).',
    'Ask the person to add that step in AASC.',
  );

const pickerRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'model and effort open a picker when typed bare, and the picker would catch the next prompt.',
    'Give the choice after the name: /model sonnet, /effort high.',
  );

const builtinRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'That is a built-in command a central does not queue: only compact, model and effort.',
    'Queue a command or skill of the session’s catalog, written as command_list shows it in invoke.',
  );

const runOnlyArgsRefusalWords = (): ToolError =>
  new ToolError(
    'INVALID',
    'review is typed bare; code-review takes exactly one level: low, medium, high, xhigh or max (bare, it reuses the person’s last level, which may be ultra). Never ultra, and no -- option.',
    'Run review bare, or code-review with one level. ultra, posting to GitHub and fixing the tree are the person’s to run.',
  );

const unknownRefusal = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That command is not in the session’s catalog as written, and the CLI could complete it to another command.',
    'Write it exactly as command_list shows it in invoke; the safe built-ins are /compact, /model <choice> and /effort <choice>.',
  );

/** For a session whose agent AASC does not know: it has no catalog to look in. */
export const unknownCliRefusal = (): ToolError =>
  new ToolError(
    'INVALID',
    'AASC does not know which agent that session runs, so it cannot tell which commands it has.',
    'Queue plain words, or a safe built-in: /compact, /model <choice>, /effort <choice>.',
  );

// ---------------------------------------------------------------------------
// The verdicts
// ---------------------------------------------------------------------------

/**
 * What the rule says without the session's catalog: a refusal (the never list in any case; model or effort typed bare),
 * `allowed` (a safe built-in as the CLI names it), or `catalog` when only the catalog can tell.
 */
export function queuedCommandVerdict(cmd: LeadingCommand): ToolError | 'allowed' | 'catalog' {
  if (NEVER_COMMANDS.has(cmd.name.toLowerCase())) return neverRefusal();
  if (!SAFE_BUILTINS.has(cmd.name)) return 'catalog';
  return cmd.bare && NEEDS_CHOICE.has(cmd.name) ? pickerRefusal() : 'allowed';
}

/** An entry as the route's answer promises it: a name, a CLI, a kind and a source (a plugin's also its plugin). */
function isCommandEntry(e: unknown): e is CommandEntry {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.name === 'string' &&
    (r.cli === 'claude' || r.cli === 'codex') &&
    (r.kind === 'command' || r.kind === 'skill') &&
    typeof r.source === 'string' &&
    (r.pluginName === undefined || typeof r.pluginName === 'string')
  );
}

/** The catalog's entries a command may be run from (the route's answer is untrusted): well-formed, one clean word. */
export function catalogEntries(body: unknown): CommandEntry[] {
  const list = typeof body === 'object' && body !== null && Array.isArray((body as { entries?: unknown }).entries)
    ? ((body as { entries: unknown[] }).entries)
    : [];
  return list.filter(isCommandEntry).filter((e) => CLEAN_TOKEN.test(invokeToken(e)));
}

/** A built-in command (not a skill: Codex's preinstalled skills are filed as built-in too) that is not safe. */
export const isUnsafeBuiltin = (e: CommandEntry): boolean =>
  e.kind === 'command' && e.source === 'builtin' && !SAFE_BUILTINS.has(e.name.toLowerCase());

/** A run-only built-in command of the catalog (`RUN_ONLY_BUILTINS`): command_run's to run, never queued text's. */
export const isRunOnlyBuiltin = (e: CommandEntry): boolean =>
  e.kind === 'command' && e.source === 'builtin' && RUN_ONLY_BUILTINS.has(e.name.toLowerCase());

/** With the catalog: null when an entry's token is the command exactly as written and it is not an unsafe built-in. */
export function catalogRefusal(cmd: LeadingCommand, entries: readonly CommandEntry[]): ToolError | null {
  const hits = entries.filter((e) => invokeToken(e) === `/${cmd.name}`);
  if (hits.length === 0) return unknownRefusal();
  return hits.some(isUnsafeBuiltin) ? builtinRefusal() : null;
}

/**
 * Why a run-only built-in (named without its `/`) may not be typed with these arguments; null when it may: `code-review`
 * with exactly one level of `CODE_REVIEW_LEVELS` around which only whitespace stands, any other bare (none, or
 * whitespace).
 */
export function runOnlyArgsRefusal(name: string, args: string | undefined): ToolError | null {
  const words = (args ?? '').trim();
  if (name.toLowerCase() === 'code-review') return CODE_REVIEW_LEVELS.has(words) ? null : runOnlyArgsRefusalWords();
  return words === '' ? null : runOnlyArgsRefusalWords();
}
