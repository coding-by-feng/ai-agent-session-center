/**
 * @module codexNoDaemon
 * AASC-59: keep a dashboard-launched Codex off the shared app-server daemon.
 *
 * Codex 0.162+ runs a thread on a background app-server daemon when one is running, and
 * auto-starts one otherwise. The daemon, not the TUI, then runs the lifecycle hooks: no
 * controlling tty, the daemon's pid, and the daemon's own environment, so the
 * `AGENT_MANAGER_TERMINAL_ID` a hook reports is whichever dashboard terminal happened to
 * auto-start the daemon (or none). Nothing in such a hook ties it to the terminal the TUI
 * lives in, so the card stayed idle with no prompts while Codex did the work.
 *
 * `codex --no-daemon` ("Run without the shared background server, even if it is already
 * running") keeps the thread in the TUI's own process: its hooks are children of the codex
 * on the PTY, with the PTY's tty and terminal id, and the existing matching binds them.
 * Verified against Codex 0.162.1 with an isolated CODEX_HOME in a tmux probe.
 *
 * Nov 4 2026: `--no-alt-screen` joins it. Codex 0.166 draws its TUI on the alternate screen,
 * which keeps no xterm scrollback, so the TERMINAL tab could not scroll back to earlier turns
 * (xterm turns the wheel into arrow keys typed into Codex there). `--no-alt-screen` ("Runs the
 * TUI in inline mode, preserving terminal scrollback history", also on `resume` / `fork`) puts
 * the history in the scrollback, the way CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 does for Claude.
 *
 * An older Codex rejects an unknown flag and does not start, so each flag is only added once
 * `codex --help` (probed through a login shell, cached) advertises THAT flag: a Codex can have
 * one and not the other. Like the Claude status-line tap, they are applied to the line typed
 * into a LOCAL terminal only.
 */
import { execFile } from 'child_process';
import { simpleCommands, type ShellWord } from './config.js';
import log from './logger.js';

export const CODEX_NO_DAEMON_FLAG = '--no-daemon';
export const CODEX_NO_ALT_SCREEN_FLAG = '--no-alt-screen';

export type CodexLaunchFlag = typeof CODEX_NO_DAEMON_FLAG | typeof CODEX_NO_ALT_SCREEN_FLAG;

/** Every flag this module types, in the order it types them. */
export const CODEX_LAUNCH_FLAGS: readonly CodexLaunchFlag[] = [CODEX_NO_DAEMON_FLAG, CODEX_NO_ALT_SCREEN_FLAG];

/** Each flag's opt-out: `=1` leaves that flag as the line was built. */
const OPT_OUT_ENV: Readonly<Record<CodexLaunchFlag, string>> = {
  [CODEX_NO_DAEMON_FLAG]: 'AASC_DISABLE_CODEX_NO_DAEMON',
  [CODEX_NO_ALT_SCREEN_FLAG]: 'AASC_DISABLE_CODEX_NO_ALT_SCREEN',
};

export type CodexFlagSupport = 'supported' | 'unsupported' | 'unknown';

/** What the installed Codex says about each flag. */
export type CodexLaunchFlagSupport = Readonly<Record<CodexLaunchFlag, CodexFlagSupport>>;

const isLaunchFlag = (text: string): text is CodexLaunchFlag => (CODEX_LAUNCH_FLAGS as readonly string[]).includes(text);

/** Root options of `codex` that take a separate value (so the next word is not a subcommand). */
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile',
  '-s', '--sandbox', '-a', '--ask-for-approval', '-C', '--cd', '--add-dir',
]);

/** Subcommands that start the interactive TUI: the flag goes after them. */
const TUI_SUBCOMMANDS: ReadonlySet<string> = new Set(['resume', 'fork']);

/** Every other `codex` subcommand (Codex 0.162.1 `--help`): no TUI, left alone. */
const OTHER_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'agents', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'app-server',
  'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply',
  'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud',
  'exec-server', 'features', 'help', 'mcp-server', 'proto',
]);

interface CodexLaunch {
  /** Where the flags belong: just after `codex`, or after the resume/fork word. */
  insertAt: number;
  /** Launch-flag words already in the command. */
  flags: { word: ShellWord; flag: CodexLaunchFlag }[];
}

/**
 * Read one simple command as an interactive Codex launch: a bare `codex` (a path may be
 * another install than the one probed) with no subcommand, or with `resume` / `fork`.
 * Anything else — `codex exec`, `codex login`, `echo codex`, a quoted `codex` — is null.
 */
function readCodexLaunch(line: string, words: ShellWord[]): CodexLaunch | null {
  const [first, ...rest] = words;
  if (!first || line.slice(first.start, first.end) !== 'codex') return null;
  const flags: CodexLaunch['flags'] = [];
  let insertAt = first.end;
  let subcommandSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const text = line.slice(rest[i].start, rest[i].end);
    if (isLaunchFlag(text)) {
      flags.push({ word: rest[i], flag: text });
      continue;
    }
    if (subcommandSeen) continue;
    if (text.startsWith('-')) {
      if (VALUE_OPTIONS.has(text)) i++; // `-m gpt-6`: the next word is a value
      continue;
    }
    subcommandSeen = true; // the first positional: a subcommand or the prompt
    if (TUI_SUBCOMMANDS.has(text)) insertAt = rest[i].end;
    else if (OTHER_SUBCOMMANDS.has(text)) return null;
  }
  return { insertAt, flags };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The range that removes a word together with the whitespace in front of it. */
function removal(line: string, word: ShellWord): Edit {
  let start = word.start;
  while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start--;
  return { start, end: word.end, text: '' };
}

function applyEdits(line: string, edits: Edit[]): string {
  // Right to left, so earlier offsets stay valid; at one offset the removal goes first.
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  return ordered.reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), line);
}

/** Which flags to put on a launch line and which to take off; a flag in neither stays where it is. */
export interface CodexFlagChanges {
  add?: readonly CodexLaunchFlag[];
  remove?: readonly CodexLaunchFlag[];
}

/**
 * Give every interactive bare `codex` on a launch line exactly one of each `add` flag, right
 * after `codex` or after its `resume` / `fork` subcommand (where `codex resume --help`
 * documents them), in `CODEX_LAUNCH_FLAGS` order, and none of each `remove` flag. A flag
 * already in the line is moved there, not doubled: the hook stores the live CLI's `ps` args,
 * so a relaunch line often carries them at the root already. Decides per simple command, so
 * both halves of `codex … resume 'id' || codex …` get them, and keeps everything else,
 * including the typed carriage return. Idempotent.
 *
 * Only for a line about to be typed into a LOCAL terminal whose Codex supports the added flags.
 */
export function applyCodexLaunchFlags(line: string, { add = [], remove = [] }: CodexFlagChanges): string {
  const touched = new Set<CodexLaunchFlag>([...add, ...remove]);
  const typed = CODEX_LAUNCH_FLAGS.filter((flag) => add.includes(flag));
  const edits: Edit[] = [];
  for (const words of simpleCommands(line)) {
    const launch = readCodexLaunch(line, words);
    if (!launch) continue;
    for (const { word, flag } of launch.flags) if (touched.has(flag)) edits.push(removal(line, word));
    if (typed.length) edits.push({ start: launch.insertAt, end: launch.insertAt, text: ` ${typed.join(' ')}` });
  }
  return edits.length ? applyEdits(line, edits) : line;
}

/**
 * Remove every flag this module types from every interactive bare `codex` on the line: a
 * stored command (the live CLI's `ps` args) is cleaned with it before it is rebuilt, and the
 * flags go back on when the line is typed, if the installed Codex still takes them.
 */
export function stripCodexLaunchFlags(line: string): string {
  return applyCodexLaunchFlags(line, { remove: CODEX_LAUNCH_FLAGS });
}

/** True when the line starts at least one interactive bare `codex`. */
export function hasCodexLaunch(line: string): boolean {
  return simpleCommands(line).some((words) => readCodexLaunch(line, words) !== null);
}

/** Does `codex --help` list the option (the whole word)? */
export function helpAdvertises(helpText: string, flag: CodexLaunchFlag): boolean {
  return new RegExp(`(^|\\s)${flag}(\\s|$)`, 'm').test(helpText);
}

/**
 * Each flag has its own opt-out: `AASC_DISABLE_CODEX_NO_DAEMON=1` and
 * `AASC_DISABLE_CODEX_NO_ALT_SCREEN=1` leave that flag exactly as the line was built.
 */
export function isCodexLaunchFlagEnabled(flag: CodexLaunchFlag, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPT_OUT_ENV[flag]] !== '1';
}

export interface CodexLaunchFlagProbeOptions {
  /** How long a definite answer is kept (Codex may be upgraded or downgraded meanwhile). */
  ttlMs?: number;
  /** How long an "unknown" (codex missing, timed out) is kept before asking again. */
  unknownTtlMs?: number;
  now?: () => number;
}

export const CODEX_NO_DAEMON_TTL_MS = 10 * 60_000;
export const CODEX_NO_DAEMON_UNKNOWN_TTL_MS = 30_000;
export const CODEX_HELP_TIMEOUT_MS = 10_000;

/** The same answer for every flag: `codex --help` could not be run. */
function answerForAll(answer: CodexFlagSupport): CodexLaunchFlagSupport {
  return Object.fromEntries(CODEX_LAUNCH_FLAGS.map((flag) => [flag, answer])) as Record<CodexLaunchFlag, CodexFlagSupport>;
}

/**
 * A cached, de-duplicated answer to "which of these flags does the installed Codex take?". A
 * workspace restore launches many terminals at once; they share one `codex --help`.
 */
export function createCodexLaunchFlagProbe(
  runHelp: () => Promise<string>,
  opts: CodexLaunchFlagProbeOptions = {},
): () => Promise<CodexLaunchFlagSupport> {
  const ttlMs = opts.ttlMs ?? CODEX_NO_DAEMON_TTL_MS;
  const unknownTtlMs = opts.unknownTtlMs ?? CODEX_NO_DAEMON_UNKNOWN_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { answer: CodexLaunchFlagSupport; known: boolean; at: number } | null = null;
  let inFlight: Promise<CodexLaunchFlagSupport> | null = null;

  const ask = async (): Promise<{ answer: CodexLaunchFlagSupport; known: boolean }> => {
    try {
      const help = await runHelp();
      const answer = Object.fromEntries(
        CODEX_LAUNCH_FLAGS.map((flag) => [flag, helpAdvertises(help, flag) ? 'supported' : 'unsupported']),
      ) as Record<CodexLaunchFlag, CodexFlagSupport>;
      return { answer, known: true };
    } catch (err) {
      log.warn('codex', `Could not read codex --help (Codex launch lines are typed as built): ${err instanceof Error ? err.message : String(err)}`);
      return { answer: answerForAll('unknown'), known: false };
    }
  };

  return async () => {
    if (cached) {
      const age = now() - cached.at;
      if (age < (cached.known ? ttlMs : unknownTtlMs)) return cached.answer;
    }
    if (!inFlight) {
      inFlight = ask().then(({ answer, known }) => {
        cached = { answer, known, at: now() };
        inFlight = null;
        return answer;
      });
    }
    return inFlight;
  };
}

/**
 * `codex --help` as the user's terminals would run it: through a login shell, because a
 * packaged app inherits a minimal PATH (the same approach as codexModelCatalog). Fixed
 * argv, no user input.
 */
function runCodexHelp(): Promise<string> {
  const shell = process.env.SHELL || '/bin/sh';
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ['-lc', 'exec codex --help'],
      { timeout: CODEX_HELP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

/** The server's one probe. Never called on Windows (the caller checks). */
export const codexLaunchFlagSupport = createCodexLaunchFlagProbe(runCodexHelp);
