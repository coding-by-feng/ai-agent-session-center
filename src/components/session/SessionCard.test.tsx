import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import SessionCard from './SessionCard';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

// Mock fetch globally
const fetchMock = vi.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response),
);
vi.stubGlobal('fetch', fetchMock);

// Mock the db module
vi.mock('@/lib/db', () => ({
  deleteSession: vi.fn(() => Promise.resolve()),
}));

// Mock ToastContainer
vi.mock('@/components/ui/ToastContainer', () => ({
  showToast: vi.fn(),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'test-1',
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'my-project',
    projectPath: '/tmp/my-project',
    title: '',
    source: 'ssh',
    model: 'claude-sonnet',
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
    endedAt: null,
    currentPrompt: 'Write some tests',
    promptHistory: [{ text: 'Write some tests', timestamp: Date.now() }],
    toolUsage: { Read: 5, Write: 2 },
    totalToolCalls: 7,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: 'term-1',
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

describe('SessionCard', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    useSessionStore.setState({
      sessions: new Map(),
      selectedSessionId: null,
    });
  });

  it('renders project name and status', () => {
    render(<SessionCard session={makeSession()} />);
    expect(screen.getByText('my-project')).toBeInTheDocument();
    expect(screen.getByText('IDLE')).toBeInTheDocument();
  });

  it('renders prompt preview', () => {
    render(<SessionCard session={makeSession({ currentPrompt: 'Fix the bug' })} />);
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
  });

  it('truncates long prompts', () => {
    const longPrompt = 'a'.repeat(200);
    render(<SessionCard session={makeSession({ currentPrompt: longPrompt })} />);
    const display = screen.getByText(/^a+\.\.\.$/);
    expect(display).toBeInTheDocument();
  });

  it('shows tool count', () => {
    render(<SessionCard session={makeSession({ totalToolCalls: 42 })} />);
    expect(screen.getByText('Tools: 42')).toBeInTheDocument();
  });

  it('shows subagent count when > 0', () => {
    render(<SessionCard session={makeSession({ subagentCount: 3 })} />);
    expect(screen.getByText('Agents: 3')).toBeInTheDocument();
  });

  it('hides subagent count when 0', () => {
    render(<SessionCard session={makeSession({ subagentCount: 0 })} />);
    expect(screen.queryByText(/Agents:/)).not.toBeInTheDocument();
  });

  it('shows queue count when > 0', () => {
    render(<SessionCard session={makeSession({ queueCount: 5 })} />);
    expect(screen.getByText('Queue: 5')).toBeInTheDocument();
  });

  it('renders DISCONNECTED status for ended sessions', () => {
    render(<SessionCard session={makeSession({ status: 'ended' })} />);
    expect(screen.getByText('DISCONNECTED')).toBeInTheDocument();
  });

  it('shows resume button for ended sessions', () => {
    render(<SessionCard session={makeSession({ status: 'ended' })} />);
    const resumeBtn = screen.getByTitle('Resume Claude');
    expect(resumeBtn).toBeInTheDocument();
  });

  it('does not show resume button for active sessions', () => {
    render(<SessionCard session={makeSession({ status: 'working' })} />);
    expect(screen.queryByTitle('Resume Claude')).not.toBeInTheDocument();
  });

  it('shows source badge for non-ssh sources', () => {
    render(<SessionCard session={makeSession({ source: 'vscode' })} />);
    expect(screen.getByText('VS Code')).toBeInTheDocument();
  });

  it('hides source badge for ssh sessions', () => {
    render(<SessionCard session={makeSession({ source: 'ssh' })} />);
    expect(screen.queryByText('SSH')).not.toBeInTheDocument();
  });

  it('shows label badge when set', () => {
    render(<SessionCard session={makeSession({ label: 'HEAVY' })} />);
    expect(screen.getByText('HEAVY')).toBeInTheDocument();
  });

  it('selects session on click (non-display-only)', () => {
    const session = makeSession({ source: 'ssh' });
    render(<SessionCard session={session} />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    fireEvent.click(card);
    expect(useSessionStore.getState().selectedSessionId).toBe('test-1');
  });

  it('deselects session on click when already selected', () => {
    const session = makeSession({ source: 'ssh' });
    useSessionStore.setState({ selectedSessionId: 'test-1' });
    render(<SessionCard session={session} selected />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    fireEvent.click(card);
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('does not select display-only sessions on click', () => {
    const session = makeSession({ source: 'vscode' });
    render(<SessionCard session={session} />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    fireEvent.click(card);
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('close button removes session and calls API', async () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['test-1', session]]),
    });
    render(<SessionCard session={session} />);
    const closeBtn = screen.getByTitle('Dismiss card');
    fireEvent.click(closeBtn);
    // Should have called DELETE on both terminal and session
    expect(fetchMock).toHaveBeenCalled();
    expect(useSessionStore.getState().sessions.has('test-1')).toBe(false);
  });

  it('shows APPROVAL NEEDED for approval status', () => {
    render(<SessionCard session={makeSession({ status: 'approval' })} />);
    expect(screen.getByText('APPROVAL NEEDED')).toBeInTheDocument();
  });

  it('shows WAITING FOR INPUT for input status', () => {
    render(<SessionCard session={makeSession({ status: 'input' })} />);
    expect(screen.getByText('WAITING FOR INPUT')).toBeInTheDocument();
  });

  it('renders tool usage bars', () => {
    render(<SessionCard session={makeSession({ toolUsage: { Read: 10, Write: 5, Bash: 3 } })} />);
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('sets data-status attribute', () => {
    render(<SessionCard session={makeSession({ status: 'working' })} />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    expect(card).toHaveAttribute('data-status', 'working');
  });

  it('is draggable for SSH sessions', () => {
    render(<SessionCard session={makeSession({ source: 'ssh' })} />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('is not draggable for display-only sessions', () => {
    render(<SessionCard session={makeSession({ source: 'vscode' })} />);
    const card = screen.getByText('my-project').closest('[data-session-id]')!;
    expect(card).toHaveAttribute('draggable', 'false');
  });
});
