// useAlertNotifications.test.ts — an alerted session's finish reaches the desktop notification bridge (Nov 23 2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAlertNotifications } from './useAlertNotifications';
import { useSessionStore } from '@/stores/sessionStore';
import { ALERT_NOTIFY_SETTLE_MS } from '@/lib/alertNotify';
import type { Session } from '@/types';

const mk = (id: string, status: string, alerted?: boolean) => ({ sessionId: id, title: id, status, alerted, events: [] }) as unknown as Session;
const put = (...list: Session[]) => act(() => { useSessionStore.setState({ sessions: new Map(list.map((s) => [s.sessionId, s])) } as never); });

describe('useAlertNotifications', () => {
  const notify = vi.fn(async () => ({ ok: true }));
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { electronAPI: unknown }).electronAPI = { notify };
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    notify.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('notifies an alerted session that finishes, after the settle; a session without Alert stays quiet', () => {
    put(mk('a', 'working', true), mk('b', 'working'));
    renderHook(() => useAlertNotifications());
    put(mk('a', 'waiting', true), mk('b', 'waiting'));
    expect(notify).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(ALERT_NOTIFY_SETTLE_MS); });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ sessionId: 'a', title: 'a', body: 'Finished — ready for review' });
  });

  it('drops an approval that cleared within the settle', () => {
    put(mk('a', 'working', true));
    renderHook(() => useAlertNotifications());
    put(mk('a', 'approval', true));
    put(mk('a', 'working', true));
    act(() => { vi.advanceTimersByTime(ALERT_NOTIFY_SETTLE_MS); });
    expect(notify).not.toHaveBeenCalled();
  });
});
