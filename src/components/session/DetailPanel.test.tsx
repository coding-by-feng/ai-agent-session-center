import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import DetailPanel from './DetailPanel';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
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

vi.mock('./DetailTabs', () => ({
  default: ({
    terminalContent,
    promptsContent,
    notesContent,
  }: Record<string, React.ReactNode>) => (
    <div data-testid="detail-tabs">
      <div data-testid="terminal-tab">{terminalContent}</div>
      <div data-testid="prompts-tab">{promptsContent}</div>
      <div data-testid="notes-tab">{notesContent}</div>
    </div>
  ),
}));

vi.mock('./ConversationView', () => ({
  default: ({ prompts }: { prompts: unknown[] }) => (
    <div data-testid="conversation-view">Prompts: {prompts.length}</div>
  ),
}));

vi.mock('./AiPopupHistory', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="ai-popup-history">AI popups for {sessionId}</div>
  ),
}));

vi.mock('./NotesTab', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="notes-tab-inner">Notes for {sessionId}</div>
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
    const { container } = render(<DetailPanel />);
    // Scoped to the header: the selected session is also listed as a card in
    // the session strip, so its name appears twice on the panel.
    expect(container.querySelector('[class*="switcherProject"]')).toHaveTextContent('test-project');
  });

  it('displays session title', () => {
    const session = makeSession({ title: 'Build the feature' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    const { container } = render(<DetailPanel />);
    // Header, not the strip — see 'renders panel when session is selected'.
    expect(container.querySelector('[class*="switcherNameText"]')).toHaveTextContent('Build the feature');
  });

  it('displays status badge', () => {
    const session = makeSession({ status: 'approval' });
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    // The shared StatusBadge (AASC-11): the LIVE card's words, glyph in the status colour.
    const badge = screen.getByText('Approval needed').closest('[data-status]');
    expect(badge).toHaveAttribute('data-status', 'approval');
    expect(badge?.querySelector('svg')).not.toBeNull();
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

  // The header's 2D character-model badge (#55) was removed — the panel header is
  // now the SessionSwitcher bar, which shows the title, label and remark instead.
  // `characterModel` is still session state, but it is only rendered by the 3D
  // scene now, so coverage belongs with SessionRobot rather than here.

  // The header's close affordance became MINIMIZE. It sets detailPanelMinimized
  // and deliberately KEEPS the session selected so scroll position and tab state
  // survive — the same rationale as the Escape-key test below. It no longer
  // deselects, so asserting selectedSessionId === null tested removed behaviour.
  it('minimizes on the header minimize button, keeping the session selected', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize session panel' }));
    expect(useUiStore.getState().detailPanelMinimized).toBe(true);
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-1');
  });

  it('does not deselect on Escape key (preserves scroll position)', () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-1');
  });

  // NotesTab is lazy() — it resolves a tick after mount, so this must await
  // rather than assert synchronously.
  it('passes notes tab with session ID', async () => {
    const session = makeSession();
    useSessionStore.setState({
      sessions: new Map([['sess-1', session]]),
      selectedSessionId: 'sess-1',
    });
    render(<DetailPanel />);
    expect(await screen.findByText('Notes for sess-1')).toBeInTheDocument();
  });

  // The queue strip under the terminal sits in a row with its own dragged height.
  // Collapsing the queue has to give that height back to the terminal: before, the
  // row kept it and the header sat over ~220px of nothing.
  describe('terminal / queue split', () => {
    const DIVIDER = { name: 'Resize queue area' };
    const queueRow = () =>
      screen.getByTestId('terminal-tab').querySelector('[class*="bottomRow"]') as HTMLElement;
    const open = () => {
      useSessionStore.setState({ sessions: new Map([['sess-1', makeSession()]]), selectedSessionId: 'sess-1' });
      render(<DetailPanel />);
    };

    it('expanded: the divider is there and the row keeps its dragged height', () => {
      useUiStore.setState({ queuePanelCollapsed: false });
      open();
      expect(screen.getByRole('separator', DIVIDER)).toBeInTheDocument();
      expect(queueRow().style.height).toMatch(/^\d+px$/);
    });

    it('collapsed: no divider, and the row is only as tall as the queue header', () => {
      useUiStore.setState({ queuePanelCollapsed: true });
      open();
      expect(screen.queryByRole('separator', DIVIDER)).toBeNull();
      expect(queueRow().style.height).toBe('');
    });

    it('gives the height back the moment the queue collapses, and takes it again on expand', () => {
      useUiStore.setState({ queuePanelCollapsed: false });
      open();
      const dragged = queueRow().style.height;
      fireEvent.click(screen.getByRole('button', { name: 'Collapse the queue' }));
      expect(screen.queryByRole('separator', DIVIDER)).toBeNull();
      expect(queueRow().style.height).toBe('');
      fireEvent.click(screen.getByRole('button', { name: 'Expand the queue' }));
      expect(screen.getByRole('separator', DIVIDER)).toBeInTheDocument();
      expect(queueRow().style.height).toBe(dragged);
    });
  });
});

// AASC-18: on a phone the session strip gives way to the Sessions drawer and the
// swipe between sessions; the desktop panel is unchanged.
describe('DetailPanel on a phone', () => {
  const phone = (isPhone: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: isPhone && query.includes('max-width: 480px'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })));

  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map([
        ['sess-1', makeSession()],
        ['sess-2', makeSession({ sessionId: 'sess-2', title: 'Other task', status: 'idle' })],
      ]),
      selectedSessionId: 'sess-1',
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('desktop: the strip, and no Sessions drawer button', () => {
    phone(false);
    const { container } = render(<DetailPanel />);
    expect(container.querySelector('[class*="sessionTabStrip"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Sessions/ })).toBeNull();
  });

  it('phone: a Sessions drawer button and previous / next instead of the strip', () => {
    phone(true);
    const { container } = render(<DetailPanel />);
    expect(container.querySelector('[class*="sessionTabStrip"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Sessions/ }));
    expect(screen.getByTestId('session-drawer')).toBeInTheDocument();
  });
});
