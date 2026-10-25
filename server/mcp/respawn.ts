// respawn.ts — a central's card in the opt-in headless respawn (`AASC_SERVER_AUTORESPAWN=1`,
// `respawnSshTerminals` in server/index.ts), which relaunches the saved sessions of a server that restarted.
//
// It is a relaunch that spawns a new PTY, so a central's card is treated as every other one is (Task 5,
// centralLaunch.ts): the central is minted again under its own id, with a new token, for the new PTY; when it
// cannot be (its room is gone, its scope is taken, the line is no bare claude or codex, the card is on
// another machine), the card comes back as a plain session and its marker is cleared (Ruling 16). A card
// that is no central is spawned exactly as before.

import type { Session } from '../../src/types/session.js';
import type { TerminalConfig } from '../../src/types/terminal.js';
import {
  prepareCentralRelaunch,
  spawnCentralTerminal,
  type CentralCaller,
} from './centralLaunch.js';
import type { SessionCentralMarker } from './types.js';

export interface RespawnLaunch {
  /** The line the respawn types once the shell is ready: its first word is the CLI a central is minted for. */
  command: string;
  /** The card runs on another machine (a central never does). */
  remoteHost: boolean;
}

export interface RespawnDeps {
  /** `createTerminal(config, null)`. */
  createTerminal: (config: TerminalConfig) => Promise<string>;
  /** `clearSessionCentral`: the card is no central any more. */
  clearSessionCentral: (sessionId: string) => unknown;
  /** The server itself asks: this Mac, its rooms, its live terminals. */
  caller: CentralCaller;
}

/**
 * Spawn the respawn's terminal for one card. Answers the terminal and the marker it was launched with
 * (undefined for a plain session): when the card cannot take the terminal afterwards, pass both to
 * `discardCentralTerminal`, so a token-holding PTY never outlives its card. A failed spawn leaves no
 * central behind (`spawnCentralTerminal`) and keeps the card's marker, so the next attempt mints it again.
 */
export async function spawnRespawnTerminal(
  session: Pick<Session, 'sessionId' | 'central' | 'permissionMode'> & {
    terminalId?: string | null;
  },
  config: TerminalConfig,
  launch: RespawnLaunch,
  deps: RespawnDeps,
): Promise<{ terminalId: string; central: SessionCentralMarker | undefined }> {
  const plan = prepareCentralRelaunch(
    session,
    {
      command: launch.command,
      workingDir: config.workingDir || '~',
      remoteHost: launch.remoteHost,
    },
    deps.caller,
  );
  const launchConfig: TerminalConfig = plan.central ? { ...config, central: plan.central } : config;
  const terminalId = await spawnCentralTerminal(plan.central, () =>
    deps.createTerminal(launchConfig),
  );
  // Respawned as a plain session: the card is no central any more.
  if (plan.dropped !== undefined) deps.clearSessionCentral(session.sessionId);
  return { terminalId, central: plan.central };
}
