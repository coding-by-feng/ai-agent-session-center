/**
 * Session list ordering shared by the sidebar (and tested in isolation).
 *
 * Order: pinned first (the user "fixed" them), then by live status, then title.
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
