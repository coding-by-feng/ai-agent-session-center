/**
 * Terminal capacity accounting.
 *
 * Two independent budgets, because a "session" and a "PTY" are not the same thing:
 *
 *   MAX_SESSIONS  — how many agent terminals may exist. This is the number the
 *                   user actually perceives as sessions, so it is the one quoted
 *                   in the rejection message.
 *   MAX_TERMINALS — absolute PTY ceiling including ops shells. A resource
 *                   backstop, not a product limit.
 *
 * Ops terminals (the optional "Commands Terminal" extra shell tab) are an
 * implementation detail of a session and must NOT consume session budget.
 * Before the split there was a single 50-PTY cap: a session created with the
 * checkbox ticked cost two slots, so the cap fired at ~25 real sessions while
 * reporting "max 50".
 *
 * Callers must declare what they are about to spawn (`sessions` / `ops`) so the
 * budget is reserved up front. The old `current >= MAX` shape checked once and
 * then spawned up to two PTYs, which is how the live map reached 51 under a
 * nominal cap of 50.
 */

/** Agent terminals allowed at once — the user-facing session ceiling. */
export const MAX_SESSIONS = 50;

/**
 * Hard PTY ceiling across every terminal kind (agent, ops, tmux attach).
 * Sized so the session budget always binds first: 50 sessions x 2 PTYs each,
 * plus headroom for tmux attaches and floating forks.
 */
export const MAX_TERMINALS = 130;

/** Minimal shape needed to account for a terminal — satisfied by TerminalInfo. */
export interface CapacityTerminal {
  isOps?: boolean;
}

/** What the caller is about to spawn. */
export interface CapacityRequest {
  /** Agent terminals to spawn (default 1). */
  sessions?: number;
  /** Ops shells to spawn (default 0). */
  ops?: number;
}

export type CapacityVerdict = { ok: true } | { ok: false; error: string };

/** Count terminals that occupy session budget (everything except ops shells). */
export function countSessionTerminals(terminals: readonly CapacityTerminal[]): number {
  let count = 0;
  for (const term of terminals) {
    if (!term.isOps) count++;
  }
  return count;
}

/**
 * Decide whether `request` fits within both budgets, given the terminals that
 * already exist. Returns a user-facing message on rejection — it names the kind
 * of slot that ran out so "max 50" can never again mean "you have 25 sessions".
 */
export function checkTerminalCapacity(
  terminals: readonly CapacityTerminal[],
  request: CapacityRequest = {},
): CapacityVerdict {
  const wantSessions = request.sessions ?? 1;
  const wantOps = request.ops ?? 0;

  const sessionCount = countSessionTerminals(terminals);
  if (sessionCount + wantSessions > MAX_SESSIONS) {
    return {
      ok: false,
      error: `Session limit reached (${sessionCount}/${MAX_SESSIONS} active) — kill a session to free a slot`,
    };
  }

  const total = terminals.length + wantSessions + wantOps;
  if (total > MAX_TERMINALS) {
    return {
      ok: false,
      error: `Terminal limit reached (${terminals.length}/${MAX_TERMINALS} shells) — kill a session to free a slot`,
    };
  }

  return { ok: true };
}
