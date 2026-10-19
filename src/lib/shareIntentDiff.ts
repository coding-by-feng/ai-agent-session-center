/**
 * Did somebody change a session's SHARE state (`remoteVisible`) between two session maps?
 *
 * Only a session present in BOTH maps counts: a session appearing, ending, or being
 * re-keyed to its CLI id is not a share decision (and a save right after a re-key
 * could write unresolved `term-*` ids — see queueAutomationDiff).
 */
import type { Session } from '@/types';

export function shareIntentChanged(before: Map<string, Session>, after: Map<string, Session>): boolean {
  if (before === after) return false;
  for (const [id, next] of after) {
    const prev = before.get(id);
    if (prev && Boolean(prev.remoteVisible) !== Boolean(next.remoteVisible)) return true;
  }
  return false;
}
