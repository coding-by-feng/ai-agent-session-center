/**
 * sessionRekey.ts — which sessions re-keyed between two session maps (AASC-39 /
 * AASC-46). A /clear or a resume gives a session a new id: the server sends the
 * new session with `replacesId` = the old one, and the store drops the old entry.
 * The new id may already be in `prev`: a first re-key can arrive as two updates,
 * the new session alone and then with `replacesId` (seen on a real iPhone). Pure.
 */
import type { Session } from '@/types';

/** [oldId, newId] for every session that took over another one's id since `prev`. */
export function rekeyedSessions(
  prev: ReadonlyMap<string, Pick<Session, 'sessionId' | 'replacesId'>>,
  next: ReadonlyMap<string, Pick<Session, 'sessionId' | 'replacesId'>>,
): Array<[string, string]> {
  if (prev === next) return [];
  const out: Array<[string, string]> = [];
  for (const [id, s] of next) {
    const old = s.replacesId;
    if (old && old !== id && prev.has(old) && !next.has(old)) out.push([old, id]);
  }
  return out;
}
