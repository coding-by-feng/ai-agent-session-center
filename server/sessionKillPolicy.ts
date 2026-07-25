import type { Session } from '../src/types/session.js';

function launchCommand(session: Session): string {
  return (
    session.startupCommand
    || session.sshCommand
    || session.sshConfig?.command
    || ''
  ).trim().toLowerCase();
}

export function isCodexSession(session: Session): boolean {
  return session.cliSource?.toLowerCase() === 'codex'
    || /^(?:\S*\/)?codex(?:\s|$)/.test(launchCommand(session));
}

/**
 * Return other live Codex cards backed by the same hook-reported host PID.
 * A Codex host can own several independent threads, so that PID is unsafe as
 * the target for a per-card kill unless the selected card has its own managed
 * terminal that can be closed instead.
 */
export function findLiveCodexPidPeers(
  target: Session,
  sessions: Iterable<Session>,
  pid: number,
): Session[] {
  if (!isCodexSession(target)) return [];
  return [...sessions].filter((session) => (
    session.sessionId !== target.sessionId
    && session.status !== 'ended'
    && session.cachedPid === pid
    && isCodexSession(session)
  ));
}
