/**
 * The agent CLIs' versions on the Mac and their one-click update (Settings ▸ ADVANCED ▸ Agent
 * CLIs, phone More → Settings → Advanced). Shared by the server (`server/cliVersions.ts`) and
 * the client.
 */

export type AgentCli = 'claude' | 'codex';

export const AGENT_CLIS: readonly AgentCli[] = ['claude', 'codex'];

/** The longest an update may run (the server stops it; the desktop row shows time against it). */
export const CLI_UPDATE_TIMEOUT_MS = 5 * 60_000;

/**
 * Where a CLI's last update stands:
 * - idle      none asked for since the server started
 * - updating  the CLI's own `update` command is running
 * - updated   it finished and `--version` now reads newer
 * - current   it finished and the version did not change (already the newest for its channel)
 * - failed    it exited non-zero, timed out or could not start
 */
export type CliUpdateState = 'idle' | 'updating' | 'updated' | 'current' | 'failed';

export interface CliUpdateStatus {
  state: CliUpdateState;
  /** The version before the update started. */
  from?: string | null;
  /** The version `--version` reads once it finished. */
  to?: string | null;
  /** Why it failed: the CLI's last output line, or a timeout. */
  error?: string;
  /** When the state last changed (ms). */
  at?: number;
  /** When the update started (ms): with `at`, how long it ran. */
  startedAt?: number;
  /** The update command's newest output lines, live while it runs and kept after (home folder as `~`). */
  log?: string[];
}

export interface CliVersionInfo {
  cli: AgentCli;
  /** `--version` of the CLI the Mac's terminals start; null when it is not installed. */
  installed: string | null;
  /** The newest version on npm; null when the registry could not be reached. */
  latest: string | null;
  /** `latest` is newer than `installed`. */
  updateAvailable: boolean;
  /** When the versions were last read (ms). */
  checkedAt: number;
  update: CliUpdateStatus;
}

/** The `cli_update` WebSocket message: one CLI's update moved on. */
export interface CliUpdateMessage {
  type: 'cli_update';
  cli: AgentCli;
  info: CliVersionInfo;
}
