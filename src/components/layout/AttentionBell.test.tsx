// AttentionBell.test.tsx — the header bell (Nov 26 2026): what waits on the person, its list, its hint, and the
// alerts centrals raise. Stores are set directly; fetch is stubbed, so nothing reaches a server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useAttentionStore } from '@/stores/attentionStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { DEFAULT_ALERT_CONFIG } from '@/lib/attention';
import { HINT_SETTLE_MS, HINT_SHOW_MS } from '@/lib/attentionInbox';
import type { RaisedAlert, Session } from '@/types';

const sound = vi.hoisted(() => ({ play: vi.fn(), playLoud: vi.fn() }));
vi.mock('@/lib/soundEngine', () => ({ soundEngine: sound }));

import AttentionBell from './AttentionBell';

const mk = (sessionId: string, over: Partial<Session> = {}): Session =>
  ({ sessionId, status: 'working', title: `Title ${sessionId}`, projectName: 'proj', lastActivityAt: 1, ...over }) as Session;

function setSessions(list: Session[]): void {
  act(() => {
    useSessionStore.setState({ sessions: new Map(list.map((s) => [s.sessionId, s])) });
  });
}

const alert = (over: Partial<RaisedAlert> = {}): RaisedAlert => ({
  id: 'a1', key: 'stuck', sessionId: 'c1', centralId: 'central-1', centralSessionId: 'c1',
  message: 'Package stuck 45m', raisedAt: 1, updatedAt: Date.now(), count: 1, ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

function renderBell() {
  return render(
    <MemoryRouter initialEntries={['/queue']}>
      <Routes>
        <Route path="*" element={<AttentionBell />} />
      </Routes>
    </MemoryRouter>,
  );
}

const bell = () => screen.getByRole('button', { name: /waiting on you/i });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal('fetch', fetchMock);
  useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  useRoomStore.setState({ rooms: [] });
  useAlertConfigStore.setState({ config: DEFAULT_ALERT_CONFIG });
  useAttentionStore.setState({ alerts: [], hidden: new Set(), seenAt: new Map(), hint: null });
  sound.play.mockClear();
  sound.playLoud.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AttentionBell', () => {
  it('shows no count when nothing waits on the person', () => {
    renderBell();
    expect(bell()).toHaveAccessibleName('Nothing waiting on you');
    expect(screen.queryByTestId('attention-count')).not.toBeInTheDocument();
  });

  it('counts what waits, leaving out a Silent session', () => {
    setSessions([mk('q', { status: 'input' }), mk('a', { status: 'approval', pendingTool: 'Bash' }), mk('s', { status: 'input', alertLevel: 'silent' })]);
    renderBell();
    expect(screen.getByTestId('attention-count')).toHaveTextContent('2');
    expect(bell()).toHaveAccessibleName('2 waiting on you');
  });

  it('lists each wait, and Open takes the person to that session on LIVE', () => {
    setSessions([mk('q', { status: 'input', title: 'Pipeline Build' })]);
    renderBell();
    fireEvent.click(bell());
    const list = screen.getByRole('dialog', { name: 'Waiting on you' });
    expect(within(list).getByText('Pipeline Build')).toBeInTheDocument();
    expect(within(list).getByText(/needs your answer/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Open Pipeline Build' }));
    expect(useSessionStore.getState().selectedSessionId).toBe('q');
    expect(screen.queryByRole('dialog', { name: 'Waiting on you' })).not.toBeInTheDocument();
  });

  it('× hides a session’s wait until that moment is over, then the next one shows', () => {
    setSessions([mk('q', { status: 'input' })]);
    renderBell();
    fireEvent.click(bell());
    fireEvent.click(screen.getByRole('button', { name: 'Hide Title q' }));
    expect(bell()).toHaveAccessibleName('Nothing waiting on you');
    expect(screen.getByText('Nothing waiting on you')).toBeInTheDocument();
    setSessions([mk('q', { status: 'working' })]);
    setSessions([mk('q', { status: 'input' })]);
    expect(bell()).toHaveAccessibleName('1 waiting on you');
  });

  it('lists a central’s alert with its text and who raised it, and × dismisses it for everyone', () => {
    setSessions([mk('c1', { title: 'Content Central' }), mk('s1', { title: 'Pipeline Build' })]);
    act(() => useAttentionStore.getState().setAlerts([alert({ sessionId: 's1' })]));
    renderBell();
    fireEvent.click(bell());
    const list = screen.getByRole('dialog', { name: 'Waiting on you' });
    expect(within(list).getByText('Package stuck 45m')).toBeInTheDocument();
    expect(within(list).getByText(/from Content Central/)).toBeInTheDocument();
    fireEvent.click(within(list).getByRole('button', { name: 'Dismiss Pipeline Build' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/alerts/a1/dismiss', expect.objectContaining({ method: 'POST' }));
    expect(bell()).toHaveAccessibleName('Nothing waiting on you');
  });

  it('never shows the text of an alert as markup', () => {
    setSessions([mk('c1')]);
    act(() => useAttentionStore.getState().setAlerts([alert({ message: '<img src=x onerror=alert(1)> stuck' })]));
    renderBell();
    fireEvent.click(bell());
    expect(screen.getByText('<img src=x onerror=alert(1)> stuck')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('hints a new moment once it stands, never one that was there at the first look', () => {
    setSessions([mk('old', { status: 'input' })]);
    renderBell();
    act(() => { vi.advanceTimersByTime(HINT_SETTLE_MS + 10); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    setSessions([mk('old', { status: 'input' }), mk('new', { status: 'approval', pendingTool: 'Bash', title: 'Post XClaude' })]);
    act(() => { vi.advanceTimersByTime(HINT_SETTLE_MS + 10); });
    const hint = screen.getByRole('status');
    expect(hint).toHaveTextContent('Post XClaude');
    expect(hint).toHaveTextContent('approve Bash');
    act(() => { vi.advanceTimersByTime(HINT_SHOW_MS + 10); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('drops a hint whose moment cleared within the settle', () => {
    renderBell();
    setSessions([mk('a', { status: 'approval' })]);
    setSessions([mk('a', { status: 'working' })]);
    act(() => { vi.advanceTimersByTime(HINT_SETTLE_MS + 10); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('folds moments that come together into one hint', () => {
    renderBell();
    setSessions([mk('a', { status: 'input' }), mk('b', { status: 'input' }), mk('c', { status: 'input' })]);
    act(() => { vi.advanceTimersByTime(HINT_SETTLE_MS + 10); });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('+2 more');
  });

  it('sounds a central’s new alert at its level under the session’s own', () => {
    setSessions([mk('c1', { alertLevel: 'loud' }), mk('c2', { alertLevel: 'normal' })]);
    renderBell();
    act(() => useAttentionStore.getState().setAlerts([alert({ level: 'urgent' }), alert({ id: 'a2', sessionId: 'c2', level: 'loud' })]));
    act(() => { vi.advanceTimersByTime(HINT_SETTLE_MS + 10); });
    expect(sound.playLoud).toHaveBeenCalledTimes(1);
    expect(sound.play).toHaveBeenCalledWith('inputNeeded');
  });
});
