/**
 * restartProgress — the phone's Restart, step by step (Nov 8 2026). Pure rules: which
 * step a restart is on, judged from what the Mac reports about the card.
 *
 *   stopping  POST /restart-terminal is in flight (the Mac stops the old agent)
 *   starting  the Mac answered { ok, terminalId }; the card is `connecting` on it
 *   done      the card left `connecting` on that new terminal with no unconfirmed-start marker
 *   failed    the request failed, the card was left `ended` (failSessionRestart), its
 *             startup timed out, its terminal was unlinked, the card is gone,
 *             or nothing came for RESTART_GIVE_UP_MS (the phone missed the Mac's word)
 *
 * The Mac's reply can beat its broadcast, so a card still on the OLD terminal is waiting,
 * not done. See docs/feature/server/session-restart.md.
 */
import type { Session } from '@/types';

export type RestartPhase = 'stopping' | 'starting' | 'done' | 'failed';

export interface RestartTrack {
  /** The id the restart was asked for (a re-keyed card is found by `replacesId`). */
  sessionId: string;
  /** The card's display name when it was asked. */
  name: string;
  /** "Claude", "Codex" or "the agent": what the banner says is starting. */
  cli: string;
  phase: RestartPhase;
  /** The new terminal, once the Mac answered. */
  terminalId: string | null;
  /** Why it failed, or a note on a done one. */
  error: string | null;
  startedAt: number;
}

/** Past the Mac's own 2-minute resume timeout, with room for its broadcast. */
export const RESTART_GIVE_UP_MS = 150_000;

/** The card a restart is about: the same id, or a card that replaced it. */
export function findRestartedSession(sessions: ReadonlyMap<string, Session>, sessionId: string): Session | undefined {
  const same = sessions.get(sessionId);
  if (same) return same;
  for (const s of sessions.values()) if (s.replacesId === sessionId) return s;
  return undefined;
}

/** The step a `starting` restart moves to now, or null while it still waits. */
export function restartStep(
  track: RestartTrack,
  session: Session | undefined,
  now: number,
): { phase: 'done' | 'failed'; error: string | null } | null {
  if (track.phase !== 'starting') return null;
  if (!session) return { phase: 'failed', error: 'The session was closed.' };
  if (session.status === 'ended') {
    return { phase: 'failed', error: 'The Mac couldn’t restart it. Use Resume in Info to try again.' };
  }
  if (session.status !== 'connecting' && session.terminalId === track.terminalId && session.startHeard === false) {
    return { phase: 'failed', error: `${track.cli} startup was not confirmed. Open its terminal to recover.` };
  }
  if (session.status !== 'connecting' && session.terminalId === track.terminalId) return { phase: 'done', error: null };
  if (session.status !== 'connecting' && !session.terminalId) {
    return { phase: 'failed', error: `${track.cli} didn’t start in the new terminal. Use Resume in Info to try again.` };
  }
  if (now - track.startedAt >= RESTART_GIVE_UP_MS) {
    return { phase: 'failed', error: `No word from ${track.cli} after 2½ minutes. Check its terminal.` };
  }
  return null;
}

/** "Claude", "Codex" or "the agent", for the banner's words. */
export function restartCliName(session: Session): string {
  if (session.cliSource === 'codex') return 'Codex';
  if (session.cliSource === 'claude') return 'Claude';
  return 'the agent';
}
