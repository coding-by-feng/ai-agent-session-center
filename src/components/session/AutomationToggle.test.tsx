/**
 * AutomationToggle — the per-session Automation mark (lite hooks). Rendered against the real session store through
 * a harness that subscribes the way SessionSwitcher does, so a click is seen in the DOM the way a person sees it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AutomationToggle from './AutomationToggle';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const toasts = vi.hoisted(() => ({
  calls: [] as Array<{ message: string; type?: string; action?: { label: string; onClick: () => void } }>,
}));
vi.mock('@/components/ui/ToastContainer', () => ({
  showToast: (message: string, type?: string, _duration?: number, action?: { label: string; onClick: () => void }) => {
    toasts.calls.push({ message, type, action });
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test',
    title: 'Session s1',
    source: 'terminal',
    model: 'claude-sonnet-4-5-20250514',
    startedAt: 1,
    lastActivityAt: 1,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
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

function Harness({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  if (!session) return null;
  return <AutomationToggle session={session} />;
}

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const toggle = () => screen.getByRole('button', { name: 'Automation' });

describe('AutomationToggle', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toasts.calls = [];
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    fetchMock = vi.fn().mockResolvedValue(reply(200, { success: true, hookLevel: 'lite', appliesOnRestart: true }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is off for a fresh session and on for a marked one', () => {
    useSessionStore.getState().addSession(makeSession());
    const { unmount } = render(<Harness sessionId="s1" />);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    unmount();
    useSessionStore.setState({ sessions: new Map() });
    useSessionStore.getState().addSession(makeSession({ hookLevel: 'lite' }));
    render(<Harness sessionId="s1" />);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks the session, asks the server, and offers Restart now while an agent runs', async () => {
    useSessionStore.getState().addSession(makeSession({ terminalId: 'term-1' }));
    render(<Harness sessionId="s1" />);
    fireEvent.click(toggle());
    expect(useSessionStore.getState().sessions.get('s1')?.hookLevel).toBe('lite');
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/hook-level', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ hookLevel: 'lite' }),
    }));

    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    const [toast] = toasts.calls;
    expect(toast.message).toBe('Automation on: lite hooks from the next launch');
    expect(toast.action?.label).toBe('Restart now');

    // An idle session restarts without a question.
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, terminalId: 'term-2' }));
    toast.action?.onClick();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/restart-terminal', expect.objectContaining({ method: 'POST' })));
  });

  it('asks before Restart now stops a running turn, and does nothing when the person says no', async () => {
    useSessionStore.getState().addSession(makeSession({ terminalId: 'term-1', status: 'working' }));
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(<Harness sessionId="s1" />);
    fireEvent.click(toggle());
    await waitFor(() => expect(toasts.calls).toHaveLength(1));
    toasts.calls[0].action?.onClick();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/sessions/s1/restart-terminal', expect.anything());
  });

  it('clears the mark on a second click, with no restart offer when no agent is running', async () => {
    useSessionStore.getState().addSession(makeSession({ hookLevel: 'lite' }));
    fetchMock.mockResolvedValue(reply(200, { success: true, hookLevel: null, appliesOnRestart: false }));
    render(<Harness sessionId="s1" />);
    fireEvent.click(toggle());
    expect(useSessionStore.getState().sessions.get('s1')).not.toHaveProperty('hookLevel');
    await waitFor(() => expect(toasts.calls[0]?.message).toBe('Automation off: full hooks'));
    expect(toasts.calls[0]?.action).toBeUndefined();
  });

  it('says from the next launch for an agent started outside AASC, with no Restart now (it has no terminal)', async () => {
    useSessionStore.getState().addSession(makeSession({ status: 'working', terminalId: null }));
    render(<Harness sessionId="s1" />);
    fireEvent.click(toggle());
    await waitFor(() => expect(toasts.calls[0]?.message).toBe('Automation on: lite hooks from the next launch'));
    expect(toasts.calls[0]?.action).toBeUndefined();
  });

  it('puts the old value back and says why when the server refuses', async () => {
    useSessionStore.getState().addSession(makeSession());
    fetchMock.mockResolvedValue(reply(409, { success: false, error: 'Automation (lite hooks) works for sessions on this computer only' }));
    render(<Harness sessionId="s1" />);
    fireEvent.click(toggle());
    await waitFor(() => expect(toasts.calls[0]?.type).toBe('error'));
    expect(toasts.calls[0]?.message).toMatch(/this computer only/);
    expect(useSessionStore.getState().sessions.get('s1')).not.toHaveProperty('hookLevel');
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is not offered for a session on another host, unless it is marked (so the mark can be cleared)', () => {
    const remote = { sshConfig: { host: 'build.example.com', port: 22, username: 'u' } };
    useSessionStore.getState().addSession(makeSession(remote));
    const { unmount } = render(<Harness sessionId="s1" />);
    expect(screen.queryByRole('button', { name: 'Automation' })).toBeNull();
    unmount();
    useSessionStore.setState({ sessions: new Map() });
    useSessionStore.getState().addSession(makeSession({ ...remote, hookLevel: 'lite' }));
    render(<Harness sessionId="s1" />);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
  });
});
