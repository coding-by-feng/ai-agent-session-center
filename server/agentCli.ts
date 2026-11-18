// server/agentCli.ts — which agent CLI a launch command or a hook belongs to.
//
// A Claude card and a Codex card can share a folder (the hosted workspace starts both in ~/workspace), so a
// match by folder alone must never bind one agent's hook to the other agent's card (Nov 17 2026).

/** 'claude' or 'codex' from a launch command's first word; undefined for anything else (a shell, empty). */
export function inferCliSource(command: string | undefined | null): string | undefined {
  const cmd = (command || '').trim().toLowerCase();
  if (!cmd) return undefined;
  if (/^(?:\S*\/)?claude(?:\s|$)/.test(cmd)) return 'claude';
  if (/^(?:\S*\/)?codex(?:\s|$)/.test(cmd)) return 'codex';
  return undefined;
}

/** The agent a hook came from: its `cli_source`, or Claude, whose hook script sends none. */
export function hookCliOf(cliSource: unknown): string {
  return typeof cliSource === 'string' && cliSource ? cliSource.toLowerCase() : 'claude';
}

/** True only when the card's agent is known and differs: an unknown card (a shell, a resume) still links. */
export function isOtherAgent(hookCli: string, cardCli: string | undefined | null): boolean {
  return !!cardCli && cardCli.toLowerCase() !== hookCli;
}
