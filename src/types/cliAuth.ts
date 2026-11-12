/**
 * Are the agent CLIs signed in on the host? (Oct 29 2026.) The server reads `claude auth status`
 * and `codex login status` (`server/cliAuth.ts`); every dashboard shows a "Log in" strip for an
 * enabled CLI that is logged out, and setup offers the login right after install. Shared by the
 * server and the client.
 */
import type { AgentCli } from './cliVersions.js';

/**
 * - logged-in   the CLI says so
 * - logged-out  the CLI says it is not (the only state that asks for a login)
 * - unknown     no clear answer: a timeout, an old CLI, a config error (never treated as logged out)
 * - missing     the CLI is not installed on the host
 */
export type CliAuthState = 'logged-in' | 'logged-out' | 'unknown' | 'missing';

export interface CliAuthInfo {
  cli: AgentCli;
  state: CliAuthState;
  /** How it is signed in (`claude.ai`, `ChatGPT`, `API key`), when the CLI says. */
  method: string | null;
  /** Why the state is `unknown`: the CLI's last output line, or a timeout. */
  detail: string | null;
  checkedAt: number;
}

export interface CliAuthReport {
  /** The host's name, for "Claude Code isn't logged in on <host>". */
  host: string;
  /** Only the CLIs enabled in the server's settings (`enabledClis`). */
  clis: CliAuthInfo[];
}

export const CLI_AUTH_LABELS: Record<AgentCli, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** The enabled CLIs that need a login: only a definite "logged out" counts. */
export function cliLoginsNeeded(report: CliAuthReport | null): CliAuthInfo[] {
  return report ? report.clis.filter((c) => c.state === 'logged-out') : [];
}
