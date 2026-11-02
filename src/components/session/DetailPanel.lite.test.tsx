// DetailPanel.lite.test.tsx — what the session panel hands its tabs in the Lite build. The queue strip under the
// terminal shows only while this session has queued prompts, which keep sending and must stay in sight.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
vi.mock('./QueueTab', () => ({ default: () => <div data-testid="queue-strip" /> }));
vi.mock('./DetailTabs', () => ({
  default: ({ terminalContent, commandsContent, hasTerminal }: Record<string, React.ReactNode>) => (
    <div>
      {terminalContent}
      {commandsContent ? <div data-testid="commands" /> : null}
      <div data-testid="has-terminal">{String(hasTerminal)}</div>
    </div>
  ),
}));

import DetailPanel from './DetailPanel';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
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
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    vi.unstubAllGlobals();
  });

  it('has no queue strip while nothing is queued', async () => {
    queue(0);
    render(<DetailPanel />);
    expect(await screen.findByTestId('terminal')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-strip')).not.toBeInTheDocument();
  });

  it('shows the queue strip while this session has queued prompts', async () => {
    queue(1);
    render(<DetailPanel />);
    expect(await screen.findByTestId('queue-strip')).toBeInTheDocument();
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

  it('never starts the COMMANDS shell', async () => {
    render(<DetailPanel />);
    await screen.findByTestId('terminal');
    expect(screen.queryByTestId('commands')).not.toBeInTheDocument();
  });
});
