// SessionsScreen.test.tsx — the phone's Sessions tab (AASC-40): the host card,
// sections in order, rows that say what matters now, filters, search, group by
// room (AASC-55: fold, reorder, drag a session into a room, kill a room's shared
// sessions), the long-press menu (kill confirms), mark read, the New session
// sheet, and the empty / connecting states. Kill, launch and refresh are mocked
// at their request helpers, and every fetch (room kill's /kill included) is a
// stub: nothing reaches a process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/sessionActions', () => ({
  requestSessionKill: vi.fn(async () => ({ ok: true, message: 'PID 1 terminated' })),
  requestSessionResume: vi.fn(async () => ({ ok: true, message: 'Resuming' })),
}));
vi.mock('@/lib/restartSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restartSession')>()),
  requestSessionRestart: vi.fn(async () => ({ ok: true, terminalId: 'term-2' })),
}));
vi.mock('@/lib/terminalTransport', () => ({ closeManagedTerminal: vi.fn(async () => undefined) }));
vi.mock('@/lib/launchSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/launchSession')>()),
  launchSession: vi.fn(async () => ({ ok: true, terminalId: 'term-new', deduplicated: false })),
}));
vi.mock('@/lib/sessionRefresh', () => ({ refreshSessionList: vi.fn(async () => true) }));
vi.mock('@/lib/alarmEngine', () => ({ muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn() }));
vi.mock('@/hooks/useKnownProjects', () => ({
  useKnownProjects: () => ['/w/agent-manager', '/w/site'],
  useRankedProjects: () => ['/w/agent-manager', '/w/site'],
}));

import SessionsScreen from './SessionsScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { useUiStore } from '@/stores/uiStore';
import { requestSessionKill } from '@/lib/sessionActions';
import { showToast } from '@/components/ui/ToastContainer';
import { SESSION_DRAG_HOLD_MS } from './useSessionRoomDrag';
import { HOLD_MS as ROOM_HOLD_MS } from '@/hooks/useRoomDragReorder';
import { launchSession } from '@/lib/launchSession';
import { refreshSessionList } from '@/lib/sessionRefresh';
import { getSessionReads, resetSessionReadsForTest } from '@/lib/chat/sessionReads';
import { useCentralFeatureStore } from '@/stores/centralFeatureStore';

// The feature switch's answer is known up front, so no test sees its one GET /api/config among the calls it counts.
beforeEach(() => useCentralFeatureStore.setState({ on: true }));

const NOW = Date.now();

function session(id: string, title: string, status: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: id, title, status, projectName: 'agent-manager', projectPath: '/w/agent-manager', cliSource: 'claude',
    model: 'claude-opus-5-5', lastActivityAt: NOW - 60_000, startedAt: NOW - 3_600_000, terminalId: `term-${id}`, source: 'ssh',
    events: [], promptHistory: [], toolLog: [], responseLog: [],
    ...extra,
  } as unknown as Session;
}

const fixtures = () => new Map([
  ['s1', session('s1', 'Approve me', 'approval', { pendingTool: 'Bash', pendingToolDetail: 'npm test', remark: 'polish pass' })],
  ['s2', session('s2', 'Working one', 'working', { toolLog: [{ tool: 'Bash', input: 'npm run build', timestamp: NOW }] as never })],
  ['s3', session('s3', 'Done one', 'waiting', { responseLog: [{ text: 'All tests pass.', timestamp: NOW }] as never, projectName: 'site', projectPath: '/w/site' })],
  ['s4', session('s4', 'Idle one', 'idle')],
  ['s5', session('s5', 'Gone one', 'ended')],
]);

const room = (id: string, name: string, sessionIds: string[], listOrder: number) =>
  ({ id, name, sessionIds, collapsed: false, createdAt: 0, roomIndex: listOrder, listOrder }) as unknown as Room;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  localStorage.clear();
  // Most tests read the status sections: an explicit choice, as a phone that picked Status has.
  localStorage.setItem('aasc.phoneSessionsGroup', 'status');
  resetSessionReadsForTest();
  useSessionStore.setState({ sessions: fixtures(), selectedSessionId: null });
  useWsStore.setState({ snapshotReceived: true, connected: true, hiddenCount: 0 });
  useRoomStore.setState({ rooms: [room('r1', 'Mobile', ['s1', 's3'], 0), room('r2', 'Backend', ['s2'], 1)] });
  useLabelStore.setState({ labels: { s4: 'IMPORTANT' } });
  usePhoneNavStore.setState({ tab: 'sessions', stacks: defaultStacks() });
  vi.mocked(requestSessionKill).mockClear();
  vi.mocked(showToast).mockClear();
  vi.mocked(launchSession).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const region = (name: string) => screen.getByRole('region', { name });
const names = (el: HTMLElement) => within(el).getAllByTestId(/^session-row-/).map((r) => r.getAttribute('data-testid')!.replace('session-row-', ''));

describe('SessionsScreen', () => {
  it('says in one line whether the Mac is online, how it is reached and which Mac (Oct 19 2026: no card)', () => {
    render(<SessionsScreen />);
    const strip = screen.getByRole('region', { name: 'Your Mac' });
    expect(strip.textContent).toMatch(/^Online · .+ · .+$/);
    // The counts are the chips' (All N, Needs you N); the ＋ is the nav bar's.
    expect(strip.textContent).not.toContain('live');
    expect(within(strip).queryByRole('button')).toBeNull();
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
  });

  it('puts the title in the bar: no separate large title row', () => {
    render(<SessionsScreen />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sessions');
    expect(document.querySelector('[class*="largeTitle"]')).toBeNull();
  });

  it('lists Needs you, Working, Finished and Idle in that order, ended sessions left for History', () => {
    render(<SessionsScreen />);
    expect(names(region('Needs you'))).toEqual(['s1']);
    expect(names(region('Working'))).toEqual(['s2']);
    expect(names(region('Finished'))).toEqual(['s3']);
    expect(names(region('Idle'))).toEqual(['s4']);
    expect(screen.queryByTestId('session-row-s5')).toBeNull();
  });

  it('says what matters now on each row, with project and room, and no label (labels stay on the device that set them)', () => {
    render(<SessionsScreen />);
    const ask = screen.getByTestId('session-row-s1');
    expect(ask.textContent).toContain('Wants to run: npm test');
    expect(ask.textContent).toContain('Mobile');
    expect(ask.getAttribute('aria-label')).toMatch(/Approve me, Claude Code, Waiting for approval, Wants to run: npm test/);
    expect(screen.getByTestId('session-row-s2').textContent).toContain('Bash: npm run build');
    expect(screen.getByTestId('session-row-s3').textContent).toContain('All tests pass.');
    expect(screen.getByTestId('session-row-s4').textContent).not.toContain('IMPORTANT');
  });

  it('filters to the sessions that need you or are working', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'Needs you 1' }));
    expect(screen.getAllByTestId(/^session-row-/).map((r) => r.dataset.testid)).toEqual(['session-row-s1']);
    await user.click(screen.getByRole('button', { name: 'Working 1' }));
    expect(screen.getAllByTestId(/^session-row-/).map((r) => r.dataset.testid)).toEqual(['session-row-s2']);
    await user.click(screen.getByRole('button', { name: 'All 4' }));
    expect(screen.getAllByTestId(/^session-row-/)).toHaveLength(4);
  });

  it('searches by name, project and remark (not by label, which the phone no longer shows)', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const box = screen.getByRole('searchbox', { name: 'Search sessions' });
    await user.type(box, 'polish');
    expect(screen.getAllByTestId(/^session-row-/).map((r) => r.dataset.testid)).toEqual(['session-row-s1']);
    await user.clear(box);
    await user.type(box, 'important');
    expect(screen.queryAllByTestId(/^session-row-/)).toEqual([]);
    await user.clear(box);
    await user.type(box, 'nothing like this');
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('opens a session on its chat and marks it read here', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByTestId('session-row-s3'));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s3/chat']);
    // Stamped on the Mac's clock: the session's own last activity.
    expect(getSessionReads().s3).toBe(NOW - 60_000);
  });

  it('marks a finished turn read from the row menu, which moves it to Idle', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    fireEvent.contextMenu(screen.getByTestId('session-row-s3'));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark read' }));
    expect(screen.queryByRole('region', { name: 'Finished' })).toBeNull();
    expect(names(region('Idle'))).toContain('s3');
  });

  it('offers rename, remark, room, fork, clone, restart and kill on a long press, and no label; kill confirms', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    fireEvent.contextMenu(screen.getByTestId('session-row-s2'));
    const menu = await screen.findByRole('menu', { name: 'Actions for Working one' });
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    for (const label of ['Rename', 'Remark…', 'Move to room…', 'Fork', 'Clone', 'Restart…', 'Kill…']) {
      expect(items.some((t) => t?.startsWith(label))).toBe(true);
    }
    expect(items.some((t) => t?.startsWith('Label'))).toBe(false);
    expect(items.some((t) => /Pin/.test(t ?? ''))).toBe(false);
    await user.click(within(menu).getByRole('menuitem', { name: /Kill/ }));
    expect(requestSessionKill).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Kill this session?' });
    await user.click(within(confirm).getByRole('button', { name: 'Kill session' }));
    await waitFor(() => expect(requestSessionKill).toHaveBeenCalledWith('s2', 'term-s2'));
  });

  it('renames from the long-press menu, never saving an untouched name', async () => {
    const user = userEvent.setup();
    const setTitle = vi.spyOn(useSessionStore.getState(), 'setSessionTitle');
    render(<SessionsScreen />);
    fireEvent.contextMenu(screen.getByTestId('session-row-s4'));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const sheet = await screen.findByRole('dialog', { name: 'Rename' });
    const save = within(sheet).getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    const input = within(sheet).getByRole('textbox', { name: 'Session name' });
    await user.clear(input);
    await user.type(input, 'Better name{Enter}');
    expect(setTitle).toHaveBeenCalledWith('s4', 'Better name');
  });

  describe('the grouping a phone starts on (Oct 20 2026: rooms first, like the desktop strip)', () => {
    beforeEach(() => localStorage.removeItem('aasc.phoneSessionsGroup'));
    const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);

    it('opens grouped by room, with room management, when the Mac has rooms', () => {
      render(<SessionsScreen />);
      expect(screen.getByRole('button', { name: 'By room' })).toBeTruthy();
      expect(screen.getByRole('button', { name: /New or manage rooms/ })).toBeTruthy();
      // Recent first, as the desktop rail's RECENT frame (s1 and s2 have a turn running).
      expect(headings()).toEqual(['Recent · 2', 'Mobile · 2', 'Backend · 1', 'No room · 1']);
      // Not a choice this phone made: nothing is saved until it picks one.
      expect(localStorage.getItem('aasc.phoneSessionsGroup')).toBeNull();
    });

    it('opens by status when the Mac has no rooms', () => {
      useRoomStore.setState({ rooms: [] });
      render(<SessionsScreen />);
      expect(screen.getByRole('button', { name: 'By status' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /New or manage rooms/ })).toBeNull();
    });

    it('keeps the grouping this phone chose', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: 'By room' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Group sessions by' })).getByRole('button', { name: /^Status/ }));
      expect(localStorage.getItem('aasc.phoneSessionsGroup')).toBe('status');
      unmount();
      render(<SessionsScreen />);
      expect(screen.getByRole('button', { name: 'By status' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: /New or manage rooms/ })).toBeNull();
    });
  });

  it('groups by room in the Mac\'s order, an empty room too', async () => {
    const user = userEvent.setup();
    useRoomStore.setState({ rooms: [...useRoomStore.getState().rooms, room('r3', 'Spare', [], 2)] });
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'By status' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Group sessions by' })).getByRole('button', { name: /^Room/ }));
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Recent · 2', 'Mobile · 2', 'Backend · 1', 'Spare · 0', 'No room · 1']);
    expect(screen.getByText(/No sessions\. Hold a session’s ≡/)).toBeTruthy();
  });

  describe('grouped by room (AASC-55)', () => {
    const fetchMock = vi.fn();
    const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => String(u) === url);
    const opBodies = () => calls('/api/rooms/ops').map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 300, width: 300, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

    beforeEach(() => {
      localStorage.setItem('aasc.phoneSessionsGroup', 'room');
      fetchMock.mockReset();
      fetchMock.mockImplementation(async (url: string) => (String(url) === '/api/rooms/ops'
        ? new Response(JSON.stringify({ ok: true, opId: 'op-1' }), { status: 202 })
        : new Response(JSON.stringify({ ok: true, terminalId: null }), { status: 200 })));
      vi.stubGlobal('fetch', fetchMock);
    });

    it('kills only the room\'s sessions shared with this phone, after a confirm, and says the rest were left running', async () => {
      const user = userEvent.setup();
      const sessions = fixtures();
      sessions.set('s1', { ...sessions.get('s1')!, remoteVisible: true });
      sessions.set('s3', { ...sessions.get('s3')!, remoteVisible: false }); // a stale copy: never shared
      useSessionStore.setState({ sessions });
      render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: 'Actions for the room Mobile' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Room “Mobile”' })).getByRole('button', { name: /Kill all sessions/ }));
      const confirm = await screen.findByRole('dialog', { name: 'Kill all sessions in “Mobile”?' });
      expect(confirm.textContent).toContain('Approve me');
      expect(confirm.textContent).not.toContain('Done one');
      expect(confirm.textContent).toContain('never touched');
      await user.click(within(confirm).getByRole('button', { name: 'Kill 1' }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        'Killed 1 in “Mobile”. Sessions not shared with this phone were left running.', 'success'));
      const killed = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith('/kill'));
      expect(killed).toEqual(['/api/sessions/s1/kill']);
    });

    // Found on a real iPhone (Oct 2026): with no session shared, rooms couldn't be made, renamed
    // or deleted from the phone at all (a test room was left on the Mac).
    it('still offers New or manage rooms when no session is shared with this phone', () => {
      useSessionStore.setState({ sessions: new Map() });
      render(<SessionsScreen />);
      expect(screen.getByRole('button', { name: 'New or manage rooms' })).toBeTruthy();
    });

    it('offers no room kill when none of its live sessions is shared with this phone', async () => {
      const user = userEvent.setup();
      render(<SessionsScreen />); // the fixtures carry no remoteVisible
      await user.click(screen.getByRole('button', { name: 'Actions for the room Mobile' }));
      const menu = await screen.findByRole('dialog', { name: 'Room “Mobile”' });
      expect(within(menu).getByText('No live sessions shared with this phone in this room.')).toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('Recent, the desktop rail\'s built-in frame (Oct 20 2026)', () => {
      beforeEach(() => useUiStore.setState({ recentRoomCollapsed: false }));

      it('comes first: the sessions with a turn running or work in the last 30 min, each also in its own room', () => {
        render(<SessionsScreen />);
        expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Recent · 2', 'Mobile · 2', 'Backend · 1', 'No room · 1']);
        expect(names(screen.getByTestId('room-group-recent'))).toEqual(['s1', 's2']);
        expect(names(screen.getByTestId('room-group-r1'))).toEqual(['s1', 's3']);
        expect(names(screen.getByTestId('room-group-r2'))).toEqual(['s2']);
      });

      it('is not a room: no ≡ to reorder, no ⋯ menu, no drag grips, and each row says its room', () => {
        render(<SessionsScreen />);
        const recent = screen.getByTestId('room-group-recent');
        expect(within(recent).queryByRole('button', { name: /^Actions for the room/ })).toBeNull();
        expect(within(recent).queryByTestId(/^room-grip-/)).toBeNull();
        expect(within(recent).queryByTestId(/^session-grip-/)).toBeNull();
        expect(within(within(recent).getByTestId('session-row-s1')).getByText('Mobile')).toBeTruthy();
        expect(within(screen.getByTestId('room-group-r1')).getByTestId('session-grip-s1')).toBeTruthy();
      });

      it('folds with the desktop\'s own Recent flag, on this device', async () => {
        const user = userEvent.setup();
        render(<SessionsScreen />);
        await user.click(screen.getByRole('button', { name: /^Recent, 2 sessions/ }));
        expect(useUiStore.getState().recentRoomCollapsed).toBe(true);
        expect(within(screen.getByTestId('room-group-recent')).queryByTestId('session-row-s1')).toBeNull();
        expect(screen.getByRole('button', { name: /^Recent, 2 sessions.*folded/ }).getAttribute('aria-expanded')).toBe('false');
        expect(within(screen.getByTestId('room-group-r1')).getByTestId('session-row-s1')).toBeTruthy();
      });

      it('is only in the By room view', () => {
        localStorage.setItem('aasc.phoneSessionsGroup', 'status');
        render(<SessionsScreen />);
        expect(screen.queryByTestId('room-group-recent')).toBeNull();
        expect(screen.queryByRole('heading', { name: /^Recent/ })).toBeNull();
      });
    });

    describe('Pinned, the desktop rail\'s built-in frame (Oct 22 2026)', () => {
      const pinS3 = () => {
        const sessions = fixtures();
        sessions.set('s3', { ...sessions.get('s3')!, pinned: true });
        useSessionStore.setState({ sessions });
      };
      beforeEach(() => useUiStore.setState({ pinnedRoomCollapsed: false, recentRoomCollapsed: false }));

      it('comes before Recent with the pinned sessions, each also in its own room', () => {
        pinS3();
        render(<SessionsScreen />);
        expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Pinned · 1', 'Recent · 2', 'Mobile · 2', 'Backend · 1', 'No room · 1']);
        expect(names(screen.getByTestId('room-group-pinned'))).toEqual(['s3']);
        expect(names(screen.getByTestId('room-group-r1'))).toContain('s3');
      });

      it('is not a room: no ⋯, no grips, each row says its room; folds with the desktop\'s flag on this device', async () => {
        pinS3();
        const user = userEvent.setup();
        render(<SessionsScreen />);
        const pinned = screen.getByTestId('room-group-pinned');
        expect(within(pinned).queryByRole('button', { name: /^Actions for the room/ })).toBeNull();
        expect(within(pinned).queryByTestId(/^session-grip-/)).toBeNull();
        expect(within(within(pinned).getByTestId('session-row-s3')).getByText('Mobile')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /^Pinned, 1 session pinned, also in their rooms, open/ }));
        expect(useUiStore.getState().pinnedRoomCollapsed).toBe(true);
        expect(within(screen.getByTestId('room-group-pinned')).queryByTestId('session-row-s3')).toBeNull();
        expect(within(screen.getByTestId('room-group-r1')).getByTestId('session-row-s3')).toBeTruthy();
      });

      it('is left out with nothing pinned', () => {
        render(<SessionsScreen />);
        expect(screen.queryByTestId('room-group-pinned')).toBeNull();
      });
    });

    describe('Central, the desktop rail\'s built-in frame (Oct 27 2026)', () => {
      const centralS3 = () => {
        const sessions = fixtures();
        sessions.set('s3', { ...sessions.get('s3')!, pinned: true, central: { centralId: 'c1', kind: 'global', scopeRef: null } });
        useSessionStore.setState({ sessions });
      };
      beforeEach(() => useUiStore.setState({ centralRoomCollapsed: false, pinnedRoomCollapsed: false, recentRoomCollapsed: false }));

      it('comes first, before Pinned, with the central sessions, each also in its own room', () => {
        centralS3();
        render(<SessionsScreen />);
        expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Central · 1', 'Pinned · 1', 'Recent · 2', 'Mobile · 2', 'Backend · 1', 'No room · 1']);
        expect(names(screen.getByTestId('room-group-central'))).toEqual(['s3']);
        expect(names(screen.getByTestId('room-group-r1'))).toContain('s3');
      });

      it('is not a room: no ⋯, no grips; folds with the desktop\'s flag on this device', async () => {
        centralS3();
        const user = userEvent.setup();
        render(<SessionsScreen />);
        const central = screen.getByTestId('room-group-central');
        expect(within(central).queryByRole('button', { name: /^Actions for the room/ })).toBeNull();
        expect(within(central).queryByTestId(/^session-grip-/)).toBeNull();
        await user.click(screen.getByRole('button', { name: /^Central, 1 session central, also in their rooms, open/ }));
        expect(useUiStore.getState().centralRoomCollapsed).toBe(true);
        expect(within(screen.getByTestId('room-group-central')).queryByTestId('session-row-s3')).toBeNull();
        expect(within(screen.getByTestId('room-group-r1')).getByTestId('session-row-s3')).toBeTruthy();
      });

      it('is left out with no central session', () => {
        render(<SessionsScreen />);
        expect(screen.queryByTestId('room-group-central')).toBeNull();
      });
    });

    it('folds a room on this phone only, and keeps it folded after a reload', async () => {
      const user = userEvent.setup();
      const { unmount } = render(<SessionsScreen />);
      const toggle = screen.getByRole('button', { name: /^Mobile, 2 sessions, open/ });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      await user.click(toggle);
      expect(screen.getByRole('button', { name: /^Mobile, 2 sessions, folded/ }).getAttribute('aria-expanded')).toBe('false');
      // The room folds; s1 is still listed in Recent, which is not this room.
      const inMobile = () => within(screen.getByTestId('room-group-r1'));
      expect(inMobile().queryByTestId('session-row-s1')).toBeNull();
      expect(within(screen.getByTestId('room-group-recent')).getByTestId('session-row-s1')).toBeTruthy();
      expect(useRoomStore.getState().rooms.find((r) => r.id === 'r1')?.collapsed).toBe(false); // the Mac's flag untouched
      unmount();
      render(<SessionsScreen />);
      expect(inMobile().queryByTestId('session-row-s1')).toBeNull();
      expect(within(screen.getByTestId('room-group-r2')).getByTestId('session-row-s2')).toBeTruthy();
    });

    it('moves a room down from its menu: one reorder op to the Mac, never a roomIndex', async () => {
      const user = userEvent.setup();
      render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: 'Actions for the room Mobile' }));
      const menu = await screen.findByRole('dialog', { name: 'Room “Mobile”' });
      expect(within(menu).getByText('It is first already.')).toBeTruthy();
      await user.click(within(menu).getByRole('button', { name: 'Move down' }));
      await waitFor(() => expect(opBodies()).toEqual([{ type: 'reorder', roomIds: ['r2', 'r1'] }]));
      // The accepted reorder shows here at once; the 3D slots stay as they were.
      await waitFor(() => expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Recent · 2', 'Backend · 1', 'Mobile · 2', 'No room · 1']));
      expect(useRoomStore.getState().rooms.map((r) => r.roomIndex)).toEqual([0, 1]);
    });

    it('renames, recolours and deletes a room from its menu by asking the Mac', async () => {
      const user = userEvent.setup();
      render(<SessionsScreen />);
      const openMenu = async () => {
        await user.click(screen.getByRole('button', { name: 'Actions for the room Backend' }));
        return screen.findByRole('dialog', { name: 'Room “Backend”' });
      };
      await user.click(within(await openMenu()).getByRole('button', { name: 'Colour…' }));
      await user.click(within(await screen.findByTestId('room-edit')).getByRole('button', { name: 'Blue' }));
      await user.click(within(await openMenu()).getByRole('button', { name: 'Rename…' }));
      const name = within(await screen.findByTestId('room-edit')).getByRole('textbox', { name: 'New name for Backend' });
      await user.clear(name);
      await user.type(name, 'Server{Enter}');
      await user.click(within(await openMenu()).getByRole('button', { name: 'Delete room…' }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Delete room "Backend"?' })).getByRole('button', { name: 'Delete room' }));
      await waitFor(() => expect(opBodies()).toEqual([
        { type: 'color', roomId: 'r2', color: expect.any(String) },
        { type: 'rename', roomId: 'r2', name: 'Server' },
        { type: 'delete', roomId: 'r2' },
      ]));
    });

    it('opens Move to room from a session\'s grip tap', async () => {
      const user = userEvent.setup();
      render(<SessionsScreen />);
      await user.click(screen.getByTestId('session-grip-s1'));
      expect(await screen.findByTestId('move-to-room')).toBeTruthy();
    });

    it('drags a session into another room from its grip (hold, move, let go)', async () => {
      vi.useFakeTimers();
      try {
        render(<SessionsScreen />);
        vi.spyOn(screen.getByTestId('room-group-r1'), 'getBoundingClientRect').mockReturnValue(rect(0, 200));
        vi.spyOn(screen.getByTestId('room-group-r2'), 'getBoundingClientRect').mockReturnValue(rect(216, 400));
        vi.spyOn(screen.getByTestId('room-group-none'), 'getBoundingClientRect').mockReturnValue(rect(416, 600));
        const grip = screen.getByTestId('session-grip-s1');
        fireEvent.pointerDown(grip, { pointerId: 1, clientX: 20, clientY: 60, pointerType: 'touch' });
        act(() => { vi.advanceTimersByTime(SESSION_DRAG_HOLD_MS + 10); });
        fireEvent.pointerMove(grip, { pointerId: 1, clientX: 20, clientY: 300 });
        expect(screen.getByTestId('room-group-r2').hasAttribute('data-drop-target')).toBe(true);
        fireEvent.pointerUp(grip, { pointerId: 1, clientX: 20, clientY: 300 });
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(opBodies()).toEqual([{ type: 'move', sessionId: 's1', roomId: 'r2' }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a grip that moves before the hold is a scroll: nothing is dragged or sent', () => {
      vi.useFakeTimers();
      try {
        render(<SessionsScreen />);
        const grip = screen.getByTestId('session-grip-s1');
        fireEvent.pointerDown(grip, { pointerId: 1, clientX: 20, clientY: 60, pointerType: 'touch' });
        fireEvent.pointerMove(grip, { pointerId: 1, clientX: 20, clientY: 120 });
        act(() => { vi.advanceTimersByTime(SESSION_DRAG_HOLD_MS + 10); });
        fireEvent.pointerUp(grip, { pointerId: 1, clientX: 20, clientY: 120 });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a finger carried down from either grip never pulls the list to refresh', () => {
      render(<SessionsScreen />);
      vi.mocked(refreshSessionList).mockClear();
      for (const grip of [screen.getByTestId('session-grip-s1'), screen.getByTestId('room-grip-r1')]) {
        fireEvent.touchStart(grip, { touches: [{ clientX: 20, clientY: 60 }] });
        fireEvent.touchMove(grip, { touches: [{ clientX: 20, clientY: 460 }] });
        fireEvent.touchEnd(grip, { touches: [] });
      }
      expect(screen.getByTestId('phone-sessions').querySelector('[data-pull="idle"]')).toBeTruthy();
      expect(refreshSessionList).not.toHaveBeenCalled();
    });

    it('a held session whose row re-renders mid-drag (the Mac moved it) still lets go', () => {
      vi.useFakeTimers();
      try {
        render(<SessionsScreen />);
        const grip = screen.getByTestId('session-grip-s1');
        fireEvent.pointerDown(grip, { pointerId: 7, clientX: 20, clientY: 60, pointerType: 'touch' });
        act(() => { vi.advanceTimersByTime(SESSION_DRAG_HOLD_MS + 10); });
        expect(document.querySelector('[data-session-drag]')).toBeTruthy();
        // A rooms_update moves s1 into Backend: its row (and grip) is now another element.
        act(() => { useRoomStore.setState({ rooms: [room('r1', 'Mobile', ['s3'], 0), room('r2', 'Backend', ['s2', 's1'], 1)] }); });
        fireEvent.pointerUp(window, { pointerId: 7, clientX: 20, clientY: 60 });
        expect(document.querySelector('[data-session-drag]')).toBeNull();
        expect(document.querySelector('li[data-dragging]')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('drags a room below another from its ≡ (hold first on touch): a reorder op', async () => {
      vi.useFakeTimers();
      try {
        render(<SessionsScreen />);
        vi.spyOn(screen.getByTestId('room-group-r1'), 'getBoundingClientRect').mockReturnValue(rect(0, 200));
        vi.spyOn(screen.getByTestId('room-group-r2'), 'getBoundingClientRect').mockReturnValue(rect(216, 400));
        fireEvent.pointerDown(screen.getByTestId('room-grip-r1'), { pointerId: 1, button: 0, clientX: 10, clientY: 20, pointerType: 'touch' });
        act(() => { vi.advanceTimersByTime(ROOM_HOLD_MS + 10); });
        fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 420 });
        fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 420 });
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(opBodies()).toEqual([{ type: 'reorder', roomIds: ['r2', 'r1'] }]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('folds a long Idle section and unfolds it', async () => {
    const user = userEvent.setup();
    const many = fixtures();
    for (let i = 0; i < 6; i++) many.set(`i${i}`, session(`i${i}`, `Idle ${i}`, 'idle'));
    useSessionStore.setState({ sessions: many });
    render(<SessionsScreen />);
    expect(within(region('Idle')).queryAllByTestId(/^session-row-/)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Show 7' }));
    expect(within(region('Idle')).getAllByTestId(/^session-row-/)).toHaveLength(7);
  });

  it('starts Claude in a recent project in one tap, or opens the full form', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'New session' }));
    const sheet = await screen.findByRole('dialog', { name: 'New session' });
    await user.click(within(sheet).getByRole('button', { name: 'New Claude session in agent-manager' }));
    expect(launchSession).toHaveBeenCalledWith({ workingDir: '/w/agent-manager', command: 'claude', forceNew: true, requireExistingDir: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    await user.click(screen.getByRole('button', { name: 'New session' }));
    const again = await screen.findByRole('dialog', { name: 'New session' });
    await user.click(within(again).getByRole('button', { name: 'More options…' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
    act(() => useUiStore.getState().closeModal());
  });

  it('says how to share a session when none is shared with this phone', () => {
    useSessionStore.setState({ sessions: new Map() });
    useWsStore.setState({ hiddenCount: 2 });
    render(<SessionsScreen />);
    expect(screen.getByText('No sessions here yet')).toBeTruthy();
    expect(screen.getByText(/2 sessions run on your Mac but aren’t shared/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start a session' })).toBeTruthy();
  });

  it('says it is connecting before the first snapshot, with a retry', () => {
    useWsStore.setState({ snapshotReceived: false, connected: false });
    render(<SessionsScreen />);
    expect(screen.getByRole('status').textContent).toContain('Connecting to your Mac…');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps the list while reconnecting, and says it is reconnecting', () => {
    useWsStore.setState({ connected: false });
    render(<SessionsScreen />);
    expect(screen.getByTestId('session-row-s1')).toBeTruthy();
    const strip = screen.getByRole('region', { name: 'Your Mac' });
    expect(strip.textContent).toMatch(/^Reconnecting… · /);
  });

  describe('desktop parity (Oct 20 2026)', () => {
    it('keeps the grouping chip outside the scrolling filters, so it is never cut off', () => {
      render(<SessionsScreen />);
      const filters = screen.getByRole('group', { name: 'Show' });
      expect(within(filters).queryByRole('button', { name: /^By / })).toBeNull();
      expect(screen.getByRole('button', { name: /^By status/ })).toBeTruthy();
    });

    it('groups by recent activity, as the desktop strip’s Recent view: one list, most recently active first', async () => {
      const user = userEvent.setup();
      const many = fixtures();
      many.set('s2', session('s2', 'Working one', 'working', { lastActivityAt: NOW - 1000 }));
      many.set('s4', session('s4', 'Idle one', 'idle', { lastActivityAt: NOW - 500_000 }));
      useSessionStore.setState({ sessions: many });
      render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: /^By status/ }));
      await user.click(within(await screen.findByTestId('group-by-sheet')).getByRole('button', { name: /Recent activity/ }));
      expect(names(region('Recent activity'))).toEqual(['s2', 's1', 's3', 's4']);
      expect(localStorage.getItem('aasc.phoneSessionsGroup')).toBe('activity');
    });

    it('starts a session in a project group’s folder from its ＋, as the desktop’s project frames do', async () => {
      const user = userEvent.setup();
      localStorage.setItem('aasc.phoneSessionsGroup', 'project');
      render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: 'New session in site' }));
      const sheet = await screen.findByRole('dialog', { name: 'New session' });
      const starts = within(sheet).getAllByRole('button', { name: /^New Claude session in / });
      expect(starts[0].getAttribute('aria-label')).toBe('New Claude session in site');
    });

    it('finds a word in the sessions’ prompts, answers and tools, and opens the session it is in', async () => {
      const user = userEvent.setup();
      render(<SessionsScreen />);
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await user.type(screen.getByRole('searchbox', { name: 'Search sessions' }), 'tests pass');
      const found = screen.getByRole('region', { name: 'In conversations' });
      const hit = within(found).getByRole('button', { name: /Done one/ });
      expect(hit.textContent).toContain('All tests pass.');
      await user.click(hit);
      expect(usePhoneNavStore.getState().stacks.sessions.at(-1)).toBe('/sessions/s3/chat');
    });
  });
});
