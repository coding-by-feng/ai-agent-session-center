// liveActivity.ts — OPTIONAL (AASC-21 M7): the iOS Live Activity / Android ongoing notification.
//
// The state the native activity renders: how many sessions are working or need
// you, and one watched session with its status and since when. Elapsed time is
// drawn natively from `watched.statusSince` (ActivityKit Text(timerInterval:),
// Android Chronometer), so the activity needs no update to tick. Updates are
// throttled to one per LIVE_ACTIVITY_MIN_INTERVAL_MS (KRT: at most once a
// minute); ending is never throttled, so a finished watch doesn't linger.
import type { SessionLite, SessionStatus } from './sessions.js';
import { cleanLabel } from './text.js';

export const LIVE_ACTIVITY_MIN_INTERVAL_MS = 60_000;
export const LIVE_ACTIVITY_TITLE_MAX = 40;

export interface WatchedSession {
  ref: string;
  /** Null when titles are off (generic mode). */
  title: string | null;
  status: SessionStatus;
  /** When the watched session entered this status (epoch ms). */
  statusSince: number;
}

export interface LiveActivityState {
  v: 1;
  working: number;
  approval: number;
  input: number;
  watched: WatchedSession | null;
}

const BUSY: ReadonlySet<SessionStatus> = new Set(['prompting', 'working']);

/** `prev` carries the watched session's statusSince over while its status is unchanged. */
export function buildLiveActivityState(
  sessions: readonly SessionLite[], watchedRef: string | null, prev: LiveActivityState | null, now: number,
  opts: { showTitles: boolean },
): LiveActivityState {
  const live = sessions.filter((s) => !s.muted);
  const w = watchedRef ? sessions.find((s) => s.sessionId === watchedRef) : undefined;
  const same = w && prev?.watched?.ref === w.sessionId && prev.watched.status === w.status;
  return {
    v: 1,
    working: live.filter((s) => BUSY.has(s.status)).length,
    approval: live.filter((s) => s.status === 'approval').length,
    input: live.filter((s) => s.status === 'input').length,
    watched: w
      ? {
          ref: w.sessionId,
          title: opts.showTitles ? cleanLabel(w.title, LIVE_ACTIVITY_TITLE_MAX) || null : null,
          status: w.status,
          statusSince: same && prev?.watched ? prev.watched.statusSince : now,
        }
      : null,
  };
}

export function elapsedSeconds(state: LiveActivityState, now: number): number {
  return state.watched ? Math.max(0, Math.floor((now - state.watched.statusSince) / 1000)) : 0;
}

function isEmpty(state: LiveActivityState): boolean {
  return state.watched === null && state.working + state.approval + state.input === 0;
}

function sameContent(a: LiveActivityState, b: LiveActivityState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type LiveActivityPlan =
  | { action: 'start' | 'update' | 'end' }
  | { action: 'skip'; retryAt: number | null };

/** `sent`: the state last handed to the native activity and when, or null when none is running. */
export function planLiveActivity(sent: { state: LiveActivityState; at: number } | null, next: LiveActivityState, now: number): LiveActivityPlan {
  const ended = next.watched?.status === 'ended';
  if (!sent) return isEmpty(next) || ended ? { action: 'skip', retryAt: null } : { action: 'start' };
  // The watched session ended, or left the list (ended or no longer shared).
  const watchGone = ended || (sent.state.watched !== null && next.watched === null);
  if (isEmpty(next) || watchGone) return { action: 'end' };
  if (sameContent(sent.state, next)) return { action: 'skip', retryAt: null };
  const allowedAt = sent.at + LIVE_ACTIVITY_MIN_INTERVAL_MS;
  if (now >= sent.at && now < allowedAt) return { action: 'skip', retryAt: allowedAt };
  return { action: 'update' };
}
