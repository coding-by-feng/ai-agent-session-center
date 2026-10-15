/**
 * sessionRekey.ts — which sessions re-keyed between two session maps (AASC-39 /
 * AASC-46). A /clear or a resume gives a session a new id: the server sends the
 * new session with `replacesId` = the old one, and the store drops the old entry.
 * Pure.
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
    if (old && old !== id && prev.has(old) && !next.has(old) && !prev.has(id)) out.push([old, id]);
  }
  return out;
}
