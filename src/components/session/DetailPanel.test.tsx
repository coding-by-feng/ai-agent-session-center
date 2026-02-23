import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DetailPanel from './DetailPanel';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

// Mock sub-components to isolate DetailPanel tests
vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-panel">{children}</div>
  ),
}));

vi.mock('@/lib/robot3DGeometry', () => ({
  PALETTE: ['#00f0ff', '#ff00aa', '#a855f7', '#00ff88'],
}));

vi.mock('@/lib/robot3DModels', () => ({
  getModelLabel: (type: string) => type.charAt(0).toUpperCase() + type.slice(1),
}));

vi.mock('@/lib/robotStateMap', () => ({
  sessionStatusToRobotState: (status: string) => status === 'ended' ? 'offline' : status,
}));

vi.mock('@/lib/robot3DModels', () => ({
  getModelLabel: (type: string) => type.charAt(0).toUpperCase() + type.slice(1),
}));

vi.mock('./DetailTabs', () => ({
  default: ({
    terminalContent,
    promptsContent,
    activityContent,
    notesContent,
    summaryContent,
  }: Record<string, React.ReactNode>) => (
    <div data-testid="detail-tabs">
      <div data-testid="terminal-tab">{terminalContent}</div>
      <div data-testid="prompts-tab">{promptsContent}</div>
      <div data-testid="activity-tab">{activityContent}</div>
      <div data-testid="notes-tab">{notesContent}</div>
      <div data-testid="summary-tab">{summaryContent}</div>
    </div>
  ),
}));

vi.mock('./PromptHistory', () => ({
  default: ({ prompts }: { prompts: unknown[] }) => (
    <div data-testid="prompt-history">Prompts: {prompts.length}</div>
  ),
}));

vi.mock('./ActivityLog', () => ({
  default: () => <div data-testid="activity-log">Activity</div>,
}));

vi.mock('./NotesTab', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="notes-tab-inner">Notes for {sessionId}</div>
  ),
}));

vi.mock('./SummaryTab', () => ({
  default: ({ summary }: { summary?: string }) => (
    <div data-testid="summary-tab-inner">{summary || 'No summary'}</div>
  ),
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    status: 'working',
    animationState: 'Running',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test-project',
    title: 'My Task Title',
    source: 'ssh',
    model: 'claude-sonnet',
    startedAt: Date.now() - 120_000,
    lastActivityAt: Date.now(),
    endedAt: null,
    currentPrompt: '',
    promptHistory: [
      { text: 'First prompt', timestamp: Date.now() - 60000 },
      { text: 'Second prompt', timestamp: Date.now() },
    ],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

describe('DetailPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map(),
      selectedSessionId: null,
    });
  });

  it('renders nothing when no session is selected', () => {
    const { container } = render(<DetailPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when selected session does not exist', () => {
    useSessionStore.setState({ selectedSessionId: 'nonexistent' });
    const { container } = render(<DetailPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('renders panel when session is selected', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('test-project')).toBeInTheDocument();
  });

  it('displays session title', () => {
    const session = makeSession({ title: 'Build the feature' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('Build the feature')).toBeInTheDocument();
  });

  it('displays status badge', () => {
    const session = makeSession({ status: 'approval' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('APPROVAL NEEDED')).toBeInTheDocument();
  });

  it('displays model name', () => {
    const session = makeSession({ model: 'claude-opus' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('claude-opus')).toBeInTheDocument();
  });

  it('renders detail tabs', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByTestId('detail-tabs')).toBeInTheDocument();
  });

  it('passes prompt history to prompts tab', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('Prompts: 2')).toBeInTheDocument();
  });

  it('renders 3D robot model in header', () => {
    const session = makeSession({ characterModel: 'Robot' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    // #55: 2D badge preview replaces Canvas to prevent WebGL context exhaustion
    expect(screen.getByText('Robot')).toBeInTheDocument();
  });

  it('deselects on close button click', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    fireEvent.click(screen.getByTitle('Close'));
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('deselects on Escape key', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('passes notes tab with session ID', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(screen.getByText('Notes for sess-1')).toBeInTheDocument();
  });
});
