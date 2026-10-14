// liveActivity.test.ts — AASC-21 M7 (optional): the Live Activity / ongoing notification state.
import { describe, it, expect } from 'vitest';
import { buildLiveActivityState, planLiveActivity, elapsedSeconds, LIVE_ACTIVITY_MIN_INTERVAL_MS, type LiveActivityState } from './liveActivity';
import type { SessionLite } from './sessions';

const T0 = 1_760_000_000_000;
const TITLES = { showTitles: true };

function session(sessionId: string, status: SessionLite['status'], extra: Partial<SessionLite> = {}): SessionLite {
  return { sessionId, status, title: `Title ${sessionId}`, lastActivityAt: 0, startedAt: 0, muted: false, hasInterruption: false, ...extra };
}

describe('buildLiveActivityState', () => {
  const sessions = [session('w1', 'working'), session('w2', 'prompting'), session('a', 'approval'), session('i', 'input'), session('m', 'approval', { muted: true }), session('idle', 'idle')];

  it('counts working and attention sessions and describes the watched one', () => {
    expect(buildLiveActivityState(sessions, 'w1', null, T0, TITLES)).toEqual({
      v: 1, working: 2, approval: 1, input: 1,
      watched: { ref: 'w1', title: 'Title w1', status: 'working', statusSince: T0 },
    });
  });

  it('keeps "since" while the status holds and restarts it on a change', () => {
    const first = buildLiveActivityState(sessions, 'w1', null, T0, TITLES);
    const same = buildLiveActivityState(sessions, 'w1', first, T0 + 90_000, TITLES);
    expect(same.watched?.statusSince).toBe(T0);
    expect(elapsedSeconds(same, T0 + 90_000)).toBe(90);
    const changed = buildLiveActivityState([session('w1', 'approval')], 'w1', same, T0 + 100_000, TITLES);
    expect(changed.watched).toMatchObject({ status: 'approval', statusSince: T0 + 100_000 });
  });

  it('shows no title in generic mode and nothing watched when the session is gone', () => {
    expect(buildLiveActivityState(sessions, 'a', null, T0, { showTitles: false }).watched?.title).toBeNull();
    expect(buildLiveActivityState(sessions, 'gone', null, T0, TITLES).watched).toBeNull();
    expect(elapsedSeconds(buildLiveActivityState([], null, null, T0, TITLES), T0)).toBe(0);
  });
});

describe('planLiveActivity', () => {
  const working = buildLiveActivityState([session('w1', 'working')], 'w1', null, T0, TITLES);
  const approval = buildLiveActivityState([session('w1', 'approval')], 'w1', working, T0 + 10_000, TITLES);
  const empty: LiveActivityState = { v: 1, working: 0, approval: 0, input: 0, watched: null };

  it('starts when there is something to show', () => {
    expect(planLiveActivity(null, working, T0)).toEqual({ action: 'start' });
    expect(planLiveActivity(null, empty, T0)).toEqual({ action: 'skip', retryAt: null });
  });

  it('updates at most once a minute, and says when it may', () => {
    const sent = { state: working, at: T0 };
    expect(planLiveActivity(sent, approval, T0 + 10_000)).toEqual({ action: 'skip', retryAt: T0 + LIVE_ACTIVITY_MIN_INTERVAL_MS });
    expect(planLiveActivity(sent, approval, T0 + LIVE_ACTIVITY_MIN_INTERVAL_MS)).toEqual({ action: 'update' });
    expect(planLiveActivity(sent, working, T0 + 5 * LIVE_ACTIVITY_MIN_INTERVAL_MS)).toEqual({ action: 'skip', retryAt: null });
  });

  it('ends at once when the watched session ends or disappears, or nothing is left', () => {
    const sent = { state: working, at: T0 };
    const ended = buildLiveActivityState([session('w1', 'ended')], 'w1', working, T0 + 1_000, TITLES);
    expect(planLiveActivity(sent, ended, T0 + 1_000)).toEqual({ action: 'end' });
    const gone = buildLiveActivityState([session('other', 'working')], 'w1', working, T0 + 1_000, TITLES);
    expect(planLiveActivity(sent, gone, T0 + 1_000)).toEqual({ action: 'end' });
    expect(planLiveActivity(sent, empty, T0 + 1_000)).toEqual({ action: 'end' });
  });
});
