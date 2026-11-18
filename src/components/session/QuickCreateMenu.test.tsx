// QuickCreateMenu.test.tsx — the ＋ New menu: one click starts a NEW session in a project, typing filters,
// Enter starts the agent used last there, and a room can be made without the LIVE page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from '@/types';

const KNOWN = ['/Users/me/Documents/sms-ops', '/Users/me/site'];
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
const launchInProjectGroup = vi.fn(async () => ({ ok: true as const, terminalId: 'term-new', deduplicated: false }));
vi.mock('@/lib/projectLaunch', () => ({ launchInProjectGroup: (...args: unknown[]) => launchInProjectGroup(...(args as [])) }));

import QuickCreateMenu from './QuickCreateMenu';
import { useQuickCreateStore } from '@/stores/quickCreateStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

const session = (id: string, projectPath: string, extra: Partial<Session> = {}): Session => ({
  sessionId: id, status: 'idle', animationState: 'Idle', emote: null, projectName: 'p', projectPath, title: id,
  source: 'ssh', model: '', startedAt: 1, lastActivityAt: 1, endedAt: null, currentPrompt: '', promptHistory: [],
  toolUsage: {}, totalToolCalls: 0, toolLog: [], responseLog: [], events: [], pendingTool: null, waitingDetail: null,
  subagentCount: 0, terminalId: `term-${id}`, cachedPid: null, archived: 0, queueCount: 0, ...extra,
} as Session);

function openMenu() {
  useQuickCreateStore.setState({ open: true });
  return render(<QuickCreateMenu />);
}
/** Open it again after something closed it (the store change re-renders the mounted host). */
const reopen = () => act(() => useQuickCreateStore.setState({ open: true }));
const rowNames = () => Array.from(document.querySelectorAll('[class*="name"]')).map((n) => n.textContent);

describe('QuickCreateMenu', () => {
  beforeEach(() => {
    localStorage.clear();
    launchInProjectGroup.mockClear();
    const current = session('cur', '/Users/me/Documents/claude/agent-manager');
    const sibling = session('sib', '/Users/me/Documents/sms-ops');
    const ended = session('old', '/Users/me/Documents/sms-ops', { status: 'ended' });
    useSessionStore.setState({ sessions: new Map([current, sibling, ended].map((s) => [s.sessionId, s])), selectedSessionId: 'cur' });
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ activeModal: null });
  });
  afterEach(() => {
    act(() => useQuickCreateStore.setState({ open: false }));
    document.querySelectorAll('[data-quick-create-anchor]').forEach((n) => n.remove());
  });

  it('draws nothing while closed', () => {
    render(<QuickCreateMenu />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the open session’s project first, then recent projects, with the search focused', () => {
    openMenu();
    expect(screen.getByText('This project')).toBeInTheDocument();
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(rowNames()).toEqual(['agent-manager', 'sms-ops', 'site']);
    expect(screen.getByRole('searchbox', { name: 'Search projects' })).toHaveFocus();
  });

  it('one click starts a new session there, with that project’s live sessions for the room rule', () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'New Codex session in sms-ops' }));
    expect(launchInProjectGroup).toHaveBeenCalledTimes(1);
    const [group, command] = launchInProjectGroup.mock.calls[0] as unknown as [{ launchPath: string; sessions: Session[] }, string];
    expect(command).toBe('codex');
    expect(group.launchPath).toBe('/Users/me/Documents/sms-ops');
    expect(group.sessions.map((s) => s.sessionId)).toEqual(['sib']); // not the ended one
    expect(useQuickCreateStore.getState().open).toBe(false);
  });

  it('typing filters; Enter starts the agent used last in that folder, Alt+Enter the other', () => {
    localStorage.setItem('dir-session-configs', JSON.stringify({ '/Users/me/site': { command: 'codex' } }));
    openMenu();
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.change(search, { target: { value: 'site' } });
    expect(rowNames()).toEqual(['site']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect((launchInProjectGroup.mock.calls[0] as unknown as [unknown, string])[1]).toBe('codex');

    reopen();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search projects' }), { target: { value: 'site' } });
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search projects' }), { key: 'Enter', altKey: true });
    expect((launchInProjectGroup.mock.calls[1] as unknown as [unknown, string])[1]).toBe('claude');
  });

  it('arrow keys move the highlighted row', () => {
    openMenu();
    const search = screen.getByRole('searchbox', { name: 'Search projects' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.querySelector('[data-active]')?.textContent).toContain('sms-ops');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(document.querySelector('[data-active]')?.textContent).toContain('site');
  });

  it('makes a room without leaving the page', () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'New room…' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Room name' }), { target: { value: '  Billing  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(useRoomStore.getState().rooms.map((r) => r.name)).toEqual(['Billing']);
    expect(useQuickCreateStore.getState().open).toBe(false);
  });

  it('More options opens the full form with the highlighted folder; Manage rooms opens the Rooms dialog', () => {
    openMenu();
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search projects' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: 'More options…' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
    expect(useUiStore.getState().newSessionDir).toBe('/Users/me/Documents/sms-ops');

    act(() => useUiStore.setState({ activeModal: null }));
    reopen();
    fireEvent.click(screen.getByRole('button', { name: 'Manage rooms…' }));
    expect(useUiStore.getState().activeModal).toBe('manage-rooms');
  });

  it('Escape and a press outside close it; a press on a ＋ New button is left to the button', () => {
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useQuickCreateStore.getState().open).toBe(false);

    reopen();
    const anchor = document.createElement('button');
    anchor.setAttribute('data-quick-create-anchor', '');
    document.body.appendChild(anchor);
    fireEvent.mouseDown(anchor);
    expect(useQuickCreateStore.getState().open).toBe(true);
    fireEvent.mouseDown(document.body);
    expect(useQuickCreateStore.getState().open).toBe(false);
  });

  it('offers no "This project" for a session on another machine', () => {
    const remote = session('cur', '/srv/app', { sshConfig: { host: 'build.example.com', port: 22, username: 'u' } } as Partial<Session>);
    useSessionStore.setState({ sessions: new Map([[remote.sessionId, remote]]), selectedSessionId: 'cur' });
    openMenu();
    expect(screen.queryByText('This project')).toBeNull();
    expect(rowNames()).toEqual(['sms-ops', 'site']);
  });
});
