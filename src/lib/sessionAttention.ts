/**
 * Rules for the green "Completed ✓" on a session card in the rail (`SessionSwitcher`).
 *
 * The ✓ means "this session finished a turn and you have not looked at it yet". It is raised when a
 * session you are NOT viewing moves to `waiting`, and cleared when you view it — and, because it
 * outranks the status glyph on the card, it has to go the moment it stops being true: otherwise a
 * card that has moved on (a queued prompt fired, a tool needs approval, the session was resumed)
 * keeps saying "completed" until somebody clicks it.
 *
 * Import-free on purpose: pure rules, trivially testable without rendering the rail.
 */

/** The session just finished a turn: it reached `waiting` from a status that is not itself "finished". */
export function justCompleted(prev: string | undefined, status: string): boolean {
  return Boolean(prev) && prev !== 'waiting' && prev !== 'ended' && status === 'waiting';
}

/**
 * Is "finished, not yet reviewed" still true of a session in this status?
 *
 * `idle` keeps it: the server moves a finished session from `waiting` to `idle` after five minutes
 * whether or not anyone looked, so dropping the flag there would erase every completion five minutes
 * after it happened. Any other status means the session is busy again, needs you for something more
 * urgent, is restarting or is gone — the live status replaces the flag, and the next completion
 * raises it afresh.
 */
export function completionStillApplies(status: string): boolean {
  return status === 'waiting' || status === 'idle';
}

/**
 * The ✓ set after the session list changed from `prev` to `next` while `currentId`
 * is open: raise it on a session (not the open one) that just finished a turn,
 * drop it where it no longer applies, where the session left the list, and on
 * the open session (viewing it acknowledges it). Returns `ids` itself when
 * nothing changed, so a caller can skip a re-render.
 */
export function nextCompletionAttention(
  ids: ReadonlySet<string>,
  prev: ReadonlyMap<string, { status: string }>,
  next: ReadonlyMap<string, { status: string }>,
  currentId: string,
): ReadonlySet<string> {
  const out = new Set(ids);
  let changed = false;
  next.forEach((s, id) => {
    if (id !== currentId && justCompleted(prev.get(id)?.status, s.status) && !out.has(id)) {
      out.add(id);
      changed = true;
    }
    if (out.has(id) && !completionStillApplies(s.status)) {
      out.delete(id);
      changed = true;
    }
  });
  for (const id of [...out]) {
    if (!next.has(id) || id === currentId) {
      out.delete(id);
      changed = true;
    }
  }
  return changed ? out : ids;
}
