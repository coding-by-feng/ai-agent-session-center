// useLiveActivityFeed.test.tsx — the Mac page feeds the iOS Live Activity: posts on mount, skips an
// identical card, spaces posts LIVE_ACTIVITY_GAP_MS apart with the last change always sent, and does
// nothing without the native handler.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { Session } from '@/types';
import { LIVE_ACTIVITY_GAP_MS, useLiveActivityFeed } from './useLiveActivityFeed';
import type { LiveActivityCard } from '@/lib/liveActivityCard';

const session = (id: string, status: string, lastActivityAt: number) =>
  ({ sessionId: id, status, lastActivityAt, title: id }) as unknown as Session;

function setSessions(list: Session[]) {
  act(() => useSessionStore.getState().setSessions(new Map(list.map((s) => [s.sessionId, s]))));
}

const posted: LiveActivityCard[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  posted.length = 0;
  (window as unknown as { webkit?: unknown }).webkit = {
    messageHandlers: { aascLiveActivity: { postMessage: (c: LiveActivityCard) => posted.push(c) } },
  };
  useSessionStore.getState().setSessions(new Map());
  useWsStore.getState().setSnapshotReceived(true);
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { webkit?: unknown }).webkit;
});

describe('useLiveActivityFeed', () => {
  it('posts the card on mount', () => {
    setSessions([session('a', 'working', 1)]);
    renderHook(() => useLiveActivityFeed());
    expect(posted).toHaveLength(1);
    expect(posted[0].rows).toEqual([{ title: 'a', mark: 'working', startedAt: 1 }]);
  });

  it('skips an unchanged card', () => {
    setSessions([session('a', 'working', 1)]);
    renderHook(() => useLiveActivityFeed());
    setSessions([session('a', 'working', 1)]); // a new Map, same card
    act(() => { vi.advanceTimersByTime(LIVE_ACTIVITY_GAP_MS); });
    expect(posted).toHaveLength(1);
  });

  it('holds changes inside the gap and then sends only the latest', () => {
    setSessions([session('a', 'working', 1)]);
    renderHook(() => useLiveActivityFeed());
    setSessions([session('a', 'approval', 2)]);
    setSessions([session('a', 'waiting', 3)]);
    act(() => { vi.advanceTimersByTime(LIVE_ACTIVITY_GAP_MS - 1); });
    expect(posted).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(posted).toHaveLength(2);
    expect(posted[1].headline).toBe('finished');
  });

  it('re-sends an unchanged card when the app comes back to the foreground', () => {
    setSessions([session('a', 'working', 1)]);
    renderHook(() => useLiveActivityFeed());
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(posted).toHaveLength(2);
  });

  it('sends nothing before the first snapshot, then the real list', () => {
    act(() => useWsStore.getState().setSnapshotReceived(false));
    renderHook(() => useLiveActivityFeed());
    act(() => { vi.advanceTimersByTime(LIVE_ACTIVITY_GAP_MS * 2); });
    expect(posted).toHaveLength(0); // an empty card would end the running activity

    setSessions([session('a', 'working', 1)]);
    act(() => useWsStore.getState().setSnapshotReceived(true));
    act(() => { vi.advanceTimersByTime(0); });
    expect(posted).toHaveLength(1);
    expect(posted[0].rows).toEqual([{ title: 'a', mark: 'working', startedAt: 1 }]);
  });

  it('does nothing without the native handler', () => {
    delete (window as unknown as { webkit?: unknown }).webkit;
    setSessions([session('a', 'working', 1)]);
    const { unmount } = renderHook(() => useLiveActivityFeed());
    setSessions([session('a', 'approval', 2)]);
    act(() => { vi.advanceTimersByTime(LIVE_ACTIVITY_GAP_MS * 2); });
    expect(posted).toHaveLength(0);
    unmount();
  });
});
