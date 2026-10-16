// roomSync.test.ts — AASC-20: rooms come from the Mac, and changes are saved there.
//
// What this pins:
//  - the workspace writer's main window pushes its room list (only ids of sessions it has) to PUT
//    /api/rooms, ~500 ms after a change, once per burst, once after it connects, never the same list twice;
//    never from a pop-out, the phone app, a non-writer, or before the restore decision;
//  - the writer applies a `room_op` with its room store and ignores `rooms_update` (it is the source);
//  - everyone else takes `rooms_update` / GET /api/rooms as the list, newest revision wins, keeps its own
//    collapsed flags, never applies a `room_op`; a pop-out keeps the list in memory only;
//  - a device that doesn't know yet whether it is the writer holds the list until presence says.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Room } from '@/types';

const role = vi.hoisted(() => ({ popout: false, native: false, restorePending: false, importing: false }));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'This Mac' }));
vi.mock('@/lib/windowRole', () => ({ isPopoutWindow: () => role.popout }));
vi.mock('@/lib/platform', () => ({ isNativeMobileApp: () => role.native }));
vi.mock('@/lib/workspaceSnapshot', () => ({
  isRestorePending: () => role.restorePending,
  isImportInProgress: () => role.importing,
}));

import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';
import {
  receiveRooms, handleRoomOpMessage, onRoomsSocketConnected, startRoomSync, hasServerRooms, requestRoomChange,
  ROOM_PUSH_DELAY_MS, ROOM_RESYNC_MS, _resetRoomSyncForTests,
} from './roomSync';
import { NO_WRITER_MESSAGE } from './roomOps';

const room = (id: string, sessionIds: string[], over: Partial<Room> = {}): Room =>
  ({ id, name: `Room ${id}`, sessionIds, collapsed: false, createdAt: 1, roomIndex: 0, ...over });

const fetchMock = vi.fn();

function setWriter(writer: string | null): void {
  usePresenceStore.getState().applyPresence({ devices: [], controllers: [], restoreOwner: null, workspaceWriter: writer });
}

function sessions(...ids: string[]): void {
  useSessionStore.setState({ sessions: new Map(ids.map((id) => [id, { sessionId: id } as never])) });
}

/** The bodies PUT to /api/rooms so far. */
const puts = () => fetchMock.mock.calls
  .filter(([url, init]) => url === '/api/rooms' && (init as RequestInit | undefined)?.method === 'PUT')
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { rooms: Room[] });

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(role, { popout: false, native: false, restorePending: false, importing: false });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, revision: 1, rooms: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  _resetRoomSyncForTests();
  usePresenceStore.setState({ received: false, workspaceWriter: null });
  useWsStore.setState({ connected: true, snapshotReceived: true });
  sessions('a', 'b');
  useRoomStore.setState({ rooms: [room('r1', ['a', 'gone']), room('r2', ['b'])] });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the writer pushes its rooms', () => {
  it('pushes once after connect, then ~500 ms after a burst of changes, with only ids of sessions it has', async () => {
    setWriter('me');
    stop = startRoomSync();
    onRoomsSocketConnected();
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].rooms.map((r) => [r.id, r.sessionIds])).toEqual([['r1', ['a']], ['r2', ['b']]]);

    useRoomStore.getState().renameRoom('r1', 'One');
    useRoomStore.getState().renameRoom('r1', 'Uno');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS - 1);
    expect(puts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(puts()).toHaveLength(2);
    expect(puts()[1].rooms[0].name).toBe('Uno');
  });

  it('never pushes the same list twice, and pushes again when a session leaves its store', async () => {
    setWriter('me');
    stop = startRoomSync();
    onRoomsSocketConnected();
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS);
    useRoomStore.getState().toggleCollapse('r2');
    useRoomStore.getState().toggleCollapse('r2');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS);
    expect(puts()).toHaveLength(1);

    sessions('a');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS);
    expect(puts()).toHaveLength(2);
    expect(puts()[1].rooms.find((r) => r.id === 'r2')?.sessionIds).toEqual([]);
  });

  it('starts pushing when it becomes the writer, and not before the restore decision', async () => {
    role.restorePending = true;
    setWriter('someone-else');
    stop = startRoomSync();
    onRoomsSocketConnected();
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS * 2);
    setWriter('me');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS * 2);
    expect(puts()).toHaveLength(0);

    role.restorePending = false;
    useRoomStore.getState().renameRoom('r2', 'Two');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS);
    expect(puts()).toHaveLength(1);
  });

  it.each([
    ['a pop-out of the writer\'s own device', () => { role.popout = true; }],
    ['the phone app', () => { role.native = true; }],
  ])('never pushes from %s', async (_label, arrange) => {
    arrange();
    setWriter('me');
    stop = startRoomSync();
    onRoomsSocketConnected();
    useRoomStore.getState().renameRoom('r1', 'x');
    await vi.advanceTimersByTimeAsync(ROOM_PUSH_DELAY_MS * 2);
    expect(puts()).toHaveLength(0);
  });

  it('ignores rooms_update: it is the source', () => {
    setWriter('me');
    receiveRooms({ revision: 9, rooms: [room('elsewhere', [])] });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('the writer applies room changes other devices ask for', () => {
  beforeEach(() => setWriter('me'));
  const op = (o: unknown) => handleRoomOpMessage({ type: 'room_op', opId: 'op-1', op: o });
  const byId = (id: string) => useRoomStore.getState().rooms.find((r) => r.id === id);

  it('creates a room, and can move a session into it in the same op', () => {
    op({ type: 'create', name: 'Fresh', sessionId: 'a' });
    const fresh = useRoomStore.getState().rooms.find((r) => r.name === 'Fresh');
    expect(fresh?.sessionIds).toEqual(['a']);
    expect(byId('r1')?.sessionIds).toEqual(['gone']);
  });

  it('renames, colours (never the 3D slot) and deletes', () => {
    op({ type: 'rename', roomId: 'r1', name: 'Main' });
    op({ type: 'color', roomId: 'r2', color: ROOM_COLOR_PALETTE[3] });
    expect(byId('r1')?.name).toBe('Main');
    expect(byId('r2')).toMatchObject({ color: ROOM_COLOR_PALETTE[3], roomIndex: 0 });
    op({ type: 'color', roomId: 'r2', color: null });
    expect(byId('r2')?.color).toBeUndefined();
    op({ type: 'delete', roomId: 'r1' });
    expect(byId('r1')).toBeUndefined();
  });

  it('moves a session between rooms and out of every room', () => {
    op({ type: 'move', sessionId: 'a', roomId: 'r2' });
    expect(byId('r1')?.sessionIds).toEqual(['gone']);
    expect(byId('r2')?.sessionIds).toEqual(['b', 'a']);
    op({ type: 'move', sessionId: 'a', roomId: null });
    expect(byId('r2')?.sessionIds).toEqual(['b']);
  });

  it('reorders (AASC-55): listOrder only, rooms the asker can\'t see keep their slot, roomIndex never moves', () => {
    useRoomStore.setState({ rooms: [
      room('r1', ['a'], { roomIndex: 3 }),
      room('hidden', [], { roomIndex: 0 }),
      room('r2', ['b'], { roomIndex: 7 }),
    ] });
    // List order now (by the 3D slot, never reordered yet): hidden, r1, r2.
    op({ type: 'reorder', roomIds: ['r2', 'r1'] });
    const rooms = useRoomStore.getState().rooms;
    expect(Object.fromEntries(rooms.map((r) => [r.id, r.listOrder]))).toEqual({ hidden: 0, r2: 1, r1: 2 });
    expect(Object.fromEntries(rooms.map((r) => [r.id, r.roomIndex]))).toEqual({ r1: 3, hidden: 0, r2: 7 });
    expect(rooms.map((r) => r.id)).toEqual(['r1', 'hidden', 'r2']); // the array (and so the 3D scene) untouched
  });

  it('ignores a malformed reorder, and room ids it doesn\'t have inside one', () => {
    const before = JSON.stringify(useRoomStore.getState().rooms);
    op({ type: 'reorder', roomIds: [] });
    op({ type: 'reorder', roomIds: ['r1', 'r1'] });
    op({ type: 'reorder', roomIds: 'r1' });
    op({ type: 'reorder', roomIds: ['r1', 4] });
    op({ type: 'reorder', roomIds: ['nope'] });
    expect(JSON.stringify(useRoomStore.getState().rooms)).toBe(before);
    op({ type: 'reorder', roomIds: ['r2', 'nope', 'r1'] });
    expect(useRoomStore.getState().rooms.map((r) => [r.id, r.listOrder])).toEqual([['r1', 1], ['r2', 0]]);
  });

  it('ignores an op for a room it doesn\'t have, a colour off the palette and a malformed op', () => {
    const before = JSON.stringify(useRoomStore.getState().rooms);
    op({ type: 'move', sessionId: 'a', roomId: 'nope' });
    op({ type: 'rename', roomId: 'nope', name: 'x' });
    op({ type: 'color', roomId: 'r1', color: 'url(x)' });
    op({ type: 'teleport' });
    handleRoomOpMessage({ type: 'room_op' });
    expect(JSON.stringify(useRoomStore.getState().rooms)).toBe(before);
  });

  it('is applied only by the writer\'s main window', () => {
    role.popout = true;
    op({ type: 'delete', roomId: 'r1' });
    expect(byId('r1')).toBeDefined();
    role.popout = false;
    setWriter('the-mac');
    op({ type: 'delete', roomId: 'r1' });
    expect(byId('r1')).toBeDefined();
  });
});

describe('everyone else takes the Mac\'s list', () => {
  it('hydrates on rooms_update, newest revision wins, and keeps its own collapsed flags', () => {
    setWriter('the-mac');
    useRoomStore.getState().toggleCollapse('r2');
    receiveRooms({ revision: 3, rooms: [room('r2', ['b'], { name: 'From the Mac' }), room('r9', [])] });
    expect(useRoomStore.getState().rooms).toEqual([
      room('r2', ['b'], { name: 'From the Mac', collapsed: true }),
      room('r9', []),
    ]);
    expect(JSON.parse(localStorage.getItem('session-rooms') ?? '[]')).toHaveLength(2);
    expect(hasServerRooms()).toBe(true);

    receiveRooms({ revision: 2, rooms: [] }); // a late answer
    expect(useRoomStore.getState().rooms).toHaveLength(2);
  });

  it('a pop-out keeps the list in memory: the main window owns localStorage', () => {
    role.popout = true;
    localStorage.setItem('session-rooms', '[]');
    receiveRooms({ revision: 1, rooms: [room('r9', [])] });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r9']);
    expect(localStorage.getItem('session-rooms')).toBe('[]');
  });

  it('never applies a room_op', () => {
    setWriter('the-mac');
    handleRoomOpMessage({ type: 'room_op', opId: 'x', op: { type: 'delete', roomId: 'r1' } });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('holds the list until presence says whether this window is the writer', () => {
    receiveRooms({ revision: 4, rooms: [room('r9', [])] });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r1', 'r2']);
    stop = startRoomSync();
    setWriter('the-mac');
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r9']);
  });

  it('drops a held list when presence says this window is the writer', () => {
    receiveRooms({ revision: 4, rooms: [room('r9', [])] });
    stop = startRoomSync();
    setWriter('me');
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('reads the list with GET once it connects (a paired phone may not read the workspace)', async () => {
    role.native = true;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true, revision: 7, rooms: [room('r9', ['a'])] }), { status: 200 }));
    onRoomsSocketConnected();
    await vi.waitFor(() => expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r9']));
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms', expect.anything());
  });

  it('starts over after a reconnect: the server may have restarted and counts revisions from 0', async () => {
    setWriter('the-mac');
    receiveRooms({ revision: 40, rooms: [room('r9', [])] });
    onRoomsSocketConnected();
    receiveRooms({ revision: 1, rooms: [room('r10', [])] });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['r10']);
  });

  it('skips a malformed room rather than taking it', () => {
    setWriter('the-mac');
    receiveRooms({ revision: 1, rooms: [room('ok', ['a']), { id: 5 } as unknown as Room] });
    expect(useRoomStore.getState().rooms.map((r) => r.id)).toEqual(['ok']);
  });
});

describe('a room change from this device\'s UI (AASC-55)', () => {
  const byId = (id: string) => useRoomStore.getState().rooms.find((r) => r.id === id);
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const gets = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/rooms' && (init as RequestInit | undefined)?.method === 'GET');
  const opBodies = () => fetchMock.mock.calls.filter(([url]) => url === '/api/rooms/ops').map(([, init]) => JSON.parse(String((init as RequestInit).body)));

  beforeEach(() => {
    useRoomStore.setState({ rooms: [room('r1', ['a'], { roomIndex: 2 }), room('r2', ['b'], { roomIndex: 5 })] });
  });

  it('on the writer: applies at once, asks nobody, and a reorder never moves the 3D slot', async () => {
    setWriter('me');
    expect(await requestRoomChange({ type: 'reorder', roomIds: ['r2', 'r1'] }, true)).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect([byId('r2')?.listOrder, byId('r1')?.listOrder]).toEqual([0, 1]);
    expect([byId('r1')?.roomIndex, byId('r2')?.roomIndex]).toEqual([2, 5]);
  });

  it('elsewhere: posts the op, shows an accepted reorder or move here, and waits for the Mac\'s list', async () => {
    setWriter('the-mac');
    receiveRooms({ revision: 4, rooms: useRoomStore.getState().rooms });
    fetchMock.mockImplementation(async () => answer(202, { ok: true, opId: 'op-1' }));
    await requestRoomChange({ type: 'reorder', roomIds: ['r2', 'r1'] }, false);
    await requestRoomChange({ type: 'move', sessionId: 'a', roomId: 'r2' }, false);
    expect(opBodies()).toEqual([{ type: 'reorder', roomIds: ['r2', 'r1'] }, { type: 'move', sessionId: 'a', roomId: 'r2' }]);
    expect(byId('r2')).toMatchObject({ listOrder: 0, sessionIds: ['b', 'a'], roomIndex: 5 });
    // The Mac's push arrives: nothing is read again.
    receiveRooms({ revision: 5, rooms: useRoomStore.getState().rooms });
    await vi.advanceTimersByTimeAsync(ROOM_RESYNC_MS + 10);
    expect(gets()).toHaveLength(0);
  });

  it('elsewhere: when no newer list comes (the Mac could not apply it), reads the list again and drops the guess', async () => {
    setWriter('the-mac');
    const macList = useRoomStore.getState().rooms;
    receiveRooms({ revision: 4, rooms: macList });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === '/api/rooms' && init?.method === 'GET'
      ? answer(200, { ok: true, revision: 4, rooms: macList })
      : answer(202, { ok: true, opId: 'op-1' })));
    await requestRoomChange({ type: 'reorder', roomIds: ['r2', 'r1'] }, false);
    expect(byId('r2')?.listOrder).toBe(0);
    await vi.advanceTimersByTimeAsync(ROOM_RESYNC_MS + 10);
    expect(gets()).toHaveLength(1);
    expect(byId('r2')?.listOrder).toBeUndefined();
  });

  it('elsewhere: leaves the list alone when the Mac refuses, and for ops other than a gesture', async () => {
    setWriter('the-mac');
    fetchMock.mockResolvedValueOnce(answer(409, { ok: false, error: 'no-writer' }));
    const before = JSON.stringify(useRoomStore.getState().rooms);
    expect(await requestRoomChange({ type: 'reorder', roomIds: ['r2', 'r1'] }, false))
      .toEqual({ ok: false, message: NO_WRITER_MESSAGE });
    fetchMock.mockResolvedValueOnce(answer(202, { ok: true }));
    await requestRoomChange({ type: 'rename', roomId: 'r1', name: 'Main' }, false);
    expect(JSON.stringify(useRoomStore.getState().rooms)).toBe(before);
    await vi.advanceTimersByTimeAsync(ROOM_RESYNC_MS + 10);
    expect(gets()).toHaveLength(0);
  });
});
