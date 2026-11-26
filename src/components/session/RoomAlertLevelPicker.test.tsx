// RoomAlertLevelPicker.test.tsx — the room frame's alert level (Full, Nov 25 2026): stored on the room by the Mac's
// window, sent as an op from any other, and a way to make sessions with their own level follow the room.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RoomAlertLevelPicker from './RoomAlertLevelPicker';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { getClientId } from '@/lib/deviceIdentity';
import { DEFAULT_ALERT_CONFIG } from '@/lib/attention';
import type { Session } from '@/types';

const mk = (sessionId: string, over: Partial<Session> = {}) =>
  ({ sessionId, status: 'waiting', title: sessionId, events: [], ...over }) as unknown as Session;

function renderAlpha(list: Session[], roomLevel?: 'loud') {
  const sessions = new Map(list.map((s) => [s.sessionId, s]));
  useSessionStore.setState({ sessions } as never);
  useRoomStore.setState({ rooms: [{ id: 'room-a', name: 'Alpha', sessionIds: list.map((s) => s.sessionId), ...(roomLevel ? { alertLevel: roomLevel } : {}) } as never] });
  render(<RoomAlertLevelPicker roomId="room-a" roomName="Alpha" sessionIds={list.map((s) => s.sessionId)} sessions={sessions} />);
}

const trigger = () => screen.getByRole('button', { name: /^Alert level for Alpha:/ });
const roomLevel = () => useRoomStore.getState().rooms.find((r) => r.id === 'room-a')?.alertLevel;

describe('RoomAlertLevelPicker', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    useAlertConfigStore.setState({ config: DEFAULT_ALERT_CONFIG });
    usePresenceStore.setState({ received: true, workspaceWriter: getClientId() } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows the default level until the room has one, then the room\'s', () => {
    renderAlpha([mk('a')]);
    expect(trigger()).toHaveAccessibleName('Alert level for Alpha: Normal');
    fireEvent.click(trigger());
    expect(screen.getByRole('menuitemradio', { name: 'Follow default (Normal)' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Loud' }));
    expect(roomLevel()).toBe('loud');
    expect(trigger()).toHaveAccessibleName('Alert level for Alpha: Loud');
  });

  it('Follow default clears the room\'s level', async () => {
    renderAlpha([mk('a')], 'loud');
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Follow default (Normal)' }));
    await waitFor(() => expect(roomLevel()).toBeUndefined());
  });

  it('from a window that does not own the rooms, sends the change to the Mac instead', async () => {
    usePresenceStore.setState({ received: true, workspaceWriter: 'someone-else' } as never);
    renderAlpha([mk('a')]);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Urgent' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/rooms/ops', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'alert-level', roomId: 'room-a', level: 'urgent' }),
    })));
    expect(roomLevel()).toBeUndefined();
  });

  it('offers to make the sessions with a level of their own follow the room', () => {
    renderAlpha([mk('a', { alertLevel: 'quiet' }), mk('b', { alerted: true }), mk('c')]);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Make 2 sessions follow the room' }));
    const store = useSessionStore.getState().sessions;
    expect(store.get('a')).not.toHaveProperty('alertLevel');
    expect(store.get('b')).not.toHaveProperty('alerted');
    const puts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT').map(([url]) => url);
    expect(puts).toEqual(['/api/sessions/a/alert-level', '/api/sessions/b/alert-level']);
  });

  it('is absent when the room has no live session', () => {
    renderAlpha([mk('x', { status: 'ended' })]);
    expect(screen.queryByRole('button', { name: /^Alert level for Alpha:/ })).toBeNull();
  });
});
