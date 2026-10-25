/**
 * Did somebody flip one of a session's per-session switches between two session maps — SHARE (`remoteVisible`) or
 * Hands off (`handsOff`)? Both are the person's own decision and a restore reads them from the snapshot only, so a
 * flip must reach the snapshot quickly (see useWorkspaceAutoSave).
 *
 * Only a session present in BOTH maps counts: a session appearing, ending, or being
 * re-keyed to its CLI id is not a share decision (and a save right after a re-key
 * could write unresolved `term-*` ids — see queueAutomationDiff).
 */
import type { Session } from '@/types';

/** True when `flag` reads differently on any session present in both maps (absent and false are the same). */
function flagFlipped(
  before: Map<string, Session>,
  after: Map<string, Session>,
  flag: (session: Session) => boolean | undefined,
): boolean {
  if (before === after) return false;
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (prev && Boolean(flag(prev)) !== Boolean(flag(next))) return true;
  }
  return false;
}

export function shareIntentChanged(before: Map<string, Session>, after: Map<string, Session>): boolean {
  return flagFlipped(before, after, (session) => session.remoteVisible);
}

/** Hands off (server/mcp): the switch that keeps every central from steering a session. */
export function handsOffIntentChanged(before: Map<string, Session>, after: Map<string, Session>): boolean {
  return flagFlipped(before, after, (session) => session.handsOff);
}
