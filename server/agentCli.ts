// server/agentCli.ts — which agent CLI a launch command or a hook belongs to.
//
// A Claude card and a Codex card can share a folder (the hosted workspace starts both in ~/workspace), so a
// match by folder alone must never bind one agent's hook to the other agent's card (Nov 17 2026).

import { agentKindOfCommand } from '../src/lib/agentKinds.js';

/** The agent a launch command starts, from its first word ('claude', 'codex', 'opencode', 'antigravity' for
 *  `agy`); undefined for anything else (a shell, empty). Its value is the agent's hook `cli_source`. */
export function inferCliSource(command: string | undefined | null): string | undefined {
  return agentKindOfCommand(command);
}

/** The agent a hook came from: its `cli_source`, or Claude, whose hook script sends none. */
export function hookCliOf(cliSource: unknown): string {
  return typeof cliSource === 'string' && cliSource ? cliSource.toLowerCase() : 'claude';
}

/** True only when the card's agent is known and differs: an unknown card (a shell, a resume) still links. */
export function isOtherAgent(hookCli: string, cardCli: string | undefined | null): boolean {
  return !!cardCli && cardCli.toLowerCase() !== hookCli;
}
