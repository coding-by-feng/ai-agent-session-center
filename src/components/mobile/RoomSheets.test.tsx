// RoomSheets.test.tsx — rooms on a phone (AASC-20, features 10 and 11).
//
// What this pins:
//  - "Move to room…" takes a session out of its old room and into the new one
//    (or into none), and can make a room and move into it in one step;
//  - the rooms sheet creates, renames, colours and deletes rooms (delete asks
//    first), and a colour is `Room.color`: `roomIndex`, a 3D world slot, is
//    never written;
//  - both are reachable from a drawer row's ⋯ sheet and the session header's ⋯;
//  - a remote phone is told its room changes stay on the phone.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
const host = vi.hoisted(() => ({ isHost: false }));
vi.mock('./views/hostAccess', () => ({ useIsHostDevice: () => host.isHost }));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'phone', getClientLabel: () => 'iPhone' }));
vi.mock('@/lib/sessionCopy', () => ({ copySession: vi.fn() }));

import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';
import { ManageRoomsSheet, MoveToRoomSheet } from './RoomSheets';
import SessionActionsSheet from './SessionActionsSheet';

const room = (id: string, name: string, sessionIds: string[], roomIndex: number, over: Partial<Room> = {}): Room =>
  ({ id, name, sessionIds, collapsed: false, createdAt: 1, roomIndex, ...over });

const session = (id: string, title: string): Session =>
  ({ sessionId: id, title, projectName: 'app', status: 'idle', lastActivityAt: 1, events: [], promptHistory: [] }) as unknown as Session;

beforeEach(() => {
  host.isHost = false;
  localStorage.clear();
  useRoomStore.setState({
    rooms: [
      room('r2', 'Second', ['b'], 1, { listOrder: 1 }),
      room('r1', 'First', ['a'], 0, { listOrder: 0 }),
    ],
  });
  useSessionStore.setState({ sessions: new Map([['a', session('a', 'Alpha')], ['b', session('b', 'Beta')]]) });
});

const roomsOf = (id: string) => useRoomStore.getState().rooms.filter((r) => r.sessionIds.includes(id)).map((r) => r.name);

describe('MoveToRoomSheet', () => {
  it('lists No room and the rooms in list order, the current one ticked', () => {
    render(<MoveToRoomSheet sessionId="a" onClose={vi.fn()} />);
    const options = within(screen.getByTestId('move-to-room')).getAllByRole('button', { pressed: undefined })
      .filter((b) => b.hasAttribute('aria-pressed'));
    expect(options.map((b) => b.textContent)).toEqual([
      expect.stringContaining('No room'),
      expect.stringContaining('First'),
      expect.stringContaining('Second'),
    ]);
    expect(options[1].getAttribute('aria-pressed')).toBe('true');
    expect(options[1].textContent).toContain('Current');
  });

  it('moves a session out of its room and into another', async () => {
    const onClose = vi.fn();
    render(<MoveToRoomSheet sessionId="a" onClose={onClose} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /Second/ }));
    expect(roomsOf('a')).toEqual(['Second']);
    expect(onClose).toHaveBeenCalled();
  });

  it('takes a session out of every room with No room', async () => {
    render(<MoveToRoomSheet sessionId="a" onClose={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /No room/ }));
    expect(roomsOf('a')).toEqual([]);
  });

  it('makes a room and moves into it in one step, without touching the others\' 3D slots', async () => {
    const user = userEvent.setup();
    render(<MoveToRoomSheet sessionId="a" onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'New room name' }), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create and move' }));
    expect(roomsOf('a')).toEqual(['Fresh']);
    const byName = Object.fromEntries(useRoomStore.getState().rooms.map((r) => [r.name, r.roomIndex]));
    expect(byName).toEqual({ Second: 1, First: 0, Fresh: 2 });
  });

  it('says a remote phone\'s room changes stay on the phone, and not on the Mac itself', () => {
    const { unmount } = render(<MoveToRoomSheet sessionId="a" onClose={vi.fn()} />);
    expect(screen.getByText(/stay on this phone/)).toBeTruthy();
    unmount();
    host.isHost = true;
    render(<MoveToRoomSheet sessionId="a" onClose={vi.fn()} />);
    expect(screen.queryByText(/stay on this phone/)).toBeNull();
  });
});

describe('ManageRoomsSheet', () => {
  it('creates and renames rooms', async () => {
    const user = userEvent.setup();
    render(<ManageRoomsSheet open onClose={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'New room name' }), 'Games');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(useRoomStore.getState().rooms.map((r) => r.name)).toContain('Games');

    await user.click(screen.getByRole('button', { name: 'Rename First' }));
    const field = screen.getByRole('textbox', { name: 'New name for First' });
    await user.clear(field);
    await user.type(field, 'Main');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(useRoomStore.getState().rooms.find((r) => r.id === 'r1')?.name).toBe('Main');
  });

  it('colours a room with Room.color, never its roomIndex, and can go back to the default', async () => {
    const user = userEvent.setup();
    render(<ManageRoomsSheet open onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Colour of Second' }));
    await user.click(screen.getByRole('button', { name: 'Pink' }));
    let second = useRoomStore.getState().rooms.find((r) => r.id === 'r2')!;
    expect(second.color).toBe(ROOM_COLOR_PALETTE[5]);
    expect(second.roomIndex).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Colour of Second' }));
    expect(screen.getByRole('button', { name: 'Pink' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Default' }));
    second = useRoomStore.getState().rooms.find((r) => r.id === 'r2')!;
    expect(second.color).toBeUndefined();
    expect(second.roomIndex).toBe(1);
  });

  it('deletes a room only after a confirm, and its sessions stay', async () => {
    const user = userEvent.setup();
    render(<ManageRoomsSheet open onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete First' }));
    expect(useRoomStore.getState().rooms).toHaveLength(2);
    const confirm = await screen.findByRole('dialog', { name: 'Delete room "First"?' });
    expect(confirm.textContent).toMatch(/1 session stay open/);
    await user.click(within(confirm).getByRole('button', { name: 'Delete room' }));
    expect(useRoomStore.getState().rooms.map((r) => r.name)).toEqual(['Second']);
    expect(useSessionStore.getState().sessions.has('a')).toBe(true);
  });
});

describe('the ⋯ sheets reach both', () => {
  it('a drawer row\'s actions sheet shows the room and opens "Move to room…"', async () => {
    const user = userEvent.setup();
    render(<SessionActionsSheet sessionId="b" onClose={vi.fn()} />);
    const section = screen.getByRole('region', { name: 'Room' });
    expect(section.textContent).toContain('Second');
    await user.click(within(section).getByRole('button', { name: 'Move to room…' }));
    await user.click(within(await screen.findByTestId('move-to-room')).getByRole('button', { name: /First/ }));
    expect(roomsOf('b')).toEqual(['First']);
    expect(screen.getByRole('region', { name: 'Room' }).textContent).toContain('First');
  });

  it('opens the rooms sheet from the actions sheet', async () => {
    const user = userEvent.setup();
    render(<SessionActionsSheet sessionId="b" onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Manage rooms…' }));
    expect(await screen.findByTestId('manage-rooms')).toBeTruthy();
  });
});
