/**
 * agentWork — the project folders an agent is working in right now (code review, Oct 29 2026): a
 * session mid-turn, prompting, working, or waiting on an approval or an answer. A session that has
 * finished its turn, or sits idle, changes no files, so Pull and Push no longer wait days for it.
 */
import type { SessionStatus } from '../../src/types/session.js';

const MID_TURN: ReadonlySet<SessionStatus> = new Set(['prompting', 'working', 'approval', 'input']);

export function workingProjectPaths(
  sessions: readonly { status: SessionStatus; projectPath?: string | null }[],
): string[] {
  return sessions.flatMap((s) => (MID_TURN.has(s.status) && s.projectPath ? [s.projectPath] : []));
}
