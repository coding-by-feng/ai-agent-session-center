import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session } from '@/types';
import { useProceedNotifications } from './useProceedNotifications';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { PROCEED_NOTIFY_SETTLE_MS } from '@/lib/proceedNotify';

const card = (id: string, over: Partial<Session> = {}) =>
  ({ sessionId: id, status: 'waiting', title: `T ${id}`, pendingProceedAt: null, ...over }) as unknown as Session;
const put = (...cards: Session[]) => useSessionStore.setState({ sessions: new Map(cards.map((c) => [c.sessionId, c])) });

let notify: ReturnType<typeof vi.fn>;
let openSession: ((id: string) => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  notify = vi.fn(() => Promise.resolve({ ok: true }));
  openSession = null;
  window.electronAPI = {
    notify,
    onOpenSession: (cb: (id: string) => void) => { openSession = cb; return () => { openSession = null; }; },
  } as unknown as typeof window.electronAPI;
  useSettingsStore.setState({ proceedNotifyEnabled: true });
  useSessionStore.setState({ selectedSessionId: null });
  useUiStore.setState({ detailPanelMinimized: false });
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  put(card('a'), card('b'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('useProceedNotifications', () => {
  it('notifies once an ask has stood for the settle time, with the name only', () => {
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify).toHaveBeenCalledWith({ sessionId: 'a', title: 'T a', body: 'Waiting for you to proceed' });
  });

  it('says nothing when a prompt answers it within the settle', () => {
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(1_000);
    put(card('a', { status: 'prompting' }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never for P marks already standing when it starts (launch, reconnect)', () => {
    put(card('a', { pendingProceedAt: 5 }));
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('not with the setting off, nor while that session is open in a focused window', () => {
    useSettingsStore.setState({ proceedNotifyEnabled: false });
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();

    useSettingsStore.setState({ proceedNotifyEnabled: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useSessionStore.setState({ selectedSessionId: 'b' });
    put(card('a', { pendingProceedAt: 5 }), card('b', { pendingProceedAt: 6 }));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('the open panel minimized counts as not looking', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useSessionStore.setState({ selectedSessionId: 'a' });
    useUiStore.setState({ detailPanelMinimized: true });
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a click opens that session in the panel', () => {
    useUiStore.setState({ detailPanelMinimized: true });
    renderHook(() => useProceedNotifications());
    openSession!('b');
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
  });

  it('does nothing outside the desktop app', () => {
    delete window.electronAPI;
    renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();
  });

  it('drops pending notices when it unmounts', () => {
    const { unmount } = renderHook(() => useProceedNotifications());
    put(card('a', { pendingProceedAt: 5 }), card('b'));
    unmount();
    vi.advanceTimersByTime(PROCEED_NOTIFY_SETTLE_MS);
    expect(notify).not.toHaveBeenCalled();
    expect(openSession).toBeNull();
  });
});
