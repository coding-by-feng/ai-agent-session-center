// relaunchRule.ts — the stored-command rule of a relaunch (Rulings P3-8, P3-23). A resume, reconnect, fork or clone
// types the card's stored command again (or one built from it), and that command is the live CLI's `ps -o args=`: argv
// with no quoting, so the words of a title come back as loose words, and a reconnect types them as they are. So a
// central relaunches only a card whose stored command is an allow-list, once AASC's own MCP flags are taken off
// (launch.ts `stripCentralLaunch`, by their exact text: they carry JSON and `${AASC_MCP_TOKEN}`, and the route takes
// them off too):
//   - the first word exactly `claude` or `codex`;
//   - nothing a shell reads as more than words: no shell syntax `; & | $ \` < > ( ) { } \`, no wildcard `* ? [ ]`, no
//     history mark `!`, no control character or line break, and every quote closed;
//   - then, read as the words the shell passes on (quotes taken off), only the flags AASC's own launch builders put on
//     a line (config.ts `applyClaudeLaunchFlags`, `reconstructPermissionFlags`, `appendSessionName`; apiRouter.ts's
//     resume, fork and clone lines; openWorker.ts `workerCommandFor`; codexNoDaemon.ts), each value a plain token or
//     one of its known values:
//       Claude: `--model`, `--effort`, `--permission-mode`, `--dangerously-skip-permissions`, `--resume [id]`,
//               `--continue`, `--fork-session`, and `-n`/`--name` with exactly one word (Ruling P3-36: a `ps`-printed
//               title of more words would come back as positionals, and `claude -n x mcp add …` runs `mcp add`);
//       Codex:  `--model`/`-m`, `-c`/`--config` with `model_reasoning_effort=<level>` only, `--sandbox`/`-s`,
//               `--ask-for-approval`/`-a`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`,
//               `--no-daemon`, and one `resume` or `fork` subcommand with an id or `--last`.
//     Any other word that starts with `-` (`--allowedTools`, `--add-dir`, `--mcp-config`, `--settings`, Codex's
//     `--profile`, a `-c` with another key) is refused, and so is any other positional word (an initial prompt).
// An empty command is no refusal: the route then runs its own `claude`. Every command a route may type for the card is
// judged (`storedCommandsOf`), not only the first, and judged as the route types it. Every relaunch rebuilds a Claude
// line's name, quoted, from the card's title: reconnect calls `relaunchLineOf`, the headless respawn too (respawnLine.ts,
// Ruling P3-39), and resume, restart, fork and clone do the same in their builders (apiRouter.ts `buildResumeLine`,
// `appendSessionName`). So a card AASC launched as `-n "My title"`, stored as `-n My title`, is judged as
// `-n "My title"`, one word.
//
// Pure: it reads nothing but the command it is handed. The words never repeat that command.

import type { Session } from '../../src/types/session.js';
import { appendSessionName, extractSessionName, FLAG_EFFORT_LEVELS, stripClaudeSessionName } from '../config.js';
import { stripCentralLaunch } from './launch.js';

export const RELAUNCH_REFUSAL =
  'A central relaunches only a session started as a bare claude or codex command with the flags AASC itself launches with.';

/**
 * What a stored command never holds when a central relaunches it: shell syntax, a wildcard (it could expand to a file
 * named like a flag), the history mark, and control characters, line breaks included.
 */
// eslint-disable-next-line no-control-regex
const SHELL_SYNTAX = /[;&|$`<>(){}\\*?[\]!\x00-\x08\x0A-\x1F\x7F]/;

/** A flag's value: a plain token that is not itself a flag. */
const PLAIN = /^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/;

const CODEX_EFFORTS = '(?:minimal|low|medium|high|xhigh)';
/** The one `-c` override AASC types (`-c 'model_reasoning_effort="high"'`), with its double quotes or without (ps). */
const CODEX_EFFORT_OVERRIDE = new RegExp(`^model_reasoning_effort=(?:"${CODEX_EFFORTS}"|${CODEX_EFFORTS})$`);
const CODEX_SANDBOXES: ReadonlySet<string> = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVALS: ReadonlySet<string> = new Set(['untrusted', 'on-failure', 'on-request', 'never']);

type ValueRule = (value: string) => boolean;
const plain: ValueRule = (v) => PLAIN.test(v);
const oneOf = (set: ReadonlySet<string>): ValueRule => (v) => set.has(v);

/** The flags each CLI may carry: a value rule, or null for a switch that takes none. */
const CLAUDE_FLAGS: ReadonlyMap<string, ValueRule | null> = new Map([
  ['--model', plain],
  ['--effort', oneOf(FLAG_EFFORT_LEVELS)],
  ['--permission-mode', plain],
  ['--dangerously-skip-permissions', null],
  ['--continue', null],
  ['--fork-session', null],
]);
const CODEX_FLAGS: ReadonlyMap<string, ValueRule | null> = new Map([
  ['--model', plain],
  ['-m', plain],
  ['-c', (v: string) => CODEX_EFFORT_OVERRIDE.test(v)],
  ['--config', (v: string) => CODEX_EFFORT_OVERRIDE.test(v)],
  ['--sandbox', oneOf(CODEX_SANDBOXES)],
  ['-s', oneOf(CODEX_SANDBOXES)],
  ['--ask-for-approval', oneOf(CODEX_APPROVALS)],
  ['-a', oneOf(CODEX_APPROVALS)],
  ['--full-auto', null],
  ['--dangerously-bypass-approvals-and-sandbox', null],
  ['--yolo', null],
  ['--no-daemon', null],
]);
const CLAUDE_NAME_FLAGS: ReadonlySet<string> = new Set(['-n', '--name']);
const CODEX_SUBCOMMANDS: ReadonlySet<string> = new Set(['resume', 'fork']);

/**
 * What the resume route answers a central (409, `code`) when the card's terminal is still open: it never types into a
 * shell whatever may run there now (an `ssh`, an editor), so the tool says UNAVAILABLE (C-M7).
 */
export const TERMINAL_OPEN_CODE = 'TERMINAL_OPEN';

/** The command the relaunch routes reuse: the card's startupCommand, else its sshCommand, else its SSH config's. */
export function storedCommandOf(s: Pick<Session, 'startupCommand' | 'sshCommand' | 'sshConfig'>): string {
  return s.startupCommand || s.sshCommand || s.sshConfig?.command || '';
}

/**
 * Every command a relaunch route may type for the card, each judged: resume reads startupCommand, then sshCommand,
 * then the SSH config's; reconnect startupCommand, then the SSH config's.
 */
export function storedCommandsOf(s: Pick<Session, 'startupCommand' | 'sshCommand' | 'sshConfig'>): string[] {
  return [s.startupCommand, s.sshCommand, s.sshConfig?.command].filter((c): c is string => typeof c === 'string' && c !== '');
}

/**
 * The line a relaunch route types for a stored command: a bare Claude line with its `-n`/`--name` taken off (every word
 * of a `ps`-printed name with it) and put back quoted, from the card's title, else from the name the line had. The
 * reconnect route (apiRouter.ts) types exactly this; resume, fork and clone rebuild the name the same way in their own
 * builders. Any other command comes back as it is (a Codex line has no name).
 */
export function relaunchLineOf(command: string, title: string | null | undefined): string {
  const line = command.trim();
  if (line.split(/\s+/, 1)[0] !== 'claude') return command;
  return appendSessionName(stripClaudeSessionName(line), title || extractSessionName(line));
}

/** The words a shell passes on for `line` (quotes taken off), or null when a quote is left open. */
function wordsOf(line: string): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) words.push(word);
  return words;
}

const isFlag = (word: string): boolean => word.startsWith('-');

/** `--flag=value` as `['--flag', 'value']`; any other word as itself. */
function splitEquals(word: string): [string, string | null] {
  const at = word.indexOf('=');
  return isFlag(word) && word.startsWith('--') && at > 0 ? [word.slice(0, at), word.slice(at + 1)] : [word, null];
}

/**
 * Reads one flag at `args[i]` against `flags`: answers the index after it (and its value), or -1 when it is not one
 * the CLI may carry or its value is not one its rule takes.
 */
function readFlag(args: readonly string[], i: number, flags: ReadonlyMap<string, ValueRule | null>): number {
  const [flag, inline] = splitEquals(args[i]);
  if (!flags.has(flag)) return -1;
  const rule = flags.get(flag) ?? null;
  if (rule === null) return inline === null ? i + 1 : -1;
  if (inline !== null) return rule(inline) ? i + 1 : -1;
  const value = args[i + 1];
  return value !== undefined && !isFlag(value) && rule(value) ? i + 2 : -1;
}

/** Claude's arguments: its flags, `--resume` with an id or none, and a name of exactly one word. */
function claudeArgsPass(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; ) {
    const [flag, inline] = splitEquals(args[i]);
    if (CLAUDE_NAME_FLAGS.has(flag)) {
      if (inline !== null) {
        if (inline === '') return false;
        i += 1;
        continue;
      }
      const name = args[i + 1];
      if (name === undefined || isFlag(name)) return false;
      i += 2;
    } else if (flag === '--resume') {
      if (inline !== null) {
        if (!PLAIN.test(inline)) return false;
        i += 1;
      } else if (i + 1 < args.length && !isFlag(args[i + 1])) {
        if (!PLAIN.test(args[i + 1])) return false;
        i += 2;
      } else {
        i += 1;
      }
    } else {
      i = readFlag(args, i, CLAUDE_FLAGS);
      if (i < 0) return false;
    }
  }
  return true;
}

/**
 * Codex's arguments: its flags anywhere, and at most one `resume` / `fork`, after which one id or `--last` may come
 * (codexNoDaemon.ts puts `--no-daemon` between the subcommand and its id).
 */
function codexArgsPass(args: readonly string[]): boolean {
  let subcommand: 'none' | 'open' | 'done' = 'none';
  for (let i = 0; i < args.length; ) {
    const word = args[i];
    if (subcommand === 'open' && (word === '--last' || !isFlag(word))) {
      if (word !== '--last' && !PLAIN.test(word)) return false;
      subcommand = 'done';
      i += 1;
    } else if (!isFlag(word)) {
      if (subcommand !== 'none' || !CODEX_SUBCOMMANDS.has(word)) return false;
      subcommand = 'open';
      i += 1;
    } else {
      i = readFlag(args, i, CODEX_FLAGS);
      if (i < 0) return false;
    }
  }
  return true;
}

/** Why a central may not relaunch a card stored with `command`; null when it may. */
export function relaunchCommandRefusal(command: string | null | undefined): string | null {
  const line = stripCentralLaunch(command ?? '').trim();
  if (line === '') return null;
  if (SHELL_SYNTAX.test(line)) return RELAUNCH_REFUSAL;
  const words = wordsOf(line);
  // The first word as written, not as the shell reads it: a quoted `'claude'` is not a bare claude.
  const first = line.split(/\s+/, 1)[0];
  if (words === null || words[0] !== first) return RELAUNCH_REFUSAL;
  const args = words.slice(1);
  if (first === 'claude') return claudeArgsPass(args) ? null : RELAUNCH_REFUSAL;
  if (first === 'codex') return codexArgsPass(args) ? null : RELAUNCH_REFUSAL;
  return RELAUNCH_REFUSAL;
}
