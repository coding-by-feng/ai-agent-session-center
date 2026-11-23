/**
 * @module recentPutDown
 * RECENT's "Put down" (Nov 23 2026): a session put down leaves the rail's RECENT frame for the rest of the local
 * day, even if it works again, and its slot goes to the next most recent session. "Put back" returns it. It hides
 * RECENT's copy only: the session is never paused or changed, and it stays in its own room. Kept per device
 * (stores/recentPutDownStore.ts); a new day reads as nothing put down.
 */

export interface PutDownState {
  /** The local day (`dayKey`) the ids were put down on. */
  readonly day: string;
  readonly ids: readonly string[];
}

export const EMPTY_PUT_DOWN: PutDownState = { day: '', ids: [] };

/** The local calendar day, `YYYY-MM-DD`. */
export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The ids put down today; none on any other day. */
export function putDownToday(state: PutDownState, now: number): readonly string[] {
  return state.day === dayKey(now) ? state.ids : [];
}

/** `id` put down for today (once). */
export function putDown(state: PutDownState, id: string, now: number): PutDownState {
  const today = putDownToday(state, now);
  return { day: dayKey(now), ids: today.includes(id) ? today : [...today, id] };
}

/** `id` back in RECENT. */
export function putBack(state: PutDownState, id: string, now: number): PutDownState {
  return { day: dayKey(now), ids: putDownToday(state, now).filter((x) => x !== id) };
}

/** A stored record, or nothing put down when it is missing or malformed. */
export function parsePutDown(raw: string | null): PutDownState {
  if (!raw) return EMPTY_PUT_DOWN;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return EMPTY_PUT_DOWN;
    const { day, ids } = v as { day?: unknown; ids?: unknown };
    if (typeof day !== 'string' || !Array.isArray(ids)) return EMPTY_PUT_DOWN;
    return { day, ids: ids.filter((x): x is string => typeof x === 'string') };
  } catch {
    return EMPTY_PUT_DOWN;
  }
}
