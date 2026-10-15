// SessionsScreen.test.tsx — the phone's Sessions tab (AASC-40): the host card,
// sections in order, rows that say what matters now, filters, search, group by
// room with room kill-all, the long-press menu (kill confirms), mark read, the
// New session sheet, and the empty / connecting states. Kill, room kill, launch
// and refresh are mocked at their request helpers: nothing reaches a process.
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
vi.mock('@/lib/roomKill', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/roomKill')>()),
  killRoomSessions: vi.fn(async () => ({ killed: 2, failed: 0 })),
}));
vi.mock('@/lib/launchSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/launchSession')>()),
  launchSession: vi.fn(async () => ({ ok: true, terminalId: 'term-new', deduplicated: false })),
}));
vi.mock('@/lib/sessionRefresh', () => ({ refreshSessionList: vi.fn(async () => true) }));
vi.mock('@/lib/alarmEngine', () => ({ muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn() }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => ['/w/agent-manager', '/w/site'] }));

import SessionsScreen from './SessionsScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { useUiStore } from '@/stores/uiStore';
import { requestSessionKill } from '@/lib/sessionActions';
import { killRoomSessions } from '@/lib/roomKill';
import { launchSession } from '@/lib/launchSession';
import { getSessionReads, resetSessionReadsForTest } from '@/lib/chat/sessionReads';

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
  resetSessionReadsForTest();
  useSessionStore.setState({ sessions: fixtures(), selectedSessionId: null });
  useWsStore.setState({ snapshotReceived: true, connected: true, hiddenCount: 0 });
  useRoomStore.setState({ rooms: [room('r1', 'Mobile', ['s1', 's3'], 0), room('r2', 'Backend', ['s2'], 1)] });
  useLabelStore.setState({ labels: { s4: 'IMPORTANT' } });
  usePhoneNavStore.setState({ tab: 'sessions', stacks: defaultStacks() });
  vi.mocked(requestSessionKill).mockClear();
  vi.mocked(killRoomSessions).mockClear();
  vi.mocked(launchSession).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const region = (name: string) => screen.getByRole('region', { name });
const names = (el: HTMLElement) => within(el).getAllByTestId(/^session-row-/).map((r) => r.getAttribute('data-testid')!.replace('session-row-', ''));

describe('SessionsScreen', () => {
  it('shows the Mac, its live count and how many need you', () => {
    render(<SessionsScreen />);
    const card = screen.getByRole('region', { name: 'Your Mac' });
    expect(within(card).getByText('Online', { exact: false })).toBeTruthy();
    expect(card.textContent).toContain('4 live');
    expect(card.textContent).toContain('1 needs you');
    expect(within(card).getByRole('button', { name: /New session here/ })).toBeTruthy();
  });

  it('lists Needs you, Working, Finished and Idle in that order, ended sessions left for History', () => {
    render(<SessionsScreen />);
    expect(names(region('Needs you'))).toEqual(['s1']);
    expect(names(region('Working'))).toEqual(['s2']);
    expect(names(region('Finished'))).toEqual(['s3']);
    expect(names(region('Idle'))).toEqual(['s4']);
    expect(screen.queryByTestId('session-row-s5')).toBeNull();
  });

  it('says what matters now on each row, with project, room and label', () => {
    render(<SessionsScreen />);
    const ask = screen.getByTestId('session-row-s1');
    expect(ask.textContent).toContain('Wants to run: npm test');
    expect(ask.textContent).toContain('Mobile');
    expect(ask.getAttribute('aria-label')).toMatch(/Approve me, Claude Code, Waiting for approval, Wants to run: npm test/);
    expect(screen.getByTestId('session-row-s2').textContent).toContain('Bash: npm run build');
    expect(screen.getByTestId('session-row-s3').textContent).toContain('All tests pass.');
    expect(screen.getByTestId('session-row-s4').textContent).toContain('IMPORTANT');
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

  it('searches by name, project, label and remark', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'Search sessions' }));
    const box = screen.getByRole('searchbox', { name: 'Search sessions' });
    await user.type(box, 'polish');
    expect(screen.getAllByTestId(/^session-row-/).map((r) => r.dataset.testid)).toEqual(['session-row-s1']);
    await user.clear(box);
    await user.type(box, 'important');
    expect(screen.getAllByTestId(/^session-row-/).map((r) => r.dataset.testid)).toEqual(['session-row-s4']);
    await user.clear(box);
    await user.type(box, 'nothing like this');
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('opens a session on its chat and marks it read here', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByTestId('session-row-s3'));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s3/chat']);
    expect(getSessionReads().s3).toBeGreaterThanOrEqual(NOW);
  });

  it('marks a finished turn read from the row menu, which moves it to Idle', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    fireEvent.contextMenu(screen.getByTestId('session-row-s3'));
    await user.click(await screen.findByRole('menuitem', { name: 'Mark read' }));
    expect(screen.queryByRole('region', { name: 'Finished' })).toBeNull();
    expect(names(region('Idle'))).toContain('s3');
  });

  it('offers rename, label, remark, room, fork, clone, restart and kill on a long press; kill confirms', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    fireEvent.contextMenu(screen.getByTestId('session-row-s2'));
    const menu = await screen.findByRole('menu', { name: 'Actions for Working one' });
    const items = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    for (const label of ['Rename', 'Label…', 'Remark…', 'Move to room…', 'Fork', 'Clone', 'Restart…', 'Kill…']) {
      expect(items.some((t) => t?.startsWith(label))).toBe(true);
    }
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

  it('groups by room in the Mac\'s order, and kills a room after a confirm', async () => {
    const user = userEvent.setup();
    render(<SessionsScreen />);
    await user.click(screen.getByRole('button', { name: 'By status' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Group sessions by' })).getByRole('button', { name: /^Room/ }));
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Mobile · 2', 'Backend · 1', 'No room · 1']);
    await user.click(screen.getByRole('button', { name: 'Actions for the room Mobile' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Room “Mobile”' })).getByRole('button', { name: /Kill all sessions/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Kill all sessions in “Mobile”?' });
    expect(confirm.textContent).toContain('Approve me, Done one');
    await user.click(within(confirm).getByRole('button', { name: 'Kill 2' }));
    await waitFor(() => expect(killRoomSessions).toHaveBeenCalledWith('Mobile', expect.arrayContaining([expect.objectContaining({ sessionId: 's1' })])));
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
    await user.click(within(again).getByRole('button', { name: 'Other folder or more options…' }));
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

  it('keeps the list while reconnecting but says why a new session can’t start', () => {
    useWsStore.setState({ connected: false });
    render(<SessionsScreen />);
    expect(screen.getByTestId('session-row-s1')).toBeTruthy();
    const card = screen.getByRole('region', { name: 'Your Mac' });
    expect(card.textContent).toContain('Reconnecting…');
    expect(within(card).getByRole('button', { name: /New session here/ })).toHaveAttribute('aria-disabled', 'true');
  });
});
