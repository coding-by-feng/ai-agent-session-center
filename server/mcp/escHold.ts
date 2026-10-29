// escHold.ts — Ruling 47's Esc hold. When a person presses Esc in a session, sessionStore stamps `userCancelledAt` and
// the queue holds until the person acts again (their next prompt clears the stamp). A central is held the same way: it
// steers nothing there while the stamp is set (policy.ts, HUMAN_ACTIVE), and a central prompt already being typed stops
// (promptRouter.ts, the per-keystroke check for `mcp:` callers).
//
// One stamp is not the person's: the one a central's own Esc causes (task_cancel, a prompt sent with mode `interrupt`).
// sessionStore stamps it once the transcript records the Esc (no CLI fires a hook for one), a fraction of a second
// later, so a stamp that lands within CENTRAL_ESC_GRACE_MS after a central's Esc on that session is not a hold. Whoever presses that Esc notes it here first (`noteCentralEsc`).
//
// In memory, per process, like presence: an Esc a restart forgot only makes the hold stricter.

/** How long after a central's own Esc a cancel stamp is still that Esc's, not a person's. */
export const CENTRAL_ESC_GRACE_MS = 15_000;

/** The notes kept at most; the oldest go first (a note older than the grace means nothing anyway). */
const NOTES_MAX = 500;

/**
 * Is the session held by a person's Esc? `userCancelledAt` is the session's cancel stamp; `centralEscAt` when a central
 * last pressed Esc in it (null: never, as far as this process knows).
 */
export function isEscHeld(userCancelledAt: number | null | undefined, centralEscAt: number | null): boolean {
  if (typeof userCancelledAt !== 'number' || !Number.isFinite(userCancelledAt)) return false;
  if (centralEscAt === null) return true;
  const after = userCancelledAt - centralEscAt;
  return !(after >= 0 && after <= CENTRAL_ESC_GRACE_MS);
}

export interface CentralEscBook {
  /** A central is about to press Esc in this session (and its terminal). */
  note(sessionId: string, terminalId: string | null, at?: number): void;
  /** When a central last pressed Esc in this session or its terminal (a re-key keeps the terminal); null: never. */
  at(sessionId: string, terminalId?: string | null): number | null;
}

/** A book of central Escs, keyed by session id and by terminal. The clock is read at each note (`Date.now()` now). */
export function createCentralEscBook(now: () => number = () => Date.now()): CentralEscBook {
  const notes = new Map<string, number>();
  const put = (key: string, at: number): void => {
    notes.delete(key);
    notes.set(key, at);
    while (notes.size > NOTES_MAX) {
      const oldest = notes.keys().next().value;
      if (oldest === undefined) break;
      notes.delete(oldest);
    }
  };
  return {
    note(sessionId, terminalId, at = now()) {
      if (sessionId !== '') put(`s:${sessionId}`, at);
      if (terminalId) put(`t:${terminalId}`, at);
    },
    at(sessionId, terminalId) {
      const bySession = notes.get(`s:${sessionId}`) ?? null;
      const byTerminal = terminalId ? (notes.get(`t:${terminalId}`) ?? null) : null;
      if (bySession === null) return byTerminal;
      return byTerminal === null ? bySession : Math.max(bySession, byTerminal);
    },
  };
}

/** The server's one book: the ledger (deliverWiring.ts) and the prompt route note into it; the policy reads it. */
export const centralEscBook: CentralEscBook = createCentralEscBook();
