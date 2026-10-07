/**
 * Session list orderings, tested in isolation.
 *
 *  - `sortSessions`           — pinned, then live status, then title. Used by
 *                               RobotListSidebar. (SessionSwitcher's room mode
 *                               keeps its own near-identical local sort, which
 *                               doubles as the basis for its badge numbering.)
 *  - `sortSessionsByActivity` — pinned, then most-recently-active first. Used by
 *                               SessionSwitcher when uiStore's `sessionSortMode`
 *                               is 'activity'.
 *
 * Both keep pinned sessions on top: pinning is an explicit user intent that
 * outranks whatever the list is ordered by.
 */
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import type { Session } from '@/types/session';

export const STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

/**
 * What the LIVE tab can open and the LIVE board lists: not ended, and not a
 * floating AI popup (those belong to the session they were forked from).
 */
export function isListedSession(s: Session): boolean {
  return s.status !== 'ended' && !s.isFloating;
}

/**
 * Does the 3D scene draw a robot for this session? Only for a listed session
 * the dashboard launched (its own PTY, `source: 'ssh'`): a claude started in
 * iTerm or found by the process scan is listed, but gets no robot. The scene
 * and the LIVE page's 3D empty card decide from this one rule.
 */
export function isSceneRobotSession(s: Session): boolean {
  return isListedSession(s) && s.source === 'ssh';
}

export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    // Pinned sessions float to the top of their group.
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const oa = STATUS_ORDER[a.status] ?? 5;
    const ob = STATUS_ORDER[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b));
  });
}

/**
 * The session numbers on the rail's cards (`#1`, `#2`, …): live sessions only,
 * pinned first, then by status, then by title. The badges (SessionSwitcher),
 * Alt+⌘+1…9 and the "go to session #" jump (lib/sessionJump.ts) all read this
 * one function, so a number typed is the number shown.
 *
 * The title key is deliberately `title || projectName || ''`, not
 * `sessionDisplayTitle` ("Unnamed"): that is how the rail has always numbered,
 * and an untitled card switching keys would renumber every card after it.
 */
export function numberedSessions(sessions: Iterable<Session>): Session[] {
  return [...sessions]
    .filter((s) => s.status !== 'ended')
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      const oa = STATUS_ORDER[a.status] ?? 5;
      const ob = STATUS_ORDER[b.status] ?? 5;
      if (oa !== ob) return oa - ob;
      return (a.title || a.projectName || '').localeCompare(b.title || b.projectName || '');
    });
}

/**
 * Most-recently-active first. Status is deliberately ignored — a long-running
 * `working` session that last emitted an event an hour ago belongs below an
 * `idle` one the user touched seconds ago.
 *
 * Sessions with no `lastActivityAt` sink to the bottom rather than jumping to
 * the top. Ties fall through to title and finally `sessionId`, which keeps the
 * order total: untitled sessions would otherwise compare equal and let the
 * stable sort inherit the caller's input order — i.e. the status sort, which
 * this ordering exists to ignore.
 */
export function sortSessionsByActivity(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const ta = a.lastActivityAt ?? 0;
    const tb = b.lastActivityAt ?? 0;
    if (ta !== tb) return tb - ta;
    const byTitle = sessionDisplayTitle(a).localeCompare(sessionDisplayTitle(b));
    if (byTitle !== 0) return byTitle;
    return (a.sessionId || '').localeCompare(b.sessionId || '');
  });
}
