// InfoScreen.test.tsx — a session's Info on the phone (AASC-46): the facts in
// plain words, notifications as a switch, who drives, Open → its screens, the
// model sheet (typed through the Mac), the actions with kill / restart
// confirms, Resume once ended, and no Pin. Kill, restart and resume are mocked
// at their request helpers: nothing here reaches a real process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/sessionActions', () => ({
  requestSessionKill: vi.fn(async () => ({ ok: true, message: 'PID 1 terminated' })),
  requestSessionResume: vi.fn(async () => ({ ok: true, message: 'Resuming' })),
}));
vi.mock('@/lib/restartSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restartSession')>()),
  requestSessionRestart: vi.fn(async () => ({ ok: true, terminalId: 'term-2' })),
}));
vi.mock('@/lib/sessionCopy', () => ({ copySession: vi.fn(async () => 'term-copy') }));
vi.mock('@/lib/alarmEngine', () => ({ muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn() }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));

import InfoScreen from './InfoScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { requestSessionKill, requestSessionResume } from '@/lib/sessionActions';
import { requestSessionRestart } from '@/lib/restartSession';
import { copySession } from '@/lib/sessionCopy';
import { muteSession } from '@/lib/alarmEngine';
import { showToast } from '@/components/ui/ToastContainer';

const NOW = Date.now();

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', title: 'AASC Q & A', projectName: 'agent-manager', projectPath: '/w/agent-manager', status: 'working',
    source: 'ssh', terminalId: 'term-1', cliSource: 'claude', model: 'opus', startedAt: NOW - 72 * 60_000, lastActivityAt: NOW,
    remark: 'Polish pass', runtime: { model: 'claude-opus-5-5', effort: 'high', context: { pct: 38, size: 200_000 } },
    planUsage: { cli: 'claude', asOf: NOW, windows: [{ minutes: 300, usedPercent: 42, resetsAt: null }, { minutes: 10_080, usedPercent: 61, resetsAt: null }] },
    events: [], promptHistory: [], toolLog: [], responseLog: [],
    ...over,
  } as unknown as Session;
}

function setup(over: Partial<Session> = {}) {
  useSessionStore.setState({ sessions: new Map([['s1', makeSession(over)]]) });
  return render(<InfoScreen sessionId="s1" />);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  useWsStore.setState({ snapshotReceived: true, connected: true });
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
  useRoomStore.setState({ rooms: [{ id: 'r1', name: 'Mobile', sessionIds: ['s1'], collapsed: false, createdAt: 0, roomIndex: 0 } as unknown as Room] });
  useLabelStore.setState({ labels: { s1: 'IMPORTANT' } });
  usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/chat', '/sessions/s1/info'] } });
  vi.mocked(requestSessionKill).mockClear();
  vi.mocked(requestSessionRestart).mockClear();
  vi.mocked(requestSessionResume).mockClear();
  vi.mocked(copySession).mockClear();
  vi.mocked(muteSession).mockClear();
});

afterEach(() => vi.unstubAllGlobals());

const row = (name: string | RegExp) => screen.getByText(name).closest('li') as HTMLElement;

describe('InfoScreen', () => {
  it('says the session\'s state in plain words', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('AASC Q & A');
    expect(screen.getByText('Claude Code · Working · 1h 12m')).toBeTruthy();
    expect(row('Model').textContent).toContain('Opus 5.5 · high');
    expect(row('Context').textContent).toContain('38% used');
    expect(row('Plan usage').textContent).toContain('5-hour 42% · Weekly 61%');
    expect(row('Project').textContent).toContain('agent-manager');
    expect(row('Room').textContent).toContain('Mobile');
    // Labels are each device's own, never synced (labelStore): the phone shows none (Oct 20 2026).
    expect(screen.queryByRole('button', { name: /^Label/ })).toBeNull();
    expect(row('Remark').textContent).toContain('Polish pass');
    // Nobody has typed yet: no "Last typed from" row (Oct 2026: any device drives directly).
    expect(screen.queryByText('Last typed from')).toBeNull();
    expect(screen.queryByText(/baton|PTY/i)).toBeNull();
  });

  it('never offers Pin or Share', () => {
    setup();
    expect(screen.queryByText(/Pin/)).toBeNull();
    expect(screen.queryByText(/Share/)).toBeNull();
  });

  it('turns notifications off (mute) and on', async () => {
    const user = userEvent.setup();
    setup();
    const sw = screen.getByRole('switch', { name: /Notifications/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(useSessionStore.getState().sessions.get('s1')?.muted).toBe(true);
    expect(muteSession).toHaveBeenCalledWith('s1');
    expect(screen.getByRole('switch', { name: /Notifications/ })).toHaveAttribute('aria-checked', 'false');
  });

  // AASC-57: the session's own AI-popup switch (the desktop's ✨), saved on the Mac.
  it('turns the session’s AI popups off and on, saved on the Mac; unset reads as on', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    setup({ aiPopupEnabled: undefined });
    const sw = screen.getByRole('switch', { name: /AI popups/ });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/ai-popup', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ aiPopupEnabled: false }),
    }));
    expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(false);
    expect(screen.getByRole('switch', { name: /AI popups/ })).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('AI popups off for this session', 'info'));
    await user.click(screen.getByRole('switch', { name: /AI popups/ }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/s1/ai-popup', expect.objectContaining({ body: JSON.stringify({ aiPopupEnabled: true }) }));
    expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(true);
  });

  it('puts the AI-popup switch back and says so when the Mac refuses', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 }));
    setup({ aiPopupEnabled: true });
    await user.click(screen.getByRole('switch', { name: /AI popups/ }));
    await waitFor(() => expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(true));
    expect(screen.getByRole('switch', { name: /AI popups/ })).toHaveAttribute('aria-checked', 'true');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('AI popups weren’t changed'), 'error');
  });

  // Oct 2026, by request: no Ask / Take / Release. Info only says which device typed last.
  it('says which device typed last, with no control actions', () => {
    usePresenceStore.getState().applyPresence({
      devices: [
        { clientId: 'phone', label: 'iPhone', address: '', isLocal: false, connections: 1, connectedAt: 0, lastSeenAt: 0 },
        { clientId: 'mac', label: 'MacBook', address: '', isLocal: true, connections: 1, connectedAt: 0, lastSeenAt: 0 },
      ],
      controllers: [{ sessionId: 's1', clientId: 'mac', label: 'MacBook', since: NOW, lastActivityAt: NOW, online: true }],
      restoreOwner: null,
      workspaceWriter: 'mac',
    });
    setup();
    expect(row('Last typed from').textContent).toContain('MacBook');
    expect(screen.queryByRole('button', { name: /Take control|Ask for control|Release control/ })).toBeNull();
  });

  it('opens Notes, Queue and AI popups as screens', async () => {
    const user = userEvent.setup();
    setup();
    for (const [name, page] of [['Notes', 'notes'], ['Queue', 'queue'], ['AI popups', 'popups']] as const) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^${name}`) }));
      const stack = usePhoneNavStore.getState().stacks.sessions;
      expect(stack[stack.length - 1]).toBe(`/sessions/s1/info/${page}`);
    }
  });

  it('opens Files as the session’s Project tab, closing Info (AASC-56)', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /^Files/ }));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s1/project']);
  });

  it('opens Agents as the session’s Agents tab, closing Info (Oct 22 2026)', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /^Agents/ }));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s1/agents']);
  });

  it('opens the Project tab from the Project row too', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: /^Project agent-manager/ }));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s1/project']);
  });

  it('opens a shell’s Project tab over its Terminal tab', async () => {
    const user = userEvent.setup();
    usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/terminal', '/sessions/s1/info'] } });
    setup({ cliSource: undefined, model: undefined, runtime: undefined, planUsage: undefined } as Partial<Session>);
    await user.click(screen.getByRole('button', { name: /^Files/ }));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s1/project']);
  });

  it('opens the chat composer’s model sheet, the one model sheet (Oct 20 2026)', async () => {
    const user = userEvent.setup();
    usePhoneNavStore.setState({ tab: 'sessions', stacks: { ...defaultStacks(), sessions: ['/sessions', '/sessions/s1/chat', '/sessions/s1/info'] } });
    setup();
    await user.click(screen.getByRole('button', { name: /^Model/ }));
    expect(usePhoneNavStore.getState().stacks.sessions).toEqual(['/sessions', '/sessions/s1/chat']);
    expect(useComposerDraftStore.getState().sheetRequest).toMatchObject({ sessionId: 's1', sheet: 'model' });
    expect(screen.queryByRole('dialog', { name: 'Model and effort' })).toBeNull();
  });

  it('can’t change the model while the agent is still starting, and says why (the composer would drop it)', () => {
    setup({ status: 'connecting' });
    expect(screen.getByRole('button', { name: /^Model/ })).toHaveAttribute('aria-disabled', 'true');
    expect(row('Model').textContent).toContain('The agent is still starting.');
  });

  it('can’t change the model of a session that ended, and says why', () => {
    setup({ status: 'ended' });
    expect(screen.getByRole('button', { name: /^Model/ })).toHaveAttribute('aria-disabled', 'true');
    expect(row('Model').textContent).toContain('It has ended.');
  });

  it('kills and restarts only after a confirm', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Kill session' }));
    expect(requestSessionKill).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: 'Kill this session?' })).getByRole('button', { name: 'Kill session' }));
    await waitFor(() => expect(requestSessionKill).toHaveBeenCalledWith('s1', 'term-1'));

    await user.click(screen.getByRole('button', { name: /^Restart/ }));
    expect(requestSessionRestart).not.toHaveBeenCalled();
    const confirm = await screen.findByRole('dialog', { name: 'Restart this session?' });
    expect(confirm.textContent).toMatch(/current turn is stopped/);
    await user.click(within(confirm).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(requestSessionRestart).toHaveBeenCalledWith('s1'));
  });

  it('resumes an ended session without a confirm, and forks or clones', async () => {
    const user = userEvent.setup();
    setup({ status: 'ended' });
    expect(screen.queryByRole('button', { name: /^Restart/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Resume/ }));
    await waitFor(() => expect(requestSessionResume).toHaveBeenCalledWith('s1'));
    await user.click(screen.getByRole('button', { name: /^Fork/ }));
    await waitFor(() => expect(copySession).toHaveBeenCalledWith('s1', 'fork'));
    await user.click(screen.getByRole('button', { name: /^Clone/ }));
    await waitFor(() => expect(copySession).toHaveBeenCalledWith('s1', 'clone'));
  });

  it('says why a fork or a restart isn’t offered', () => {
    setup({ cliSource: 'shell', sshCommand: 'bash', isFork: true } as Partial<Session>);
    expect(screen.getByRole('button', { name: /^Restart/ })).toHaveAttribute('aria-disabled', 'true');
    expect(row(/^Restart/).textContent).toContain('A fork can’t be restarted.');
  });

  it('says the session is gone when it isn’t here', () => {
    useSessionStore.setState({ sessions: new Map() });
    render(<InfoScreen sessionId="nope" />);
    expect(screen.getByText('This session isn’t here')).toBeTruthy();
  });
});
