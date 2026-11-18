// RoomManagerModal.test.tsx — rooms can be created, renamed and deleted without the LIVE page's corner panel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import RoomManagerModal from './RoomManagerModal';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const room = (id: string, name: string, sessionIds: string[] = []): Room => ({ id, name, sessionIds, collapsed: false, createdAt: 1 } as Room);

describe('RoomManagerModal', () => {
  beforeEach(() => {
    useRoomStore.setState({ rooms: [room('r1', 'AASC', ['s1', 's2']), room('r2', 'Empty')] });
    useSessionStore.setState({
      sessions: new Map([
        ['s1', { sessionId: 's1', status: 'idle' } as Session],
        ['s2', { sessionId: 's2', status: 'ended' } as Session],
      ]),
    });
    useUiStore.setState({ activeModal: 'manage-rooms' });
  });
  afterEach(() => {
    act(() => useUiStore.setState({ activeModal: null }));
  });

  it('lists each room with its live session count', () => {
    render(<RoomManagerModal />);
    expect(screen.getByText('AASC')).toBeInTheDocument();
    expect(screen.getByText('1 session')).toBeInTheDocument();
    expect(screen.getByText('0 sessions')).toBeInTheDocument();
  });

  it('adds a room', () => {
    render(<RoomManagerModal />);
    fireEvent.change(screen.getByRole('textbox', { name: 'New room name' }), { target: { value: 'Billing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    expect(useRoomStore.getState().rooms.map((r) => r.name)).toEqual(['AASC', 'Empty', 'Billing']);
  });

  it('renames a room', () => {
    render(<RoomManagerModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename room AASC' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Room name for AASC' }), { target: { value: 'Session Center' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useRoomStore.getState().rooms[0].name).toBe('Session Center');
  });

  it('deletes only after a second press that says what happens to the sessions', () => {
    render(<RoomManagerModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete room AASC' }));
    expect(useRoomStore.getState().rooms).toHaveLength(2);
    expect(screen.getByText(/Its 1 session stays open/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(useRoomStore.getState().rooms).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete room AASC' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useRoomStore.getState().rooms.map((r) => r.name)).toEqual(['Empty']);
  });
});
