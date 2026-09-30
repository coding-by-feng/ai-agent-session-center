/**
 * @module recentSessions
 * Which sessions belong in the session rail's built-in RECENT frame, and in
 * what order. SessionSwitcher lists each of them there AND in its own room.
 *
 * "Recent" is read from work, never from `lastActivityAt`. The server stamps
 * that field on every hook event, SessionStart included, and a workspace
 * restore resumes every session at once, so it would put the whole workspace
 * in RECENT for a full window after each launch. A restored session has only
 * a SessionStart and prompts from before the restart, and neither counts.
 *
 * Dependency-free (type imports only), like sessionSort / sessionDisplayTitle.
 */
import type { PromptEntry, Session, SessionEvent } from '@/types/session';

/** How long after its last work a session stays in RECENT. */
export const RECENT_WINDOW_MS = 30 * 60_000;

/** How often the rail re-checks, so a session leaves RECENT when it goes quiet
 *  even though no update arrives to say so. */
export const RECENT_TICK_MS = 60_000;

/**
 * Hook events that mean the session did something. An allow-list on purpose:
 * the server also writes its own markers into `events` (ServerRestart,
 * AutoRevived, TerminalCreated, ResumeRequested, ResumeNewTerminal,
 * SessionDiscovered, ...), and a marker added later must not make every
 * session look busy. SessionStart and SessionEnd are left out for the reason
 * in the module comment.
 */
const WORK_EVENTS: ReadonlySet<string> = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'Notification',
  'agent-turn-complete',
]);

/** A turn is running: the session is recent however long ago it started. */
const TURN_RUNNING: ReadonlySet<string> = new Set(['prompting', 'working', 'approval', 'input']);

/** The fields this module reads. Anything Session-shaped satisfies it. */
export type RecentCandidate = Pick<Session, 'sessionId' | 'status'> & {
  pinned?: boolean;
  title?: string | null;
  projectName?: string | null;
  events?: readonly SessionEvent[] | null;
  promptHistory?: readonly PromptEntry[] | null;
};

/** When the session was last sent a prompt (by you or its queue); 0 if never. */
export function lastPromptAt(session: RecentCandidate): number {
  const history = session.promptHistory;
  if (!history || history.length === 0) return 0;
  return history[history.length - 1]?.timestamp ?? 0;
}

/** The newest sign of work: the last prompt, or the last work hook event; 0 if none. */
export function lastWorkAt(session: RecentCandidate): number {
  let latest = lastPromptAt(session);
  const events = session.events;
  if (events) {
    // Events are appended in time order, so the last work event is the newest.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && WORK_EVENTS.has(e.type)) {
        latest = Math.max(latest, e.timestamp ?? 0);
        break;
      }
    }
  }
  return latest;
}

export function isRecentlyActive(session: RecentCandidate, now: number): boolean {
  if (session.status === 'ended') return false;
  if (TURN_RUNNING.has(session.status)) return true;
  const at = lastWorkAt(session);
  return at > 0 && now - at <= RECENT_WINDOW_MS;
}

/**
 * The RECENT frame's contents: pinned first (as in every session ordering
 * here), then newest prompt first. Deliberately not ordered by the latest
 * event: two working sessions fire tool events every few seconds, and cards
 * that swap places on each one cannot be clicked. A prompt only changes when
 * one is sent. Never-prompted sessions go last; title, then id, make the
 * order total. Returns a new array.
 */
export function pickRecentSessions<T extends RecentCandidate>(sessions: readonly T[], now: number): T[] {
  return sessions
    .filter((s) => isRecentlyActive(s, now))
    .map((s) => ({ s, promptAt: lastPromptAt(s) }))
    .sort((a, b) => {
      if (!!a.s.pinned !== !!b.s.pinned) return a.s.pinned ? -1 : 1;
      if (a.promptAt !== b.promptAt) return b.promptAt - a.promptAt;
      const byTitle = (a.s.title || a.s.projectName || '').localeCompare(b.s.title || b.s.projectName || '');
      if (byTitle !== 0) return byTitle;
      return (a.s.sessionId || '').localeCompare(b.s.sessionId || '');
    })
    .map(({ s }) => s);
}
