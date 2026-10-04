import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';

import RobotListSidebar from './RobotListSidebar';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const closeManagedTerminal = vi.hoisted(() => vi.fn(async () => {}));
const showToast = vi.hoisted(() => vi.fn());

// The rail only renders on phones (useIsMobile), so pin the breakpoint on.
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => true,
}));
vi.mock('@/lib/terminalTransport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalTransport')>()),
  closeManagedTerminal,
}));
vi.mock('@/components/ui/ToastContainer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/ToastContainer')>()),
  showToast,
}));

const KILL_URL = '/api/sessions/pinned-1/kill';

const pinnedSession = (over: Partial<Session> = {}): Session => ({
  sessionId: 'pinned-1',
  title: 'KTS Agent',
  projectName: 'kts',
  projectPath: '/work/kts',
  status: 'idle',
  pinned: true,
  terminalId: 'term-1',
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  ...over,
} as Session);

/**
 * Closing a pinned card is not special. The server unpins it before it
 * terminates anything (apiRouter's kill route), so the sidebar has nothing to
 * confirm, flag or unpin — a confirm here, or a PUT /pinned before the kill, is
 * the old per-window workaround coming back.
 */
describe('RobotListSidebar — closing a pinned session', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    closeManagedTerminal.mockClear();
    showToast.mockClear();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, terminalId: 'term-1' }) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    useSessionStore.setState({ sessions: new Map([['pinned-1', pinnedSession()]]) });
  });

  afterEach(() => {
    // Unmount first: hooks run last-registered-first, so RTL's own cleanup would
    // otherwise run AFTER this store reset and re-render the mounted sidebar outside act().
    cleanup();
    useSessionStore.setState({ sessions: new Map() });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const fetchedUrls = () => fetchMock.mock.calls.map(([url]) => String(url));
  // The kill handler is a fire-and-forget async chain (fetch → json → close the
  // terminal → removeSession), so the click has to be awaited inside act().
  const clickClose = () => act(async () => { fireEvent.click(screen.getByText('✕')); });

  it('kills it straight away: no confirm, and no unpin call ahead of the kill', async () => {
    render(<RobotListSidebar />);

    await clickClose();

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(useSessionStore.getState().sessions.has('pinned-1')).toBe(false));
    expect(fetchedUrls()).toEqual([KILL_URL]);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ confirm: true });
    expect(closeManagedTerminal).toHaveBeenCalledWith('term-1');
  });

  it('does no pin bookkeeping when the kill fails: no local toggle and no PUT, the server owns the pin', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: 'Process 4343 could not be terminated', stillAlivePid: 4343 }),
    });
    render(<RobotListSidebar />);

    await clickClose();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('4343'), 'error'));
    expect(useSessionStore.getState().sessions.get('pinned-1')?.pinned).toBe(true);
    expect(fetchedUrls()).toEqual([KILL_URL]);
  });
});
