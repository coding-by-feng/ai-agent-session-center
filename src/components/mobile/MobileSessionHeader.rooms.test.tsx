// MobileSessionHeader.rooms.test.tsx — the phone header's AASC-20 additions:
// "Move to room…" and "Manage rooms…" in its ⋯ sheet (features 10, 11), and
// the interruption chip's failure line, a hover title before, now a long press
// (feature 90). Same mocks as MobileSessionHeader.test.tsx: nothing here
// reaches a real process (.claude/rules/known-issues.md).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

import MobileSessionHeader from './MobileSessionHeader';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useRoomStore } from '@/stores/roomStore';

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
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: null });
  useRoomStore.setState({ rooms: [{ id: 'r1', name: 'Work', sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 }] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MobileSessionHeader — rooms', () => {
  it('moves the open session to a room from the ⋯ sheet', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to room…' }));
    fireEvent.click(within(screen.getByTestId('move-to-room')).getByRole('button', { name: /Work/ }));
    expect(useRoomStore.getState().rooms[0].sessionIds).toEqual(['s1']);
    expect(screen.queryByTestId('move-to-room')).toBeNull();
  });

  it('opens the rooms sheet from the ⋯ sheet', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage rooms…' }));
    expect(screen.getByTestId('manage-rooms')).toBeTruthy();
  });
});

describe('MobileSessionHeader — the interruption line on a long press', () => {
  it('shows the failure line when the chip is held', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    renderHeader(makeSession({ interruption: { kind: 'api_error', line: 'API Error: 529 Overloaded', detectedAt: 1 } }));
    const chip = screen.getByText('API error').closest('span[tabindex]') as HTMLElement;
    expect(chip.getAttribute('title')).toBeNull();
    fireEvent.pointerDown(chip, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByRole('tooltip').textContent).toContain('API Error: 529 Overloaded');
  });
});
