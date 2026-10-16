// SessionScreen.segments.test.tsx — the session's tabs after AASC-56: a Claude /
// Codex session shows Chat · Changes · Project and its terminal is a screen
// pushed over Chat (no tabs on it, Back returns to Chat); a plain shell shows
// Terminal · Project. The segments' own content has its own tests: here they are
// stand-ins that say what they were given and offer their "Open terminal".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('../chat/ChatView', () => ({
  default: ({ onTerminal }: { onTerminal: () => void }) => <button type="button" onClick={onTerminal}>chat: open terminal</button>,
}));
vi.mock('../chat/ChatFooter', () => ({ default: () => <div data-testid="chat-footer" /> }));
vi.mock('../chat/ChangesView', () => ({
  default: ({ onTerminal }: { onTerminal: () => void }) => <button type="button" onClick={onTerminal}>changes: open terminal</button>,
  ChangesBadge: () => null,
}));
vi.mock('./SessionTerminal', () => ({ default: ({ session }: { session: Session }) => <div data-testid="terminal">{session.sessionId}</div> }));
vi.mock('../PhoneProjectBrowser', () => ({
  default: ({ projectPath, sessionId }: { projectPath: string; sessionId: string }) => <div data-testid="project">{sessionId}:{projectPath}</div>,
}));

import SessionScreen from './SessionScreen';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import type { SessionSegment } from '@/lib/chat/phoneRoutes';

const base = {
  title: 'web', projectName: 'web', projectPath: '/w/web', status: 'idle', source: 'ssh', terminalId: 'term-1',
  startedAt: 0, lastActivityAt: 0, events: [], promptHistory: [], toolLog: [], responseLog: [],
};
const claude = { ...base, sessionId: 's1', cliSource: 'claude' } as unknown as Session;
const shell = { ...base, sessionId: 'sh', title: 'zsh', startupCommand: 'zsh' } as unknown as Session;

const stack = () => usePhoneNavStore.getState().stacks.sessions;

function show(session: Session, segment: SessionSegment, below: string[] = []) {
  usePhoneNavStore.setState({
    tab: 'sessions',
    stacks: { ...defaultStacks(), sessions: ['/sessions', ...below, `/sessions/${session.sessionId}/${segment}`] },
  });
  return render(<SessionScreen sessionId={session.sessionId} segment={segment} />);
}

const tabNames = () => within(screen.getByRole('tablist', { name: 'Session view' })).getAllByRole('tab').map((t) => t.textContent);

beforeEach(() => {
  useWsStore.setState({ snapshotReceived: true, connected: true });
  useSessionStore.setState({ sessions: new Map([['s1', claude], ['sh', shell]]), selectedSessionId: null });
});

describe('a Claude / Codex session', () => {
  it('shows Chat · Changes · Project, and no Terminal tab', () => {
    show(claude, 'chat');
    expect(tabNames()).toEqual(['Chat', 'Changes', 'Project']);
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the project read-only in the Project tab', async () => {
    show(claude, 'project');
    expect(screen.getByRole('tab', { name: 'Project' })).toHaveAttribute('aria-selected', 'true');
    expect((await screen.findByTestId('project')).textContent).toBe('s1:/w/web');
  });

  it('says so when the session has no project folder', () => {
    useSessionStore.setState({ sessions: new Map([['s1', { ...claude, projectPath: '' } as Session]]) });
    show(claude, 'project');
    expect(screen.getByText('No project folder')).toBeInTheDocument();
  });

  it('switches tabs in place', async () => {
    const user = userEvent.setup();
    show(claude, 'chat');
    await user.click(screen.getByRole('tab', { name: 'Project' }));
    expect(stack()).toEqual(['/sessions', '/sessions/s1/project']);
  });

  it('opens the terminal over Chat from Chat’s "Open terminal"', async () => {
    const user = userEvent.setup();
    show(claude, 'chat');
    await user.click(screen.getByRole('button', { name: 'chat: open terminal' }));
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
  });

  it('opens it from Changes with Chat under it', async () => {
    const user = userEvent.setup();
    show(claude, 'changes');
    await user.click(screen.getByRole('button', { name: 'changes: open terminal' }));
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
  });

  it('offers Terminal in the ⋯ menu', async () => {
    const user = userEvent.setup();
    show(claude, 'project');
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    await user.click(await screen.findByRole('button', { name: /^Terminal/ }));
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat', '/sessions/s1/terminal']);
  });
});

describe('its terminal screen', () => {
  it('opens full screen with no tabs, and Back returns to Chat', async () => {
    const user = userEvent.setup();
    show(claude, 'terminal', ['/sessions/s1/chat']);
    expect(screen.getByTestId('terminal').textContent).toBe('s1');
    expect(screen.queryByRole('tablist', { name: 'Session view' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to Chat' }));
    expect(stack()).toEqual(['/sessions', '/sessions/s1/chat']);
  });

  it('has no Terminal row in its ⋯ menu', async () => {
    const user = userEvent.setup();
    show(claude, 'terminal', ['/sessions/s1/chat']);
    await user.click(screen.getByRole('button', { name: 'Session actions' }));
    await screen.findByTestId('session-menu-sheet');
    expect(screen.queryByRole('button', { name: /^Terminal/ })).toBeNull();
  });
});

describe('a plain shell session (no chat)', () => {
  it('shows Terminal · Project', () => {
    show(shell, 'terminal');
    expect(tabNames()).toEqual(['Terminal', 'Project']);
    expect(screen.getByTestId('terminal').textContent).toBe('sh');
  });

  it('shows its Terminal for a chat path (a selection, an old link)', () => {
    show(shell, 'chat');
    expect(screen.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-footer')).toBeNull();
  });

  it('goes back to the list past a chat path left under its terminal', async () => {
    const user = userEvent.setup();
    show(shell, 'terminal', ['/sessions/sh/chat']);
    await user.click(screen.getByRole('button', { name: 'Back to the list' }));
    expect(stack()).toEqual(['/sessions']);
  });

  it('switches to Project and back to Terminal in place', async () => {
    const user = userEvent.setup();
    show(shell, 'terminal');
    await user.click(screen.getByRole('tab', { name: 'Project' }));
    expect(stack()).toEqual(['/sessions', '/sessions/sh/project']);
  });
});
