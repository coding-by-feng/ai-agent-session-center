// claudePrint.ts — run a print-mode CLI (`claude -p …`) with the prompt on stdin and answer its output
// (Nov 20 2026). The session summary, the peek's recap and the PROMPTS → Days summary all go through here.
//
// The stdin error handler is load-bearing. A child that exits before reading its input (a CLI that fails
// at startup: a flag it doesn't know, a sign-in or config error) makes the pending write fail with EPIPE
// once the prompt is past the pipe buffer (~64 KB; 24,000 CJK characters are ~72 KB). Without a handler
// that is an uncaught exception, and the desktop app's crash logger (electron/crashLogger.ts) quits on one,
// taking every terminal with it. The exit itself still reaches execFile's callback, so the caller gets the
// real failure (exit code, ENOENT, timeout) as a rejection.
//
// The CLI is found the way the Mac's terminals find it (Nov 21 2026). A packaged app inherits launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which has no ~/.local/bin, so a bare `claude` was ENOENT
// and every summary said "the Claude CLI isn't installed on this Mac" while it was. `resolveCli` asks a
// login shell once (like cliVersions.ts and codexNoDaemon.ts) and keeps a found path; a miss is not kept,
// so a CLI installed while the app runs is found on the next Try again.
import { execFile } from 'child_process';

/** The most output kept from one run. */
export const PRINT_MAX_BUFFER = 1024 * 1024;

/** The longest the login-shell lookup may take (a heavy profile can be slow to start). */
const LOOKUP_TIMEOUT_MS = 5000;

/** Where a login shell finds the CLI; null when it doesn't. */
export type CliLookup = (name: string) => Promise<string | null>;

const found = new Map<string, string>();

/** For tests: forget every found path. */
export function clearCliPathCache(): void {
  found.clear();
}

/** The last output line that is an absolute path: a profile can print before it, an alias prints no path. */
export function lastAbsolutePath(output: string): string | null {
  const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** `command -v` in the user's login shell. The name goes in as `$1`, never into the script text. */
const loginShellLookup: CliLookup = (name) =>
  new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh';
    execFile(shell, ['-lc', 'command -v -- "$1"', 'aasc-lookup', name], { timeout: LOOKUP_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : lastAbsolutePath(String(stdout)));
    });
  });

/** The CLI's absolute path when a login shell knows it, else the bare name (execFile then searches PATH). */
export async function resolveCli(name: string, lookup: CliLookup = loginShellLookup): Promise<string> {
  if (name.includes('/') || process.platform === 'win32') return name;
  const known = found.get(name);
  if (known) return known;
  let path: string | null = null;
  try {
    path = await lookup(name);
  } catch {
    path = null;
  }
  if (!path) return name;
  found.set(name, path);
  return path;
}

export interface RunPrintOptions {
  /** How the command name becomes what runs; tests pass their own. */
  resolve?: (name: string) => Promise<string>;
}

export async function runPrint(
  command: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  options: RunPrintOptions = {},
): Promise<string> {
  const executable = await (options.resolve ?? resolveCli)(command);
  return new Promise<string>((resolve, reject) => {
    const child = execFile(executable, [...args], { timeout: timeoutMs, maxBuffer: PRINT_MAX_BUFFER }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.on('error', () => {
      // EPIPE when the child left early: its exit reaches the callback above.
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}
