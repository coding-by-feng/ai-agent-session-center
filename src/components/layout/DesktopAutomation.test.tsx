// DesktopAutomation.test.tsx — AASC-17: the phone app never runs the desktop's shared automation.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';

const calls = vi.hoisted(() => ({ save: 0, load: 0, queue: 0 }));
vi.mock('@/hooks/useWorkspaceAutoSave', () => ({ useWorkspaceAutoSave: () => { calls.save++; } }));
vi.mock('@/hooks/useWorkspaceAutoLoad', () => ({ useWorkspaceAutoLoad: () => { calls.load++; } }));
vi.mock('@/hooks/useGlobalQueueScheduler', () => ({ useGlobalQueueScheduler: () => { calls.queue++; } }));

import DesktopAutomationGate from './DesktopAutomation';
import { useSessionDeepLink } from '@/hooks/useSessionDeepLink';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { Session } from '@/types';

function withUserAgent(ua: string): void {
  vi.stubGlobal('navigator', { ...navigator, userAgent: ua });
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.save = calls.load = calls.queue = 0;
});

describe('DesktopAutomationGate', () => {
  it('runs workspace save/restore and the queue scheduler on the desktop', () => {
    withUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Electron/34');
    render(<DesktopAutomationGate />);
    expect(calls).toEqual({ save: 1, load: 1, queue: 1 });
  });

  it('runs none of them in the phone app', () => {
    withUserAgent('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)');
    render(<DesktopAutomationGate />);
    expect(calls).toEqual({ save: 0, load: 0, queue: 0 });
  });
});

describe('useSessionDeepLink', () => {
  function setLocation(search: string): void {
    window.history.replaceState(null, '', `/${search}`);
  }

  it('waits for the snapshot, then opens the session on the requested tab and clears the link', () => {
    setLocation('?session=s-visible&tab=conversation');
    const select = vi.fn();
    useSessionStore.setState({ sessions: new Map([['s-visible', { sessionId: 's-visible' } as Session]]), selectSession: select });
    useWsStore.setState({ snapshotReceived: false });
    renderHook(() => useSessionDeepLink());
    expect(select).not.toHaveBeenCalled();
    act(() => { useWsStore.setState({ snapshotReceived: true }); });
    expect(select).toHaveBeenCalledWith('s-visible');
    expect(localStorage.getItem('active-tab')).toBe('conversation');
    expect(window.location.search).toBe('');
  });

  it('does nothing for a session this device can’t see, but still clears the link', () => {
    setLocation('?session=s-hidden');
    const select = vi.fn();
    useSessionStore.setState({ sessions: new Map(), selectSession: select });
    useWsStore.setState({ snapshotReceived: true });
    renderHook(() => useSessionDeepLink());
    expect(select).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
});
