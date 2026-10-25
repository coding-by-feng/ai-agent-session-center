// queuePutRefusals.ts — the sessions whose queue the AASC window last failed to save (Ruling 54's server stopgap).
//
// The window saves a queue by PUTting its whole list (`PUT /sessions/:id/queue`, apiRouter.ts). When the route refuses
// one (a list over its 8 MB cap: two pasted screenshots are enough), the window keeps its list and the server keeps the
// older one it had. A central's write is built from the server's row and told to every window, so it would replace the
// edits the window could not save and bring back the prompts the window had already sent. So until a save of that
// queue goes through again, the server's queue store refuses a central's write to it (queueWiring.ts).
//
// A mark is keyed by the session the id resolves to (a session's id changes when it re-keys; the window may still PUT
// the old one) and remembers which window's save was refused: only a later accepted save from that same window clears
// its mark (Ruling P4-32), so a second window's good save does not hide the first window's unsaved edits. A save that
// does not name its window (`originClientId` absent) cannot be told apart: it clears every mark of the session.
//
// The route records each save's outcome here, and nothing else does. Kept in memory only: a restart forgets, and the
// window's next save (it saves after every change) decides again.

import { resolveSessionId } from '../sessionStore.js';

/** Sessions remembered at most; past it the oldest mark goes (a session's next refused save marks it again). */
const MAX_MARKED = 1_000;

/** The window of a save that did not name one. */
const UNNAMED = '';

/** Session id → the windows whose last save of it was refused; in the order the sessions were marked, oldest first. */
const refused = new Map<string, Set<string>>();

/** The id a mark is kept under: the session the id resolves to now, else the id itself. */
const keyOf = (sessionId: string): string => resolveSessionId(sessionId) ?? sessionId;

/** The route's answer to one save of a session's queue, by the window (`originClientId`) that made it: taken (`accepted`) or refused. */
export function recordQueuePut(sessionId: string, accepted: boolean, originClientId?: string): void {
  const key = keyOf(sessionId);
  const origin = originClientId === undefined || originClientId === '' ? UNNAMED : originClientId;
  const windows = refused.get(key);
  if (accepted) {
    if (windows === undefined) return;
    windows.delete(origin);
    if (origin === UNNAMED || windows.size === 0) refused.delete(key);
    return;
  }
  refused.delete(key);
  if (refused.size >= MAX_MARKED) {
    const oldest = refused.keys().next().value;
    if (oldest !== undefined) refused.delete(oldest);
  }
  refused.set(key, new Set([...(windows ?? []), origin]));
}

/** Was a window's last save of this session's queue refused? */
export function lastQueuePutRefused(sessionId: string): boolean {
  return refused.has(keyOf(sessionId));
}
