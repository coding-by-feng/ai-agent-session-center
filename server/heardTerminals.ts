// heardTerminals.ts — the terminals whose CLI AASC has heard from (Rulings P4-41, P4-50, P4-52), with no dependencies
// at run time (type-only imports), so the prompt route, the router and the ledger's start rules read it without the
// session store.
//
// A terminal is heard once a hook from it reached handleEvent (sessionStore `hearTerminal`), or when the connecting
// timeout found Codex at its input in a folder Codex trusts ("heard by its trust record", Ruling P4-52). Until then
// its CLI may be showing a question that fires no hook (its folder-trust prompt), and a central types nothing into
// it. Forgotten when the terminal exits; kept in memory only, so after an AASC restart a surviving session is unheard
// until its next hook (Ruling P4-58: conservative).

import type { Session } from '../src/types/session.js';

const heard = new Set<string>();

/** Has AASC heard from the CLI in this terminal? */
export function terminalHeard(terminalId: string | null | undefined): boolean {
  return typeof terminalId === 'string' && heard.has(terminalId);
}

export function noteTerminalHeard(terminalId: string): void {
  heard.add(terminalId);
}

export function forgetTerminalHeard(terminalId: string): void {
  heard.delete(terminalId);
}

/**
 * Has the session not yet reported that it started (Ruling P4-58)? Its card carries the never-started marker
 * (`startHeard: false`: the connecting timeout turned it idle with no hook), or its terminal is one AASC has not heard
 * from (no hook since it opened, or since AASC restarted). The one rule the prompt route, the router, the queue switch,
 * the ledger and the session card share. A card with no terminal is never pending here: other rules refuse it.
 */
export function startPending(s: Pick<Session, 'startHeard'> & { terminalId?: Session['terminalId'] }): boolean {
  return s.startHeard === false || (typeof s.terminalId === 'string' && s.terminalId !== '' && !terminalHeard(s.terminalId));
}
