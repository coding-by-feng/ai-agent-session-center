import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import PopoutQueueView from './PopoutQueueView';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useSettingsInit } from '@/hooks/useSettingsInit';

// The pop-out is a thin shell: what it must get right is wiring and framing, not the queue
// itself (QueueTab.test.tsx owns that), so the queue and the two boot hooks are stubbed.
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/hooks/useSettingsInit', () => ({ useSettingsInit: vi.fn() }));
vi.mock('./QueueTab', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="queue-tab" data-props={JSON.stringify(props)} />
  ),
}));

const session = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  title: 'KTS Agent',
  projectName: 'kts',
  status: 'waiting',
  terminalId: 'term-1',
  ...over,
});

const seed = (s: Record<string, unknown> | null) =>
  useSessionStore.setState({ sessions: new Map(s ? [['s1', s as never]] : []), selectedSessionId: null });

const queueTabProps = () =>
  JSON.parse(screen.getByTestId('queue-tab').getAttribute('data-props') ?? '{}') as Record<string, unknown>;

describe('PopoutQueueView', () => {
  beforeEach(() => {
    vi.mocked(useWebSocket).mockClear();
    vi.mocked(useSettingsInit).mockClear();
    window.history.pushState({}, '', '/?popout=queue&sessionId=s1');
    document.title = '';
    seed(session());
  });

  afterEach(() => {
    seed(null);
    window.history.pushState({}, '', '/');
  });

  it('boots the way the other pop-outs do: the user\'s settings and a token-less WebSocket', () => {
    render(<PopoutQueueView />);
    expect(useSettingsInit).toHaveBeenCalled();
    expect(useWebSocket).toHaveBeenCalledWith(null);
  });

  it("renders the URL's session as the float window's own copy, filling the window", () => {
    render(<PopoutQueueView />);
    expect(queueTabProps()).toMatchObject({
      sessionId: 's1',
      sessionStatus: 'waiting',
      terminalId: 'term-1',
      fullHeight: true,
      floating: true,
    });
  });

  it('follows the session live: a status change reaches the queue without a reload', () => {
    render(<PopoutQueueView />);
    act(() => seed(session({ status: 'working' })));
    expect(queueTabProps().sessionStatus).toBe('working');
  });

  it('follows a re-key: a session replaced under a new id keeps its queue in the float', () => {
    // A new session starts as a `term-*` placeholder and is re-keyed to its real id when its first
    // hook lands (a `claude --resume` re-keys too). The URL still names the old id.
    render(<PopoutQueueView />);
    expect(queueTabProps().sessionId).toBe('s1');

    act(() => useSessionStore.getState().updateSession({ ...session(), sessionId: 's2', replacesId: 's1' } as never));

    expect(queueTabProps().sessionId).toBe('s2');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('waits, and says so, until the session arrives over the WebSocket', () => {
    seed(null);
    render(<PopoutQueueView />);
    expect(screen.queryByTestId('queue-tab')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/isn't available/i);

    act(() => seed(session()));

    expect(screen.getByTestId('queue-tab')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('titles the window after the session and follows a rename', () => {
    render(<PopoutQueueView />);
    expect(document.title).toBe('Queue — KTS Agent');

    act(() => seed(session({ title: 'Renamed' })));
    expect(document.title).toBe('Queue — Renamed');
  });

  it('shows the toasts the queue talks through — only the main window mounts the app-level container', async () => {
    render(<PopoutQueueView />);
    act(() => showToast('Auto-send enabled', 'info', 5000));
    expect(await screen.findByText('Auto-send enabled')).toBeInTheDocument();
  });

  it('says so when the URL names no session', () => {
    window.history.pushState({}, '', '/?popout=queue');
    render(<PopoutQueueView />);
    expect(screen.queryByTestId('queue-tab')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/no session/i);
  });
});
