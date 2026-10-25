// DetailPanel.activity.test.tsx — the ACTIVITY tab of a central session (server/mcp) as the panel hands it to the
// tab strip: only a session that is a central gets `activityContent`, and only in a window that may drive centrals
// (this Mac, central sessions on). DetailTabs shows the tab when it is given the content (DetailTabs.test.tsx).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import DetailPanel from './DetailPanel';
import { useMcpStore } from '@/stores/mcpStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

// The real terminal needs a PTY and xterm.
vi.mock('@/components/terminal/TerminalContainer', () => ({ default: () => null }));
vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/robot3DGeometry', () => ({ PALETTE: ['#00f0ff'] }));
vi.mock('@/lib/robot3DModels', () => ({ getModelLabel: (t: string) => t }));
vi.mock('@/lib/robotStateMap', () => ({ sessionStatusToRobotState: (s: string) => s }));
vi.mock('./ConversationView', () => ({ default: () => null }));
vi.mock('./AiPopupHistory', () => ({ default: () => null }));
vi.mock('./NotesTab', () => ({ default: () => null }));
// The panel's own tab strip: it shows what the panel hands it, so the test sees exactly that.
vi.mock('./DetailTabs', () => ({
  default: ({ activityContent }: Record<string, React.ReactNode>) => (
    <div data-testid="tabs">{activityContent ? <div data-testid="activity-content">{activityContent}</div> : null}</div>
  ),
}));
// The log itself has its own tests: here it only has to be the thing handed over, for the right central.
vi.mock('./CentralActivity', () => ({
  default: ({ centralId }: { centralId: string }) => <div data-testid="central-activity">log of {centralId}</div>,
}));

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1', status: 'idle', animationState: 'Idle', emote: null,
    projectName: 'agent-manager', projectPath: '/tmp/agent-manager', title: 'Coordinator',
    source: 'ssh', model: 'opus', startedAt: Date.now(), lastActivityAt: Date.now(), endedAt: null,
    currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0, toolLog: [], responseLog: [],
    events: [], pendingTool: null, waitingDetail: null, subagentCount: 0, terminalId: 'term-1',
    cachedPid: null, archived: 0, queueCount: 0,
    ...overrides,
  };
}

const CENTRAL = { centralId: 'central-9', kind: 'global', scopeRef: null } as const;

function open(s: Session): void {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]), selectedSessionId: s.sessionId });
}

beforeEach(() => {
  useMcpStore.setState({ available: true });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
});

afterEach(() => {
  useMcpStore.setState({ available: null });
  useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  vi.unstubAllGlobals();
});

describe('DetailPanel — the ACTIVITY tab', () => {
  it('hands a central session’s log to the tab strip, for that central', async () => {
    open(session({ central: { ...CENTRAL } }));

    render(<DetailPanel />);

    expect(await screen.findByTestId('central-activity')).toHaveTextContent('log of central-9');
  });

  it('hands nothing for a session that is not a central', () => {
    open(session());

    render(<DetailPanel />);

    expect(screen.queryByTestId('activity-content')).toBeNull();
  });

  it('hands nothing until this window knows it may drive centrals', () => {
    useMcpStore.setState({ available: null });
    open(session({ central: { ...CENTRAL } }));

    render(<DetailPanel />);

    expect(screen.queryByTestId('activity-content')).toBeNull();
  });

  it('hands nothing to another device, or with central sessions off (the server answered 404)', () => {
    useMcpStore.setState({ available: false });
    open(session({ central: { ...CENTRAL } }));

    render(<DetailPanel />);

    expect(screen.queryByTestId('activity-content')).toBeNull();
  });
});
