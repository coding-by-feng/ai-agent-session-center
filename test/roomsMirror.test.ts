// test/roomsMirror.test.ts — AASC-20: rooms on the phone come from the Mac, and changes are saved there.
//
// Rooms live in each browser's localStorage. The Mac's main window (the workspace writer) now pushes its list
// to the server, which keeps it, cuts it per device for what that device may see, and hands room changes
// asked for by other devices to the writer. The mirror and the routes run here on fakes: no session store,
// no sockets, no process. The real wiring (apiRouter + wsManager) is in test/roomsApi.test.ts.
import express from 'express';
import { createServer, type Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createRoomsMirror, parseRoomList, parseRoomOp, roomsViewFor, ROOM_LIMITS,
  type RoomSessionRef,
} from '../server/roomsMirror.js';
import { createRoomsService, ROOM_OPS_PER_WINDOW, type RoomsServiceDeps } from '../server/roomsRouter.js';
import { ROOM_COLOR_PALETTE } from '../src/lib/roomColor.js';
import type { Room } from '../src/types/room.js';

const room = (id: string, sessionIds: string[], over: Partial<Room> = {}): Room =>
  ({ id, name: `Room ${id}`, sessionIds, collapsed: false, createdAt: 1, roomIndex: 0, ...over });

/** Sessions the server knows: `shared` is opted in, `hidden` is not, `old` is an alias of `shared`. */
const SESSIONS: Record<string, RoomSessionRef> = {
  shared: { sessionId: 'shared', remoteVisible: true },
  shared2: { sessionId: 'shared2', remoteVisible: true },
  hidden: { sessionId: 'hidden' },
  hidden2: { sessionId: 'hidden2', remoteVisible: false },
};
const ALIASES: Record<string, string> = { old: 'shared', 'term-hidden': 'hidden' };
const lookup = (id: string): RoomSessionRef | null => SESSIONS[ALIASES[id] ?? id] ?? null;

// ── The list a writer may push ──────────────────────────────────────────────────────────────────────────

describe('parseRoomList', () => {
  it('takes the room store\'s shape and drops fields it does not know', () => {
    const parsed = parseRoomList({ rooms: [{ ...room('r1', ['a']), listOrder: 2, color: ROOM_COLOR_PALETTE[1], extra: 'x' }] });
    expect(parsed).toEqual([{ ...room('r1', ['a']), listOrder: 2, color: ROOM_COLOR_PALETTE[1] }]);
  });

  it('refuses a list too long, a name too long, too many sessions, a duplicate room and a malformed body', () => {
    const many = Array.from({ length: ROOM_LIMITS.rooms + 1 }, (_, i) => room(`r${i}`, []));
    expect(parseRoomList({ rooms: many })).toBeNull();
    expect(parseRoomList({ rooms: [room('r1', [], { name: 'x'.repeat(ROOM_LIMITS.name + 1) })] })).toBeNull();
    const ids = Array.from({ length: ROOM_LIMITS.sessionsPerRoom + 1 }, (_, i) => `s${i}`);
    expect(parseRoomList({ rooms: [room('r1', ids)] })).toBeNull();
    expect(parseRoomList({ rooms: [room('r1', []), room('r1', [])] })).toBeNull();
    expect(parseRoomList({ rooms: 'nope' })).toBeNull();
    expect(parseRoomList(null)).toBeNull();
  });
});

describe('parseRoomOp', () => {
  it('takes the five room changes, names trimmed', () => {
    expect(parseRoomOp({ type: 'create', name: '  Games ' })).toEqual({ type: 'create', name: 'Games' });
    expect(parseRoomOp({ type: 'create', name: 'Games', sessionId: 's' })).toEqual({ type: 'create', name: 'Games', sessionId: 's' });
    expect(parseRoomOp({ type: 'rename', roomId: 'r1', name: 'Main' })).toEqual({ type: 'rename', roomId: 'r1', name: 'Main' });
    expect(parseRoomOp({ type: 'color', roomId: 'r1', color: ROOM_COLOR_PALETTE[5] })).toEqual({ type: 'color', roomId: 'r1', color: ROOM_COLOR_PALETTE[5] });
    expect(parseRoomOp({ type: 'color', roomId: 'r1', color: null })).toEqual({ type: 'color', roomId: 'r1', color: null });
    expect(parseRoomOp({ type: 'delete', roomId: 'r1' })).toEqual({ type: 'delete', roomId: 'r1' });
    expect(parseRoomOp({ type: 'move', sessionId: 's', roomId: null })).toEqual({ type: 'move', sessionId: 's', roomId: null });
  });

  it.each([
    [{ type: 'create', name: '   ' }],
    [{ type: 'create', name: 'x'.repeat(ROOM_LIMITS.name + 1) }],
    [{ type: 'create', name: 'two\nlines' }],
    [{ type: 'rename', roomId: '', name: 'x' }],
    [{ type: 'color', roomId: 'r1', color: 'red; background:url(x)' }],
    [{ type: 'move', sessionId: 's' }],
    [{ type: 'move', sessionId: 's', roomId: 'r1', roomIndex: 3 }],
    [{ type: 'setRoomIndex', roomId: 'r1', roomIndex: 2 }],
    [null],
  ])('refuses %j', (body) => {
    expect(parseRoomOp(body)).toBeNull();
  });
});

// ── What each device sees ────────────────────────────────────────────────────────────────────────────────

describe('roomsViewFor', () => {
  const rooms = [
    room('mixed', ['shared', 'hidden']),
    room('secret', ['hidden', 'hidden2']),
    room('empty', []),
    room('aliased', ['old', 'shared']),
    room('ghost', ['no-such-session']),
  ];

  it('gives this machine every room and every session, under their current ids', () => {
    expect(roomsViewFor(rooms, true, lookup).map((r) => [r.id, r.sessionIds])).toEqual([
      ['mixed', ['shared', 'hidden']],
      ['secret', ['hidden', 'hidden2']],
      ['empty', []],
      ['aliased', ['shared']],
      ['ghost', ['no-such-session']],
    ]);
  });

  it('gives a remote device only shared sessions, and no room whose sessions are all hidden from it', () => {
    expect(roomsViewFor(rooms, false, lookup).map((r) => [r.id, r.sessionIds])).toEqual([
      ['mixed', ['shared']],
      ['empty', []],
      ['aliased', ['shared']],
    ]);
  });

  it('fails closed on an id it cannot resolve: not sent, and it counts as hidden', () => {
    const view = roomsViewFor(rooms, false, lookup);
    expect(JSON.stringify(view)).not.toContain('no-such-session');
    expect(JSON.stringify(view)).not.toContain('hidden');
    expect(view.find((r) => r.id === 'ghost')).toBeUndefined();
  });

  it('never changes the list it was given', () => {
    const before = JSON.stringify(rooms);
    roomsViewFor(rooms, false, lookup);
    expect(JSON.stringify(rooms)).toBe(before);
  });
});

describe('createRoomsMirror', () => {
  it('reads the saved snapshot\'s rooms once, on first use', () => {
    const seed = vi.fn(() => [room('seeded', [])]);
    const mirror = createRoomsMirror(seed);
    expect(seed).not.toHaveBeenCalled();
    expect(mirror.get().rooms.map((r) => r.id)).toEqual(['seeded']);
    mirror.get();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('never seeds over a list the writer already pushed', () => {
    const seed = vi.fn(() => [room('seeded', [])]);
    const mirror = createRoomsMirror(seed);
    mirror.set([room('pushed', [])]);
    expect(mirror.get().rooms.map((r) => r.id)).toEqual(['pushed']);
    expect(seed).not.toHaveBeenCalled();
  });

  it('bumps the revision on every change, and not for the same list again', () => {
    const mirror = createRoomsMirror(() => []);
    const r0 = mirror.get().revision;
    const first = mirror.set([room('a', ['s'])]);
    expect(first).toEqual({ changed: true, revision: r0 + 1 });
    expect(mirror.set([room('a', ['s'])])).toEqual({ changed: false, revision: r0 + 1 });
    expect(mirror.touch()).toBe(r0 + 2);
  });

  it('a seed that throws is no rooms, not a crash', () => {
    const mirror = createRoomsMirror(() => { throw new Error('unreadable'); });
    expect(mirror.get().rooms).toEqual([]);
  });
});

// ── The routes, on fakes ─────────────────────────────────────────────────────────────────────────────────

interface Harness {
  deps: RoomsServiceDeps;
  published: Array<{ local: unknown; remote: unknown }>;
  sent: Array<{ clientId: string; msg: { type: string; opId: string; op: unknown } }>;
  owner: { id: string | null; delivered: number };
  writer: { id: string | null };
  republish: () => void;
}

let server: Server;
let base = '';
let h: Harness;
let clock = 1_000_000;

function makeHarness(): Harness {
  const published: Harness['published'] = [];
  const sent: Harness['sent'] = [];
  const owner = { id: 'mac' as string | null, delivered: 1 };
  const writer = { id: 'mac' as string | null };
  const deps: RoomsServiceDeps = {
    seed: () => [],
    isLocal: (req) => req.headers['x-test-remote'] !== '1',
    clientId: (req) => String(req.headers['x-aasc-client-id'] ?? ''),
    canWriteRooms: (clientId) => writer.id === null || writer.id === clientId,
    roomOwner: async () => owner.id,
    getSession: lookup,
    publish: async (local, remote) => { published.push({ local, remote }); },
    sendToClient: async (clientId, msg) => {
      sent.push({ clientId, msg: msg as Harness['sent'][number]['msg'] });
      return owner.delivered;
    },
    newOpId: () => `op-${sent.length + 1}`,
    now: () => clock,
  };
  return { deps, published, sent, owner, writer, republish: () => {} };
}

const MAC = { 'X-AASC-Client-Id': 'mac' };
const PHONE = { 'X-AASC-Client-Id': 'phone', 'X-Test-Remote': '1' };
const LAN_TAB = { 'X-AASC-Client-Id': 'other-tab' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

const MAC_ROOMS = [
  room('mixed', ['shared', 'hidden']),
  room('secret', ['hidden']),
  room('empty', []),
  room('target', ['shared2']),
];

beforeAll(async () => {
  // One app whose service is swapped per test, so every test starts from a fresh mirror and fresh limits.
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => current.router(req, res, next));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let current: ReturnType<typeof createRoomsService>;
beforeEach(async () => {
  clock += 60_000;
  h = makeHarness();
  current = createRoomsService(h.deps);
  h.republish = current.republish;
  expect((await call('PUT', '/rooms', MAC, { rooms: MAC_ROOMS })).status).toBe(200);
  h.published.length = 0;
});

describe('PUT /rooms', () => {
  it('only the workspace writer may set the list', async () => {
    const res = await call('PUT', '/rooms', LAN_TAB, { rooms: [] });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('not-workspace-writer');
    expect(h.published).toHaveLength(0);
  });

  it('bumps the revision and broadcasts this machine\'s list and a remote device\'s cut', async () => {
    const before = (await call('GET', '/rooms', MAC)).json.revision as number;
    const res = await call('PUT', '/rooms', MAC, { rooms: [...MAC_ROOMS, room('new', [])] });
    expect(res.status).toBe(200);
    expect(res.json.revision).toBe(before + 1);
    expect(h.published).toHaveLength(1);
    const { local, remote } = h.published[0] as { local: { type: string; revision: number; rooms: Room[] }; remote: { rooms: Room[] } };
    expect(local.type).toBe('rooms_update');
    expect(local.revision).toBe(before + 1);
    expect(local.rooms.map((r) => r.id)).toEqual(['mixed', 'secret', 'empty', 'target', 'new']);
    expect(remote.rooms.map((r) => r.id)).toEqual(['mixed', 'empty', 'target', 'new']);
    expect(JSON.stringify(remote)).not.toContain('hidden');
  });

  it('does not broadcast the same list twice', async () => {
    const res = await call('PUT', '/rooms', MAC, { rooms: MAC_ROOMS });
    expect(res.status).toBe(200);
    expect(h.published).toHaveLength(0);
  });

  it('refuses a malformed list', async () => {
    expect((await call('PUT', '/rooms', MAC, { rooms: [{ id: 'r1' }] })).status).toBe(400);
  });
});

describe('GET /rooms', () => {
  it('gives this machine the whole list', async () => {
    const res = await call('GET', '/rooms', LAN_TAB);
    expect((res.json.rooms as Room[]).map((r) => r.id)).toEqual(['mixed', 'secret', 'empty', 'target']);
    expect(typeof res.json.revision).toBe('number');
  });

  it('gives a remote device only what is shared with it', async () => {
    const res = await call('GET', '/rooms', PHONE);
    expect((res.json.rooms as Room[]).map((r) => [r.id, r.sessionIds])).toEqual([
      ['mixed', ['shared']], ['empty', []], ['target', ['shared2']],
    ]);
  });
});

describe('republish (a session was shared or un-shared)', () => {
  it('broadcasts every device\'s cut again under a newer revision', async () => {
    const before = (await call('GET', '/rooms', MAC)).json.revision as number;
    h.republish();
    await vi.waitFor(() => expect(h.published).toHaveLength(1));
    expect((h.published[0].remote as { revision: number }).revision).toBe(before + 1);
  });
});

describe('POST /rooms/ops', () => {
  it('hands a valid op to the writer only and answers 202 with its id', async () => {
    const res = await call('POST', '/rooms/ops', PHONE, { type: 'rename', roomId: 'mixed', name: 'Mixed bag' });
    expect(res.status).toBe(202);
    expect(res.json.opId).toBe('op-1');
    expect(h.sent).toEqual([{ clientId: 'mac', msg: { type: 'room_op', opId: 'op-1', op: { type: 'rename', roomId: 'mixed', name: 'Mixed bag' } } }]);
    expect(h.published).toHaveLength(0); // the writer's own push broadcasts the result
  });

  it('forwards a session under its current id', async () => {
    await call('POST', '/rooms/ops', PHONE, { type: 'move', sessionId: 'old', roomId: 'target' });
    expect(h.sent[0].msg.op).toEqual({ type: 'move', sessionId: 'shared', roomId: 'target' });
  });

  it('creates a room and moves a session into it in one op', async () => {
    const res = await call('POST', '/rooms/ops', PHONE, { type: 'create', name: 'Fresh', sessionId: 'shared' });
    expect(res.status).toBe(202);
    expect(h.sent[0].msg.op).toEqual({ type: 'create', name: 'Fresh', sessionId: 'shared' });
  });

  it('refuses a malformed op', async () => {
    expect((await call('POST', '/rooms/ops', PHONE, { type: 'move', sessionId: 'shared', roomId: 'target', roomIndex: 2 })).status).toBe(400);
    expect(h.sent).toEqual([]);
  });

  it('answers 409 no-writer when no device owns the rooms, or its socket is gone', async () => {
    h.owner.id = null;
    let res = await call('POST', '/rooms/ops', PHONE, { type: 'delete', roomId: 'empty' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('no-writer');
    h.owner.id = 'mac';
    h.owner.delivered = 0;
    res = await call('POST', '/rooms/ops', PHONE, { type: 'delete', roomId: 'empty' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('no-writer');
  });

  it('a remote device moves only sessions it can see: a hidden or unknown one is 404, the same answer', async () => {
    for (const sessionId of ['hidden', 'term-hidden', 'no-such-session']) {
      const res = await call('POST', '/rooms/ops', PHONE, { type: 'move', sessionId, roomId: 'empty' });
      expect(res.status, sessionId).toBe(404);
      expect(res.json.error, sessionId).toBe('Session not found');
    }
    const create = await call('POST', '/rooms/ops', PHONE, { type: 'create', name: 'Mine', sessionId: 'hidden' });
    expect(create.status).toBe(404);
    expect(h.sent).toEqual([]);
  });

  it('a remote device acts only on rooms it can see', async () => {
    for (const op of [
      { type: 'rename', roomId: 'secret', name: 'x' },
      { type: 'color', roomId: 'secret', color: null },
      { type: 'delete', roomId: 'secret' },
      { type: 'move', sessionId: 'shared', roomId: 'secret' },
      { type: 'rename', roomId: 'no-such-room', name: 'x' },
    ]) {
      const res = await call('POST', '/rooms/ops', PHONE, op);
      expect(res.status, JSON.stringify(op)).toBe(404);
      expect(res.json.error).toBe('Room not found');
    }
    expect(h.sent).toEqual([]);
  });

  it('a remote device may not delete a room that holds sessions hidden from it', async () => {
    const res = await call('POST', '/rooms/ops', PHONE, { type: 'delete', roomId: 'mixed' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('room-has-hidden-sessions');
    expect(h.sent).toEqual([]);
    // It may still rename it: the name is what it can see.
    expect((await call('POST', '/rooms/ops', PHONE, { type: 'rename', roomId: 'mixed', name: 'y' })).status).toBe(202);
  });

  it('this machine may act on any room, hidden sessions or not', async () => {
    expect((await call('POST', '/rooms/ops', LAN_TAB, { type: 'delete', roomId: 'secret' })).status).toBe(202);
    expect((await call('POST', '/rooms/ops', LAN_TAB, { type: 'move', sessionId: 'hidden', roomId: 'empty' })).status).toBe(202);
    expect((await call('POST', '/rooms/ops', LAN_TAB, { type: 'rename', roomId: 'no-such-room', name: 'x' })).status).toBe(404);
  });

  it('an anonymous remote caller can not change rooms', async () => {
    const res = await call('POST', '/rooms/ops', { 'X-Test-Remote': '1' }, { type: 'delete', roomId: 'empty' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('missing-client-id');
  });

  it('is rate limited per device', async () => {
    for (let i = 0; i < ROOM_OPS_PER_WINDOW; i++) {
      expect((await call('POST', '/rooms/ops', PHONE, { type: 'rename', roomId: 'empty', name: `n${i}` })).status).toBe(202);
    }
    const res = await call('POST', '/rooms/ops', PHONE, { type: 'rename', roomId: 'empty', name: 'one more' });
    expect(res.status).toBe(429);
    // Another device is not held up by it.
    expect((await call('POST', '/rooms/ops', LAN_TAB, { type: 'rename', roomId: 'empty', name: 'x' })).status).toBe(202);
  });
});
