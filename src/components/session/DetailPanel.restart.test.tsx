// DetailPanel.restart.test.tsx — what the terminal toolbar's Restart button does from the panel:
// when it is offered, when it asks first, what it sends and what the user sees when it fails.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

import DetailPanel from './DetailPanel';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/ui/ToastContainer', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/ToastContainer')>('@/components/ui/ToastContainer');
  return { ...actual, showToast: toast.showToast };
});

// The real terminal needs a PTY and xterm; the panel only hands it callbacks.
vi.mock('@/components/terminal/TerminalContainer', () => ({
  default: ({ onRestart, restartPending }: { onRestart?: () => void; restartPending?: boolean }) => (
    <div data-testid="terminal">
      {onRestart && <button aria-label="Restart session" disabled={restartPending} onClick={onRestart}>restart</button>}
    </div>
  ),
}));

vi.mock('@/components/ui/ResizablePanel', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/robot3DGeometry', () => ({ PALETTE: ['#00f0ff'] }));
vi.mock('@/lib/robot3DModels', () => ({ getModelLabel: (t: string) => t }));
vi.mock('@/lib/robotStateMap', () => ({ sessionStatusToRobotState: (s: string) => s }));
vi.mock('./DetailTabs', () => ({
  default: ({ terminalContent }: Record<string, React.ReactNode>) => <div>{terminalContent}</div>,
}));
vi.mock('./ConversationView', () => ({ default: () => null }));
vi.mock('./AiPopupHistory', () => ({ default: () => null }));
vi.mock('./NotesTab', () => ({ default: () => null }));

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1', status: 'idle', animationState: 'Idle', emote: null,
    projectName: 'agent-manager', projectPath: '/tmp/agent-manager', title: 'Release notes',
    source: 'ssh', model: 'opus', startedAt: Date.now(), lastActivityAt: Date.now(), endedAt: null,
    currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0, toolLog: [], responseLog: [],
    events: [], pendingTool: null, waitingDetail: null, subagentCount: 0, terminalId: 'term-1',
    cachedPid: null, archived: 0, queueCount: 0,
    ...overrides,
  };
}

function open(s: Session): void {
  useSessionStore.setState({ sessions: new Map([[s.sessionId, s]]), selectedSessionId: s.sessionId });
}

const restartButton = () => screen.queryByRole('button', { name: 'Restart session' });
// The panel makes other requests of its own; only the restart ones matter here.
const restartCalls = (mock: unknown = fetch) => (mock as ReturnType<typeof vi.fn>).mock.calls
  .filter((c) => String(c[0]).includes('restart-terminal'));

beforeEach(() => {
  toast.showToast.mockReset();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, terminalId: 'term-2' }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DetailPanel — Restart session', () => {
  it('is offered for a dashboard terminal, and not without one', () => {
    open(session());
    const { unmount } = render(<DetailPanel />);
    expect(restartButton()).not.toBeNull();
    unmount();

    open(session({ terminalId: null }));
    render(<DetailPanel />);
    expect(restartButton()).toBeNull();
  });

  it('is not offered for a fork card: its agent reports under the origin session', () => {
    open(session({ isFork: true, originSessionId: 'origin' }));
    render(<DetailPanel />);
    expect(restartButton()).toBeNull();
  });

  it('is not offered for a session the dashboard did not launch', () => {
    open(session({ source: 'hook' }));
    render(<DetailPanel />);
    expect(restartButton()).toBeNull();
  });

  it('restarts an idle session straight away, without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    open(session({ status: 'idle' }));
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);

    await waitFor(() => expect(restartCalls()).toEqual([[
      '/api/sessions/sess-1/restart-terminal',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) },
    ]]));
    expect(confirm).not.toHaveBeenCalled();
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('asks first when the session is mid-turn, and does nothing if the user says no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    open(session({ status: 'working' }));
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toContain('Release notes');
    await act(async () => { await Promise.resolve(); });
    expect(restartCalls()).toHaveLength(0);
  });

  it('restarts a mid-turn session once the user agrees', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    open(session({ status: 'approval' }));
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);

    await waitFor(() => expect(restartCalls()).toHaveLength(1));
  });

  it('says why when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ ok: false, error: 'Restart is not available for tmux sessions' }),
    }));
    open(session());
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);

    // names the card: the toast can land after the user has switched to another one
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Release notes: Restart is not available for tmux sessions', 'error'));
  });

  it('cannot be fired twice while the first request is still running, and works again after', async () => {
    let finish: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(new Promise((r) => { finish = r; }));
    vi.stubGlobal('fetch', fetchMock);
    open(session());
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);
    fireEvent.click(restartButton()!);
    expect(restartCalls(fetchMock)).toHaveLength(1);
    await waitFor(() => expect(restartButton()).toBeDisabled());

    await act(async () => { finish({ ok: true, json: async () => ({ ok: true, terminalId: 'term-2' }) }); });
    await waitFor(() => expect(restartButton()).not.toBeDisabled());
  });

  it('shows as busy only on the card being restarted, not on the one the user switched to', async () => {
    let finish: (v: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((r) => { finish = r; })));
    const a = session({ sessionId: 'sess-a', title: 'Card A', terminalId: 'term-a' });
    const b = session({ sessionId: 'sess-b', title: 'Card B', terminalId: 'term-b' });
    useSessionStore.setState({ sessions: new Map([['sess-a', a], ['sess-b', b]]), selectedSessionId: 'sess-a' });
    render(<DetailPanel />);

    fireEvent.click(restartButton()!);
    await waitFor(() => expect(restartButton()).toBeDisabled());

    act(() => { useSessionStore.setState({ selectedSessionId: 'sess-b' }); });
    await waitFor(() => expect(restartButton()).toBeEnabled()); // card B's own button is not busy

    act(() => { useSessionStore.setState({ selectedSessionId: 'sess-a' }); });
    await waitFor(() => expect(restartButton()).toBeDisabled()); // card A still is

    await act(async () => { finish({ ok: true, json: async () => ({ ok: true, terminalId: 'term-a2' }) }); });
    await waitFor(() => expect(restartButton()).toBeEnabled());
  });
});
