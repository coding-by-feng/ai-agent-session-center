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
 * An older Codex rejects the unknown flag and does not start, so the flag is only added
 * once `codex --help` (probed through a login shell, cached) advertises it. Like the Claude
 * status-line tap, it is applied to the line typed into a LOCAL terminal only.
 */
import { execFile } from 'child_process';
import { simpleCommands, type ShellWord } from './config.js';
import log from './logger.js';

export const CODEX_NO_DAEMON_FLAG = '--no-daemon';

export type CodexNoDaemonSupport = 'supported' | 'unsupported' | 'unknown';

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
  /** Where the flag belongs: just after `codex`, or after the resume/fork word. */
  insertAt: number;
  /** Existing `--no-daemon` words in the command. */
  flags: ShellWord[];
}

/**
 * Read one simple command as an interactive Codex launch: a bare `codex` (a path may be
 * another install than the one probed) with no subcommand, or with `resume` / `fork`.
 * Anything else — `codex exec`, `codex login`, `echo codex`, a quoted `codex` — is null.
 */
function readCodexLaunch(line: string, words: ShellWord[]): CodexLaunch | null {
  const [first, ...rest] = words;
  if (!first || line.slice(first.start, first.end) !== 'codex') return null;
  const flags: ShellWord[] = [];
  let insertAt = first.end;
  let subcommandSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const text = line.slice(rest[i].start, rest[i].end);
    if (text === CODEX_NO_DAEMON_FLAG) {
      flags.push(rest[i]);
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

function rewrite(line: string, withFlag: boolean): string {
  const edits: Edit[] = [];
  for (const words of simpleCommands(line)) {
    const launch = readCodexLaunch(line, words);
    if (!launch) continue;
    for (const flag of launch.flags) edits.push(removal(line, flag));
    if (withFlag) edits.push({ start: launch.insertAt, end: launch.insertAt, text: ` ${CODEX_NO_DAEMON_FLAG}` });
  }
  return edits.length ? applyEdits(line, edits) : line;
}

/**
 * Give every interactive bare `codex` on a launch line exactly one `--no-daemon`, right
 * after `codex` or after its `resume` / `fork` subcommand (where `codex resume --help`
 * documents it). A flag already in the line is moved there, not doubled: the hook stores
 * the live CLI's `ps` args, so a relaunch line often carries it at the root already.
 * Decides per simple command, so both halves of `codex … resume 'id' || codex …` get it,
 * and keeps everything else, including the typed carriage return. Idempotent.
 *
 * Only for a line about to be typed into a LOCAL terminal whose Codex supports the flag.
 */
export function applyCodexNoDaemon(line: string): string {
  return rewrite(line, true);
}

/** Remove `--no-daemon` from every interactive bare `codex` on the line (an older Codex rejects it). */
export function stripCodexNoDaemon(line: string): string {
  return rewrite(line, false);
}

/** True when the line starts at least one interactive bare `codex`. */
export function hasCodexLaunch(line: string): boolean {
  return simpleCommands(line).some((words) => readCodexLaunch(line, words) !== null);
}

/** Does `codex --help` list the option? */
export function helpAdvertisesNoDaemon(helpText: string): boolean {
  return /(^|\s)--no-daemon(\s|$)/m.test(helpText);
}

/** `AASC_DISABLE_CODEX_NO_DAEMON=1` leaves Codex launch lines exactly as built. */
export function isCodexNoDaemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AASC_DISABLE_CODEX_NO_DAEMON !== '1';
}

export interface CodexNoDaemonProbeOptions {
  /** How long a definite answer is kept (Codex may be upgraded or downgraded meanwhile). */
  ttlMs?: number;
  /** How long an "unknown" (codex missing, timed out) is kept before asking again. */
  unknownTtlMs?: number;
  now?: () => number;
}

export const CODEX_NO_DAEMON_TTL_MS = 10 * 60_000;
export const CODEX_NO_DAEMON_UNKNOWN_TTL_MS = 30_000;
export const CODEX_HELP_TIMEOUT_MS = 10_000;

/**
 * A cached, de-duplicated answer to "does the installed Codex take --no-daemon?". A
 * workspace restore launches many terminals at once; they share one `codex --help`.
 */
export function createCodexNoDaemonProbe(
  runHelp: () => Promise<string>,
  opts: CodexNoDaemonProbeOptions = {},
): () => Promise<CodexNoDaemonSupport> {
  const ttlMs = opts.ttlMs ?? CODEX_NO_DAEMON_TTL_MS;
  const unknownTtlMs = opts.unknownTtlMs ?? CODEX_NO_DAEMON_UNKNOWN_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: { answer: CodexNoDaemonSupport; at: number } | null = null;
  let inFlight: Promise<CodexNoDaemonSupport> | null = null;

  const ask = async (): Promise<CodexNoDaemonSupport> => {
    try {
      const help = await runHelp();
      return helpAdvertisesNoDaemon(help) ? 'supported' : 'unsupported';
    } catch (err) {
      log.warn('codex', `Could not read codex --help (Codex launches keep the shared daemon): ${err instanceof Error ? err.message : String(err)}`);
      return 'unknown';
    }
  };

  return async () => {
    if (cached) {
      const age = now() - cached.at;
      if (age < (cached.answer === 'unknown' ? unknownTtlMs : ttlMs)) return cached.answer;
    }
    if (!inFlight) {
      inFlight = ask().then((answer) => {
        cached = { answer, at: now() };
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
export const codexNoDaemonSupport = createCodexNoDaemonProbe(runCodexHelp);
