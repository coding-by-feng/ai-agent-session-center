import type { HandleEventResult } from '../src/types/session.js';

/**
 * Merge two throttled session updates.
 *
 * The latest session state wins, but identity migrations are one-shot: the
 * SessionStart update may be the only delta carrying `replacesId`. Preserve the
 * earliest migration marker until the coalesced update is broadcast so clients
 * can remove the temporary terminal card.
 */
export function coalesceSessionUpdate(
  pending: HandleEventResult,
  incoming: HandleEventResult,
): HandleEventResult {
  const replacesId = pending.session.replacesId ?? incoming.session.replacesId;
  const session = replacesId
    ? { ...incoming.session, replacesId }
    : incoming.session;

  return {
    ...incoming,
    session,
    team: incoming.team ?? pending.team,
  };
}
