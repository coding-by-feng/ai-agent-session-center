// useUrgentRepeat.test.ts — an Urgent session's unhandled moment comes back every 5 minutes (Nov 25 2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const playReminder = vi.fn();
vi.mock('@/lib/alarmEngine', () => ({ playReminder: (...args: unknown[]) => playReminder(...args) }));

import { useUrgentRepeat } from './useUrgentRepeat';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const mk = (id: string, status: string, alertLevel?: string) =>
  ({ sessionId: id, title: id, status, alertLevel, events: [] }) as unknown as Session;
const put = (...list: Session[]) =>
  act(() => { useSessionStore.setState({ sessions: new Map(list.map((s) => [s.sessionId, s])) } as never); });
const minutes = (n: number) => act(() => { vi.advanceTimersByTime(n * 60_000); });

describe('useUrgentRepeat', () => {
  const notify = vi.fn(async () => ({ ok: true }));
  let focused = false;
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { electronAPI: unknown }).electronAPI = { notify };
    focused = false;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    notify.mockClear();
    playReminder.mockClear();
    useSessionStore.setState({ selectedSessionId: null } as never);
    useUiStore.setState({ detailPanelMinimized: false } as never);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('reminds of an unanswered approval every 5 minutes, by notification (its alarm already repeats the sound)', () => {
    put(mk('a', 'working', 'urgent'), mk('b', 'working', 'loud'));
    renderHook(() => useUrgentRepeat());
    put(mk('a', 'approval', 'urgent'), mk('b', 'approval', 'loud'));
    minutes(4);
    expect(notify).not.toHaveBeenCalled();
    minutes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ sessionId: 'a', title: 'a', body: 'Reminder · Needs your approval' });
    expect(playReminder).not.toHaveBeenCalled();
    minutes(5);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('a finished turn rings again until you open the session', () => {
    put(mk('a', 'working', 'urgent'));
    renderHook(() => useUrgentRepeat());
    put(mk('a', 'waiting', 'urgent'));
    minutes(5);
    expect(playReminder).toHaveBeenCalledTimes(1);
    expect(playReminder.mock.calls[0]?.[1]).toBe('done');
    focused = true;
    act(() => { useSessionStore.setState({ selectedSessionId: 'a' } as never); });
    focused = false;
    minutes(15);
    expect(playReminder).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a restored session standing on a moment is a first sighting: nothing repeats', () => {
    put(mk('a', 'approval', 'urgent'));
    renderHook(() => useUrgentRepeat());
    minutes(30);
    expect(notify).not.toHaveBeenCalled();
    expect(playReminder).not.toHaveBeenCalled();
  });
});
