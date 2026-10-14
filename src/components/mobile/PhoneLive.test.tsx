// PhoneLive.test.tsx — the LIVE page on a phone (AASC-18): one column of the
// board's cards, a tap opens the session, pull to refresh (and its button),
// search and new session from the header, quick-launch chips.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => ['/w/app', '/w/site'] }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PhoneLive from './PhoneLive';
import { PULL_THRESHOLD } from '@/hooks/usePullToRefresh';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore } from '@/stores/roomStore';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, title: id, projectName: 'app', status: 'idle', lastActivityAt: 1, events: [], promptHistory: [], ...over }) as unknown as Session;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useSessionStore.setState({
    sessions: new Map([['one', s('one', { status: 'approval' })], ['two', s('two')]]),
    selectedSessionId: null,
    previousSessionId: null,
  });
  useWsStore.setState({ snapshotReceived: true, connected: true, client: null });
  useUiStore.setState({
    activeModal: null,
    workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' },
    workspaceRestorePending: false,
    detailPanelMinimized: false,
  });
  useRoomStore.setState({ rooms: [] });
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/sessions') return { ok: true, json: async () => ({ one: s('one'), two: s('two'), three: s('three') }) } as Response;
    if (url === '/api/terminals') return { ok: true, json: async () => ({ ok: true, terminalId: 'term-new' }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const page = () => screen.getByTestId('phone-live');

/** A pull of `dy` px from the top of the list. */
function pull(dy: number) {
  const el = page();
  fireEvent.touchStart(el, { touches: [{ clientX: 100, clientY: 100 }] });
  fireEvent.touchMove(el, { touches: [{ clientX: 100, clientY: 100 + dy }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: 100, clientY: 100 + dy }] });
}

const sessionFetches = () => fetchMock.mock.calls.filter(([url]) => url === '/api/sessions').length;

describe('PhoneLive — the cards', () => {
  it('lists every session as a card, needs-you first, without the desktop HUD', () => {
    render(<PhoneLive />);
    const cards = screen.getAllByRole('button', { name: /^Open / });
    expect(cards.map((c) => c.getAttribute('data-session-id'))).toEqual(['one', 'two']);
    expect(within(cards[0]).getByText('Approval needed')).toBeInTheDocument();
    expect(screen.queryByText(/Units Online/i)).toBeNull();
  });

  it('a tap opens the session', () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: /^Open two/ }));
    expect(useSessionStore.getState().selectedSessionId).toBe('two');
  });

  it('says so when there is no session, and offers to start one', () => {
    useSessionStore.setState({ sessions: new Map() });
    render(<PhoneLive />);
    expect(screen.getByText('No sessions here yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument();
  });
});

describe('PhoneLive — pull to refresh', () => {
  it('a pull past the threshold re-requests the session list and shows the spinner', async () => {
    render(<PhoneLive />);
    act(() => pull(PULL_THRESHOLD * 2 + 20));
    expect(page().getAttribute('data-pull')).toBe('refreshing');
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    await waitFor(() => expect(sessionFetches()).toBe(1));
    await waitFor(() => expect(useSessionStore.getState().sessions.has('three')).toBe(true));
    await waitFor(() => expect(page().getAttribute('data-pull')).toBe('idle'), { timeout: 2000 });
  });

  it('a short pull does nothing', () => {
    render(<PhoneLive />);
    act(() => pull(20));
    expect(sessionFetches()).toBe(0);
    expect(page().getAttribute('data-pull')).toBe('idle');
  });

  it('a pull that starts below the top of the list is an ordinary scroll', () => {
    render(<PhoneLive />);
    page().scrollTop = 120;
    act(() => pull(PULL_THRESHOLD * 3));
    expect(sessionFetches()).toBe(0);
  });

  it('the refresh button does the same without a gesture', async () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh the session list' }));
    await waitFor(() => expect(sessionFetches()).toBe(1));
  });
});

describe('PhoneLive — search and new session', () => {
  it('search opens the global search', () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: 'Search all sessions' }));
    expect(useUiStore.getState().activeModal).toBe('global-search');
  });

  it('new session lists known projects with Claude and Codex chips that start a NEW session there', async () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const sheet = screen.getByRole('dialog', { name: 'New session' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'New Codex session in site' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      workingDir: '/w/site',
      command: 'codex',
      forceNew: true,
      requireExistingDir: true,
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    expect(useSessionStore.getState().selectedSessionId).toBe('term-new');
  });

  it('"More options…" opens the full new-session form', () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    fireEvent.click(screen.getByRole('button', { name: 'More options…' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('a drag inside the new-session sheet is not a pull on the list behind it', () => {
    render(<PhoneLive />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    const sheet = screen.getByRole('dialog', { name: 'New session' });
    act(() => {
      fireEvent.touchStart(sheet, { touches: [{ clientX: 100, clientY: 100 }] });
      fireEvent.touchMove(sheet, { touches: [{ clientX: 100, clientY: 400 }] });
      fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 100, clientY: 400 }] });
    });
    expect(sessionFetches()).toBe(0);
  });
});
