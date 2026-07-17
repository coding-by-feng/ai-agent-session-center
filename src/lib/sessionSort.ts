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
import type { Session } from '@/types/session';

export const STATUS_ORDER: Record<string, number> = {
  working: 0, prompting: 1, approval: 2, input: 2,
  waiting: 3, idle: 4, connecting: 5, ended: 6,
};

export function sortSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => {
    // Pinned sessions float to the top of their group.
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const oa = STATUS_ORDER[a.status] ?? 5;
    const ob = STATUS_ORDER[b.status] ?? 5;
    if (oa !== ob) return oa - ob;
    return (a.title || 'Unnamed').localeCompare(b.title || 'Unnamed');
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
    const byTitle = (a.title || 'Unnamed').localeCompare(b.title || 'Unnamed');
    if (byTitle !== 0) return byTitle;
    return (a.sessionId || '').localeCompare(b.sessionId || '');
  });
}
