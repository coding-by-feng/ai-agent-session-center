/**
 * @module sessionHookLevel
 * The per-session "Automation" mark: lite hooks for one session (Nov 2026).
 *
 * Hook density is global: the installer writes one set of events into `~/.claude/settings.json` and Codex's
 * hooks file, and a launch flag cannot take any of them away (`--settings` adds hooks, it never removes one).
 * So a session marked Automation is launched with `AASC_HOOK_LEVEL=lite` in its PTY environment, and the hook
 * scripts (`hooks/dashboard-hook.sh`, `dashboard-hook-codex.sh`, `dashboard-hook.ps1`) exit at once for any
 * event outside {@link LITE_HOOK_EVENTS}, before their `ps`, `jq` and queue write. The CLI still starts the
 * script for every event; what goes is the work after it, the server's processing and the broadcasts.
 *
 * The lite set is global density Low's (both CLIs): start, prompt, approval, stop and end. The queue still
 * works on it (a prompt landing and a turn ending), and `PermissionRequest` still raises the approval badge.
 *
 * Local sessions only: the variable lives in this Mac's PTY, and an SSH session's agent runs elsewhere.
 * It is read when the PTY starts, so a change reaches the agent at its next launch (Restart applies it).
 */
import { CODEX_DENSITY_EVENTS, DENSITY_EVENTS } from './constants.js';
import type { SessionHookLevel } from '../src/types/session.js';

/** The environment variable the hook scripts read. */
export const HOOK_LEVEL_ENV = 'AASC_HOOK_LEVEL';

/**
 * The events a lite session still sends: global Low for Claude, plus Codex's Low (a subset of it). The hook
 * scripts spell this list out in bash and PowerShell; `test/sessionHookLevel.test.ts` keeps them in step.
 */
export const LITE_HOOK_EVENTS: readonly string[] = Object.freeze(
  [...new Set([...DENSITY_EVENTS.low, ...CODEX_DENSITY_EVENTS.low])],
);

/** True when a hook-level value from a request or a stored card means lite. Anything else is the normal level. */
export function isLiteHookLevel(level: unknown): level is SessionHookLevel {
  return level === 'lite';
}

/** The launch-config fragment that carries a card's hook level into a relaunch (restart, resume, reconnect). */
export function hookLevelConfigOf(session: { hookLevel?: SessionHookLevel } | null | undefined): { hookLevel?: SessionHookLevel } {
  return isLiteHookLevel(session?.hookLevel) ? { hookLevel: 'lite' } : {};
}

/**
 * A PTY environment with this launch's hook level, and never one the server inherited: a server started from a
 * lite session's shell must not make every terminal it opens lite. Returns a new object.
 */
export function withHookLevelEnv(
  env: Readonly<Record<string, string>>,
  hookLevel: SessionHookLevel | undefined,
  local: boolean,
): Record<string, string> {
  const { [HOOK_LEVEL_ENV]: _inherited, ...rest } = env;
  void _inherited;
  return local && isLiteHookLevel(hookLevel) ? { ...rest, [HOOK_LEVEL_ENV]: 'lite' } : rest;
}

/**
 * The prefix a local tmux launch line needs. A tmux server gives its panes the environment of the PTY that started
 * it, not this PTY's, and keeps it for every later pane (AASC's and the person's own), so a tmux launch's PTY never
 * carries the level (see sshManager) and each pane sets it, or clears one the server picked up elsewhere.
 * Empty for a remote host, whose environment AASC never sets.
 */
export function hookLevelExport(hookLevel: SessionHookLevel | undefined, local: boolean): string {
  if (!local) return '';
  return isLiteHookLevel(hookLevel) ? `export ${HOOK_LEVEL_ENV}=lite && ` : `unset ${HOOK_LEVEL_ENV} && `;
}
