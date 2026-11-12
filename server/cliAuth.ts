// cliAuth.ts — are the agent CLIs signed in on this machine? (Oct 29 2026.)
//
// `claude auth status` prints JSON with `loggedIn`; `codex login status` prints "Logged in using …" or
// "Not logged in". Both run through `runCli` (a login shell, the user's PATH, a timeout), in the
// SERVER's environment: that is the one the sessions run in, and on macOS the one with the Keychain
// (an ssh shell may read "logged out" only because the Keychain is out of reach there).
//
// Only a definite "logged out" asks for a login. Anything unclear (a config error, an old CLI without
// the subcommand, a timeout) reads `unknown`, so a broken config is never mistaken for a sign-out.

import { hostname } from 'os';
import { stripAnsi } from '../src/lib/ansi.js';
import { lastLine, runCli, type CliRunResult } from './cliVersions.js';
import type { AgentCli } from '../src/types/cliVersions.js';
import type { CliAuthInfo, CliAuthReport } from '../src/types/cliAuth.js';

/** How long a reading is kept. A dashboard asks every few minutes; this keeps that to one CLI run. */
export const CLI_AUTH_TTL_MS = 5 * 60_000;
/** `?refresh=1` re-reads at most this often (after "Log in", the dashboard polls with it). */
export const CLI_AUTH_MIN_REFRESH_MS = 10_000;
/** A login shell plus a CLI start: slower than `--version`, never minutes. */
export const CLI_AUTH_TIMEOUT_MS = 15_000;

/** The shell could not find the command (`command not found`, exit 127). */
const NOT_FOUND_EXIT = 127;

type Parsed = Pick<CliAuthInfo, 'state' | 'method' | 'detail'>;

const unknown = (detail: string | null): Parsed => ({ state: 'unknown', method: null, detail: detail || null });

function missing(r: CliRunResult): boolean {
  return r.code === NOT_FOUND_EXIT || /command not found/i.test(r.stderr);
}

/** `claude auth status`: `{ "loggedIn": bool, "authMethod": "claude.ai" | "console" | "none", … }`. */
export function parseClaudeAuthStatus(r: CliRunResult): Parsed {
  if (missing(r)) return { state: 'missing', method: null, detail: null };
  const text = stripAnsi(r.stdout);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const json = JSON.parse(text.slice(start, end + 1)) as { loggedIn?: unknown; authMethod?: unknown };
      if (typeof json.loggedIn === 'boolean') {
        const method = typeof json.authMethod === 'string' && json.authMethod !== 'none' ? json.authMethod : null;
        return { state: json.loggedIn ? 'logged-in' : 'logged-out', method: json.loggedIn ? method : null, detail: null };
      }
    } catch {
      // Not JSON after all: fall through to unknown.
    }
  }
  return unknown(lastLine(`${r.stdout}\n${r.stderr}`));
}

/** `codex login status`: "Logged in using ChatGPT", "Logged in using an API key - sk-…", "Not logged in". */
export function parseCodexLoginStatus(r: CliRunResult): Parsed {
  if (missing(r)) return { state: 'missing', method: null, detail: null };
  const text = stripAnsi(`${r.stdout}\n${r.stderr}`);
  if (/^\s*Not logged in\b/im.test(text)) return { state: 'logged-out', method: null, detail: null };
  const using = text.match(/^\s*Logged in using\s+(.+?)\s*$/im);
  if (using) {
    // The key itself (even masked) never leaves the host.
    const method = /api key/i.test(using[1]) ? 'API key' : using[1].replace(/^an?\s+/i, '');
    return { state: 'logged-in', method, detail: null };
  }
  return unknown(lastLine(text));
}

const PARSERS: Record<AgentCli, (r: CliRunResult) => Parsed> = {
  claude: parseClaudeAuthStatus,
  codex: parseCodexLoginStatus,
};

export interface CliAuthDeps {
  run(cli: AgentCli): Promise<CliRunResult>;
  /** The CLIs enabled in the server's settings, read at each check. */
  enabledClis(): readonly AgentCli[];
  host?: () => string;
  now?: () => number;
}

export interface CliAuthService {
  check(options?: { refresh?: boolean }): Promise<CliAuthReport>;
}

export function createCliAuth({ run, enabledClis, host = hostname, now = Date.now }: CliAuthDeps): CliAuthService {
  const cache = new Map<AgentCli, CliAuthInfo>();
  const inFlight = new Map<AgentCli, Promise<CliAuthInfo>>();

  async function read(cli: AgentCli): Promise<CliAuthInfo> {
    let parsed: Parsed;
    try {
      const result = await run(cli);
      parsed = result.timedOut ? unknown('timed out') : PARSERS[cli](result);
    } catch (err) {
      parsed = unknown(err instanceof Error ? err.message : String(err));
    }
    const info: CliAuthInfo = { cli, ...parsed, checkedAt: now() };
    cache.set(cli, info);
    return info;
  }

  function infoOf(cli: AgentCli, refresh: boolean): Promise<CliAuthInfo> {
    const cached = cache.get(cli);
    const age = cached ? now() - cached.checkedAt : Infinity;
    if (cached && age < (refresh ? CLI_AUTH_MIN_REFRESH_MS : CLI_AUTH_TTL_MS)) return Promise.resolve(cached);
    const running = inFlight.get(cli);
    if (running) return running;
    const next = read(cli).finally(() => inFlight.delete(cli));
    inFlight.set(cli, next);
    return next;
  }

  return {
    async check({ refresh = false } = {}) {
      const clis = await Promise.all(enabledClis().map((cli) => infoOf(cli, refresh)));
      return { host: host(), clis };
    },
  };
}

/** The real service: `runCli` in this server's environment. */
export function createServerCliAuth(enabledClis: () => readonly AgentCli[]): CliAuthService {
  return createCliAuth({ run: (cli) => runCli(cli, 'authStatus', CLI_AUTH_TIMEOUT_MS), enabledClis });
}

