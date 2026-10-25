/**
 * @module cliVersions
 * The agent CLIs' versions on this Mac and their one-click update (Oct 25 2026): Settings ▸
 * ADVANCED ▸ Agent CLIs on the desktop, More → Settings → Advanced on a phone.
 *
 * **Installed** is `<cli> --version` run the way the Mac's terminals run it (a login shell, so a
 * packaged app finds the user's PATH, like `codexNoDaemon.ts`). **Latest** is the npm registry's
 * `latest` tag (`@anthropic-ai/claude-code`, `@openai/codex`). Both are cached for an hour.
 *
 * **Update** runs the CLI's own `update` command (`claude update`, `codex update`), which knows
 * how it was installed (Claude's native installer, npm, Homebrew…). One update runs at a time,
 * across both CLIs, never longer than `CLI_UPDATE_TIMEOUT_MS`; stdin is closed so a prompt fails
 * instead of hanging. Each state change goes to `onChange` (the server broadcasts `cli_update`).
 * Sessions already running keep the binary they started with until they are restarted.
 *
 * While it runs, the command's output streams into `update.log` (`cliUpdateLog.ts`), announced at
 * most every `LOG_ANNOUNCE_MS`, so the desktop row shows it live; the log stays after the update ends.
 *
 * The command lines are fixed strings: no request field ever reaches them.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { z } from 'zod';
import log from './logger.js';
import { stripInheritedClaudeSessionEnv } from './config.js';
import { stripAnsi } from '../src/lib/ansi.js';
import { createUpdateLog, type UpdateStream } from './cliUpdateLog.js';
import {
  AGENT_CLIS,
  CLI_UPDATE_TIMEOUT_MS,
  type AgentCli,
  type CliUpdateStatus,
  type CliVersionInfo,
} from '../src/types/cliVersions.js';

export { CLI_UPDATE_TIMEOUT_MS };

/** How long the registry and `--version` reads are kept. */
export const CLI_VERSIONS_TTL_MS = 60 * 60_000;
/** The longest a `--version` read may take (a login shell can be slow to start). */
export const CLI_VERSION_TIMEOUT_MS = 15_000;
/** Output lines of an update kept for the log. */
const OUTPUT_KEEP_LINES = 40;
/** How often a running update's new output is announced (each announce is a `cli_update` broadcast). */
export const LOG_ANNOUNCE_MS = 500;
/** The longest error a client is shown. */
const ERROR_CAP = 200;
const REGISTRY_TIMEOUT_MS = 8_000;

const NPM_PACKAGES: Record<AgentCli, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

const VERSION_RE = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/;

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CliVersionsDeps {
  /** Run `<cli> --version` or `<cli> update`; `onOutput` gets each output chunk as it arrives. */
  run(
    cli: AgentCli,
    action: 'version' | 'update',
    timeoutMs: number,
    onOutput?: (stream: UpdateStream, chunk: string) => void,
  ): Promise<CliRunResult>;
  /** The registry's newest version, or null. */
  fetchLatest(cli: AgentCli): Promise<string | null>;
  now(): number;
  /** A failure reason as every device may see it (the home folder masked). */
  maskError(text: string): string;
  /** One CLI's update moved on. */
  onChange(info: CliVersionInfo): void;
}

export interface CliVersionsService {
  list(refresh?: boolean): Promise<CliVersionInfo[]>;
  startUpdate(cli: AgentCli): 'started' | 'busy';
  /** The CLI being updated, or null. */
  busy(): AgentCli | null;
  /** Resolves once no update is running (tests). */
  idle(): Promise<void>;
}

/**
 * The version in `--version` output: the last line that has one, because a login shell's profile
 * may print its own lines (`nvm 0.39.7`) before the CLI runs.
 */
export function parseVersion(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = VERSION_RE.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** `text` with the home folder written as `~`: a failure reason is broadcast to every device. */
export function maskHome(text: string, home: string): string {
  return home && home !== '/' ? text.split(home).join('~') : text;
}

/** Is `a` a newer version than `b`? A release ranks above its own prerelease; unknown is never newer. */
export function isNewer(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const [aMain, aPre] = a.split('-', 2);
  const [bMain, bPre] = b.split('-', 2);
  const an = aMain.split('.').map(Number);
  const bn = bMain.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((an[i] ?? 0) !== (bn[i] ?? 0)) return (an[i] ?? 0) > (bn[i] ?? 0);
  }
  if (aPre === bPre) return false;
  if (!aPre) return true;
  if (!bPre) return false;
  return aPre.localeCompare(bPre, undefined, { numeric: true }) > 0;
}

/** The last non-empty line of some output, ANSI stripped and capped: a failure's reason. */
export function lastLine(text: string): string {
  const lines = stripAnsi(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, ERROR_CAP);
}

interface Reading {
  installed: Record<AgentCli, string | null>;
  latest: Record<AgentCli, string | null>;
  at: number;
}

export function createCliVersions(deps: CliVersionsDeps): CliVersionsService {
  let reading: Reading | null = null;
  let reading$: Promise<Reading> | null = null;
  /** Bumped on every write to `reading`: a read that started before a newer write must not replace it. */
  let generation = 0;
  const store = (r: Reading): Reading => { reading = r; generation += 1; return r; };
  let running: { cli: AgentCli; done: Promise<void> } | null = null;
  const updates: Record<AgentCli, CliUpdateStatus> = { claude: { state: 'idle' }, codex: { state: 'idle' } };

  async function installedOf(cli: AgentCli): Promise<string | null> {
    try {
      const r = await deps.run(cli, 'version', CLI_VERSION_TIMEOUT_MS);
      return r.code === 0 ? parseVersion(r.stdout) : null;
    } catch {
      return null;
    }
  }

  async function latestOf(cli: AgentCli): Promise<string | null> {
    try {
      return await deps.fetchLatest(cli);
    } catch (err) {
      log.warn('cli-versions', `npm registry read for ${cli} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async function read(): Promise<Reading> {
    const [ci, xi, cl, xl] = await Promise.all([installedOf('claude'), installedOf('codex'), latestOf('claude'), latestOf('codex')]);
    return { installed: { claude: ci, codex: xi }, latest: { claude: cl, codex: xl }, at: deps.now() };
  }

  function fresh(refresh: boolean): Promise<Reading> {
    if (reading$) return reading$;
    if (!refresh && reading && deps.now() - reading.at < CLI_VERSIONS_TTL_MS) return Promise.resolve(reading);
    const startedAt = generation;
    reading$ = read()
      // An update finished while this read ran (its --version may be from mid-swap): keep the update's.
      .then((r) => (generation === startedAt ? store(r) : (reading ?? store(r))))
      .finally(() => { reading$ = null; });
    return reading$;
  }

  function infoOf(cli: AgentCli, r: Reading): CliVersionInfo {
    return {
      cli,
      installed: r.installed[cli],
      latest: r.latest[cli],
      updateAvailable: isNewer(r.latest[cli], r.installed[cli]),
      checkedAt: r.at,
      update: updates[cli],
    };
  }

  /** Set a CLI's update status (a new object each time) and announce it. */
  function announce(cli: AgentCli, status: CliUpdateStatus, r: Reading): void {
    updates[cli] = { ...status, at: deps.now() };
    deps.onChange(infoOf(cli, r));
  }

  async function runUpdate(cli: AgentCli): Promise<void> {
    const before = await fresh(false);
    const from = before.installed[cli];
    const startedAt = deps.now();
    const output = createUpdateLog(OUTPUT_KEEP_LINES, deps.maskError);
    /** Every status from here on carries when it started and the output so far. */
    const status = (s: CliUpdateStatus): CliUpdateStatus => ({ ...s, from, startedAt, log: output.lines() });
    announce(cli, status({ state: 'updating' }), before);
    let flush: ReturnType<typeof setTimeout> | null = null;
    const onOutput = (stream: UpdateStream, chunk: string) => {
      output.push(stream, chunk);
      flush ??= setTimeout(() => {
        flush = null;
        if (updates[cli].state === 'updating') announce(cli, status({ state: 'updating' }), reading ?? before);
      }, LOG_ANNOUNCE_MS);
    };
    let result: CliRunResult;
    try {
      result = await deps.run(cli, 'update', CLI_UPDATE_TIMEOUT_MS, onOutput);
    } catch (err) {
      const error = deps.maskError((err instanceof Error ? err.message : String(err)).slice(0, ERROR_CAP));
      log.warn('cli-versions', `${cli} update could not start: ${error}`);
      announce(cli, status({ state: 'failed', error }), before);
      return;
    } finally {
      if (flush) clearTimeout(flush);
      flush = null;
    }
    const raw = `${result.stdout}\n${result.stderr}`;
    log.info('cli-versions', `${cli} update exited ${result.code}${result.timedOut ? ' (timed out)' : ''}:\n${stripAnsi(raw).split(/\r?\n/).filter(Boolean).slice(-OUTPUT_KEEP_LINES).join('\n')}`);
    // Whatever happened, the installed version may have moved: read it again.
    const to = await installedOf(cli);
    // On top of the newest reading, so a refresh that finished meanwhile (the other CLI, npm) is kept.
    const latest = reading ?? before;
    const after = store({ ...latest, installed: { ...latest.installed, [cli]: to }, at: deps.now() });
    if (result.timedOut) {
      announce(cli, status({ state: 'failed', to, error: `Stopped after ${CLI_UPDATE_TIMEOUT_MS / 60_000} minutes` }), after);
    } else if (result.code !== 0) {
      const error = lastLine(result.stderr) || lastLine(result.stdout) || `Exited with code ${result.code}`;
      announce(cli, status({ state: 'failed', to, error: deps.maskError(error) }), after);
    } else {
      announce(cli, status({ state: isNewer(to, from) ? 'updated' : 'current', to }), after);
    }
  }

  return {
    async list(refresh = false) {
      const r = await fresh(refresh);
      return AGENT_CLIS.map((cli) => infoOf(cli, r));
    },
    startUpdate(cli) {
      if (running) return 'busy';
      const done = runUpdate(cli)
        .catch((err) => log.error('cli-versions', `${cli} update: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { running = null; });
      running = { cli, done };
      return 'started';
    },
    busy: () => running?.cli ?? null,
    async idle() {
      while (running) await running.done;
    },
  };
}

// ── The real process and registry ──────────────────────────────────────────

/** Fixed command lines: nothing from a request is ever part of them. */
const COMMANDS: Record<AgentCli, Record<'version' | 'update', string>> = {
  claude: { version: 'claude --version', update: 'claude update' },
  codex: { version: 'codex --version', update: 'codex update' },
};

/** Keep only the tail of a stream, so a chatty installer can't grow memory without bound. */
const TAIL_CHARS = 16 * 1024;
const keepTail = (prev: string, chunk: string): string => (prev + chunk).slice(-TAIL_CHARS);
/** After the CLI exits, how long its output may still drain before the pipes are closed on it. */
export const EXIT_DRAIN_MS = 2_000;
/** After a timeout's SIGTERM, how long before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** End the process and everything it started (npm, the native installer's helpers). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, signal);
  } catch { /* already gone */ }
}

/**
 * Run one fixed CLI command. Settles even when something the CLI started keeps its stdout open
 * (a daemon an installer leaves running, a profile's background job): `close` waits for every copy
 * of the pipe, so `exit` plus a short drain also settles, and a timeout ends with SIGKILL.
 */
export function runCli(
  cli: AgentCli,
  action: 'version' | 'update',
  timeoutMs: number,
  onOutput?: (stream: UpdateStream, chunk: string) => void,
): Promise<CliRunResult> {
  const command = COMMANDS[cli][action];
  const env = stripInheritedClaudeSessionEnv(process.env);
  // The home folder, not the server's: a repo's .npmrc must not steer a global install.
  const cwd = homedir();
  const child = process.platform === 'win32'
    // npm-installed CLIs are .cmd shims on Windows: let cmd.exe resolve them (codexModelCatalog does too).
    ? spawn(command, [], { shell: true, env, cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    // A packaged app inherits a minimal PATH; a login shell finds the CLI an interactive terminal would.
    // Its own process group, so a timeout ends npm and friends too.
    : spawn(process.env.SHELL || '/bin/sh', ['-lc', `exec ${command}`], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      fn();
    };
    const settle = (code: number | null) => finish(() => resolve({ code, stdout, stderr, timedOut }));
    later(timeoutMs, () => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      later(KILL_GRACE_MS, () => {
        killTree(child, 'SIGKILL');
        later(EXIT_DRAIN_MS, () => settle(null));
      });
    });
    // Decoded as UTF-8 by the stream, so a character split across two chunks stays whole.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => { stdout = keepTail(stdout, c); onOutput?.('stdout', c); });
    child.stderr?.on('data', (c: string) => { stderr = keepTail(stderr, c); onOutput?.('stderr', c); });
    child.once('error', (err) => finish(() => reject(err)));
    child.once('exit', (code) => later(EXIT_DRAIN_MS, () => settle(code)));
    child.once('close', (code) => settle(code));
  });
}

const registrySchema = z.object({ version: z.string().regex(VERSION_RE) });

async function fetchLatestFromNpm(cli: AgentCli): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${NPM_PACKAGES[cli]}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = registrySchema.safeParse(await res.json());
  return parsed.success ? parseVersion(parsed.data.version) : null;
}

/** The server's service. `onChange` is wired by index.ts to the `cli_update` broadcast. */
export function createServerCliVersions(onChange: (info: CliVersionInfo) => void): CliVersionsService {
  const home = homedir();
  return createCliVersions({ run: runCli, fetchLatest: fetchLatestFromNpm, now: Date.now, maskError: (t) => maskHome(t, home), onChange });
}
