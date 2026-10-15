// MobileSessionHeader.test.tsx — the open session's header on a phone (AASC-18).
// Kill and restart are mocked at their request helpers: nothing here reaches a
// real process (.claude/rules/known-issues.md).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/presenceClient', () => ({
  claimControl: vi.fn(async () => ({ ok: true, controller: null })),
  requestControl: vi.fn(async () => ({ ok: true })),
  grantControl: vi.fn(async () => ({ ok: true, controller: null })),
  releaseControl: vi.fn(async () => ({ ok: true, released: true })),
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/restartSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restartSession')>()),
  requestSessionRestart: vi.fn(async () => ({ ok: true, terminalId: 'term-2' })),
}));
vi.mock('@/lib/sessionActions', () => ({
  requestSessionKill: vi.fn(async () => ({ ok: true, message: 'PID 1 terminated' })),
  requestSessionResume: vi.fn(async () => ({ ok: true, message: 'Resuming Claude session in terminal' })),
}));
vi.mock('@/lib/alarmEngine', () => ({
  muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn(),
}));
// The chips have their own tests; here they only need to render.
vi.mock('@/components/session/PlanUsageChip', () => ({ default: () => <span>plan</span> }));
// A phone browser by default; individual tests switch to the phone app.
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsNativeMobileApp: vi.fn(() => false),
}));

import MobileSessionHeader from './MobileSessionHeader';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { requestSessionRestart } from '@/lib/restartSession';
import { requestSessionKill, requestSessionResume } from '@/lib/sessionActions';
import { useIsNativeMobileApp } from '@/lib/platform';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', title: 'AASC Q & A', projectName: 'agent-manager', status: 'approval', source: 'ssh',
    terminalId: 'term-1', model: 'claude-opus-5-5', startedAt: 1, lastActivityAt: 1,
    ...over,
  } as unknown as Session;
}

function renderHeader(session = makeSession()) {
  useSessionStore.setState({ sessions: new Map([[session.sessionId, session]]), selectedSessionId: session.sessionId });
  return render(<MobileSessionHeader session={session} duration="1h 22m" onBack={vi.fn()} />);
}

beforeEach(() => {
  vi.mocked(useIsNativeMobileApp).mockReturnValue(false);
  vi.mocked(requestSessionRestart).mockClear();
  vi.mocked(requestSessionKill).mockClear();
  vi.mocked(requestSessionResume).mockClear();
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
});

describe('MobileSessionHeader', () => {
  it('shows the title, the project and how long it has run', () => {
    renderHeader();
    expect(screen.getByText('AASC Q & A')).toBeInTheDocument();
    expect(screen.getByText('agent-manager · 1h 22m')).toBeInTheDocument();
  });

  it('renames on a tap of the title', () => {
    const setTitle = vi.fn();
    useSessionStore.setState({ setSessionTitle: setTitle } as never);
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: /Rename session/ }));
    const input = screen.getByRole('textbox', { name: 'Session title' });
    fireEvent.change(input, { target: { value: 'Phone work' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(setTitle).toHaveBeenCalledWith('s1', 'Phone work');
  });

  it('restart asks first, then restarts', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Restart session' }));
    const dialog = screen.getByRole('dialog', { name: 'Restart this session?' });
    expect(requestSessionRestart).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(requestSessionRestart).toHaveBeenCalledWith('s1'));
  });

  it('cancelling the restart sends nothing', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Restart session' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(requestSessionRestart).not.toHaveBeenCalled();
  });

  it('kill is in the actions sheet and asks first', async () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kill session…' }));
    const dialog = screen.getByRole('dialog', { name: 'Kill this session?' });
    expect(requestSessionKill).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill session' }));
    await waitFor(() => expect(requestSessionKill).toHaveBeenCalledWith('s1', 'term-1'));
  });

  it('an ended session offers Resume instead of Restart', async () => {
    renderHeader(makeSession({ status: 'ended' } as Partial<Session>));
    expect(screen.queryByRole('button', { name: 'Restart session' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(requestSessionResume).toHaveBeenCalledWith('s1'));
  });

  it('pins from the actions sheet', () => {
    const togglePin = vi.fn();
    useSessionStore.setState({ togglePin } as never);
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('button', { name: /Pin session/ }));
    expect(togglePin).toHaveBeenCalledWith('s1');
  });

  it('does not offer Pin inside the phone app: a paired phone may not pin (AASC-50)', () => {
    vi.mocked(useIsNativeMobileApp).mockReturnValue(true);
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: /Pin session/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Mute sounds/ })).toBeInTheDocument();
  });

  it('has no Share toggle: that route answers localhost only', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });

  it('shows who drives the session', () => {
    usePresenceStore.getState().applyPresence({
      devices: [
        { clientId: 'phone', label: 'iPhone', address: 'x', isLocal: false, connections: 1, connectedAt: 1, lastSeenAt: 1 },
        { clientId: 'desk', label: 'MacBook', address: 'y', isLocal: true, connections: 1, connectedAt: 1, lastSeenAt: 1 },
      ],
      controllers: [{ sessionId: 's1', clientId: 'desk', label: 'MacBook', since: 1, lastActivityAt: Date.now(), online: true }],
      restoreOwner: null,
      workspaceWriter: null,
    });
    renderHeader();
    expect(screen.getByText(/MacBook driving/)).toBeInTheDocument();
  });

  it('shows the interruption badge', () => {
    renderHeader(makeSession({ interruption: { kind: 'rate_limit', line: 'Rate limit reached', at: 1 } } as unknown as Partial<Session>));
    expect(screen.getByText(/rate limit/)).toBeInTheDocument();
  });
});
