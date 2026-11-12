// DetailPanel.lite.test.tsx — what the session panel hands its tabs in the Lite build. The queue strip under the
// terminal is one line while the session's queue is empty, so the terminal keeps its height.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/components/terminal/TerminalContainer', () => ({ default: () => <div data-testid="terminal" /> }));
vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/robot3DGeometry', () => ({ PALETTE: ['#00f0ff'] }));
vi.mock('@/lib/robot3DModels', () => ({ getModelLabel: (t: string) => t }));
vi.mock('@/lib/robotStateMap', () => ({ sessionStatusToRobotState: (s: string) => s }));
vi.mock('./ConversationView', () => ({ default: () => null }));
vi.mock('./AiPopupHistory', () => ({ default: () => null }));
vi.mock('./NotesTab', () => ({ default: () => null }));
vi.mock('./QueueTab', () => ({
  default: ({ alwaysOpen }: { alwaysOpen?: boolean }) => <div data-testid={alwaysOpen ? 'queue-tab' : 'queue-strip'} />,
}));
vi.mock('./DetailTabs', () => ({
  default: ({ terminalContent, queueContent, commandsContent, hasTerminal }: Record<string, React.ReactNode>) => (
    <div>
      {terminalContent}
      {queueContent}
      {commandsContent ? <div data-testid="commands">{commandsContent}</div> : null}
      <div data-testid="has-terminal">{String(hasTerminal)}</div>
    </div>
  ),
}));

import DetailPanel from './DetailPanel';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const session = {
  sessionId: 'sess-1', status: 'idle', animationState: 'Idle', emote: null,
  projectName: 'agent-manager', projectPath: '/tmp/agent-manager', title: 'Work',
  source: 'ssh', model: 'opus', startedAt: 1, lastActivityAt: 1, endedAt: null,
  currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0, toolLog: [], responseLog: [],
  events: [], pendingTool: null, waitingDetail: null, subagentCount: 0, terminalId: 'term-1',
  cachedPid: null, archived: 0, queueCount: 0,
} as unknown as Session;

function queue(items: number): void {
  const queued = Array.from({ length: items }, (_, id) => ({ id }) as unknown as QueueItem);
  useQueueStore.setState({ queues: new Map(items ? [['sess-1', queued]] : []) });
}

describe('DetailPanel in the Lite build', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    useSessionStore.setState({ sessions: new Map([['sess-1', session]]), selectedSessionId: 'sess-1' });
  });
  afterEach(() => {
    queue(0);
    useUiStore.setState({ queueStripChoice: null });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    vi.unstubAllGlobals();
  });

  it('folds the queue strip to one line while nothing is queued, with no divider to drag', async () => {
    queue(0);
    render(<DetailPanel />);
    const strip = await screen.findByTestId('queue-strip');
    expect(strip.parentElement?.style.height).toBe('');
    expect(screen.queryByRole('separator', { name: /Resize queue/ })).not.toBeInTheDocument();
  });

  it('opens the queue strip while this session has queued prompts', async () => {
    queue(1);
    render(<DetailPanel />);
    const strip = await screen.findByTestId('queue-strip');
    expect(strip.parentElement?.style.height).not.toBe('');
    expect(screen.getByRole('separator', { name: /Resize queue/ })).toBeInTheDocument();
  });

  it('opens the strip when it is clicked open with nothing queued', async () => {
    queue(0);
    render(<DetailPanel />);
    const strip = await screen.findByTestId('queue-strip');
    act(() => useUiStore.setState({ queueStripChoice: { sessionId: 'sess-1', collapsed: false, hadQueued: false } }));
    expect(strip.parentElement?.style.height).not.toBe('');
  });

  it('keeps the QUEUE tab open, because folding it would leave a bare header', async () => {
    queue(0);
    render(<DetailPanel />);
    expect(await screen.findByTestId('queue-tab')).toBeInTheDocument();
  });

  it('tells the tabs whether this session has a terminal', async () => {
    render(<DetailPanel />);
    expect((await screen.findByTestId('has-terminal')).textContent).toBe('true');
  });

  it('tells the tabs when a session has no terminal', async () => {
    useSessionStore.setState({ sessions: new Map([['sess-1', { ...session, terminalId: null } as unknown as Session]]) });
    render(<DetailPanel />);
    expect((await screen.findByTestId('has-terminal')).textContent).toBe('false');
  });

  // Lite shows COMMANDS since Nov 10 2026. Most Lite sessions are quick-launched without the extra shell, so the
  // tab offers to open one; it never opens it by itself (each one is a PTY).
  it('offers to open the COMMANDS shell for a session started without one, and opens it only when asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<DetailPanel />);
    const commands = await screen.findByTestId('commands');
    const open = within(commands).getByRole('button', { name: 'CONNECT TERMINAL' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('reconnect-ops-terminal'))).toBe(false);

    fireEvent.click(open);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/sess-1/reconnect-ops-terminal', { method: 'POST' });
  });

  it('shows the COMMANDS shell a session already has', async () => {
    useSessionStore.setState({
      sessions: new Map([['sess-1', { ...session, opsTerminalId: 'ops-1', hadOpsTerminal: true } as unknown as Session]]),
    });
    render(<DetailPanel />);
    const commands = await screen.findByTestId('commands');
    expect(within(commands).getByTestId('terminal')).toBeInTheDocument();
  });
});
