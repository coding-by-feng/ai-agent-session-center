// closedBy.ts — which terminals a person closed (Ruling P4-24).
//
// A task whose worker's terminal closed before its turn stopped is re-routed once (P4-7) — unless a person closed it:
// then the person meant the work to stop, and the task fails with PERSON_CLOSED_ERROR instead. The three routes that
// close a session's terminal on request (apiRouter.ts: POST /sessions/:id/kill, DELETE /sessions/:id,
// DELETE /terminals/:id) note the closer here before they close it; the ledger's exit handler asks.
//
// A caller that is a central (`mcp:<centralId>`, the idle clean-up among them) is not a person; a request with no client
// id cannot be told apart, so it is not noted either and the exit stays re-routable. A note is kept CLOSED_KEPT_MS: the
// exit follows the request within moments, and a note nobody asked about must not make a later crash look deliberate.
// In memory only, like the ledger.

import { MCP_CLIENT_PREFIX } from './policy.js';

/** How long a person's close is remembered for its terminal's exit. */
export const CLOSED_KEPT_MS = 60_000;
/** The most notes kept: the oldest go first. */
const NOTES_MAX = 500;

/** Terminal id → when a person asked for it to close. Entries are replaced or removed, never edited. */
const notes = new Map<string, number>();

function prune(at: number): void {
  for (const [terminalId, noted] of notes) {
    if (at - noted >= CLOSED_KEPT_MS) notes.delete(terminalId);
  }
  while (notes.size > NOTES_MAX) {
    const oldest = notes.keys().next().value;
    if (oldest === undefined) break;
    notes.delete(oldest);
  }
}

/** Is this client id a person's (a window, a phone, a remote device), not a central's and not anonymous? */
export const isPersonClient = (clientId: string): boolean => clientId !== '' && !clientId.startsWith(MCP_CLIENT_PREFIX);

/** A close/kill route is about to close `terminalId` for the caller `clientId`: noted when that caller is a person. */
export function noteTerminalCloser(terminalId: string | null | undefined, clientId: string, at: number = Date.now()): void {
  if (!terminalId || !isPersonClient(clientId)) return;
  notes.delete(terminalId);
  notes.set(terminalId, at);
  prune(at);
}

/** Did a person ask for this terminal to close, within the last CLOSED_KEPT_MS? */
export function closedByPerson(terminalId: string, at: number = Date.now()): boolean {
  const noted = notes.get(terminalId);
  return noted !== undefined && at - noted < CLOSED_KEPT_MS;
}

export function _resetClosedByForTests(): void {
  notes.clear();
}
