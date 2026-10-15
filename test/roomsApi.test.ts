// test/roomsApi.test.ts — AASC-20: the room list through the real API router and the real socket manager.
//
// The Mac's main window (a local socket, the workspace writer) pushes its rooms; a phone (a remote socket of
// a paired device) reads its cut and asks for changes, which reach the Mac's socket and no other. The cut a
// remote device gets never names a session hidden from it, on the GET, on a broadcast, or after a session's
// sharing changes.
//
// A remote request is a loopback request with a forwarding header (AASC-13 treats that as remote). No PTY
// is ever spawned: createTerminal throws, and nothing here kills anything.
import { EventEmitter } from 'node:events';
import express from 'express';
import { createServer, type Server } from 'http';
import { describe, it, beforeAll, afterAll, beforeEach, afterEach, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async () => { throw new Error('a test must never spawn a PTY'); }),
    closeTerminal: vi.fn(),
  };
});

/** A WebSocket as far as wsManager can tell: it records what it was sent. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw) as Record<string, unknown>); });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  received(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

let ws: typeof import('../server/wsManager.js');
let store: typeof import('../server/sessionStore.js');
let presence: typeof import('../server/presenceManager.js');
let server: Server;
let base = '';
let phoneToken = '';
let phoneLineage = '';

const room = (id: string, sessionIds: string[]) => ({ id, name: `Room ${id}`, sessionIds, collapsed: false, createdAt: 1, roomIndex: 0 });
const MAC_ROOMS = [room('mixed', ['ra-shared', 'ra-hidden']), room('secret', ['ra-hidden']), room('empty', [])];

const sockets: FakeSocket[] = [];
function connect(identity: { clientId: string; address: string; isLocal: boolean; lineage?: string; deviceId?: string }): FakeSocket {
  const socket = new FakeSocket();
  ws.handleConnection(socket as never, { label: identity.clientId, ...identity });
  sockets.push(socket);
  for (const s of sockets) s.sent.length = 0;
  return socket;
}

const MAC_HEADERS = { 'X-AASC-Client-Id': 'mac' };
const phoneHeaders = () => ({ 'X-Forwarded-For': '192.168.1.80', 'X-AASC-Client-Id': 'phone-r', Authorization: `Bearer ${phoneToken}` });

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

beforeAll(async () => {
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
  presence = await import('../server/presenceManager.js');
  const auth = await import('../server/authManager.js');
  phoneToken = auth.createToken('dev-rooms-phone');
  phoneLineage = auth.getTokenLineage(phoneToken) ?? '';
  await store.createTerminalSession('ra-shared', { host: 'localhost', workingDir: '/tmp/rooms-api/s', command: 'claude' });
  await store.createTerminalSession('ra-hidden', { host: 'localhost', workingDir: '/tmp/rooms-api/h', command: 'claude' });
  store.setSessionRemoteVisible('ra-shared', true);

  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let mac: FakeSocket;
let phone: FakeSocket;
let otherMacBrowser: FakeSocket;

beforeEach(async () => {
  store.setSessionRemoteVisible('ra-hidden', false);
  mac = connect({ clientId: 'mac', address: '127.0.0.1', isLocal: true });
  otherMacBrowser = connect({ clientId: 'mac-chrome', address: '127.0.0.1', isLocal: true });
  phone = connect({ clientId: 'phone-r', address: '192.168.1.80', isLocal: false, lineage: phoneLineage, deviceId: 'dev-rooms-phone' });
  expect(presence.getWorkspaceWriter()).toBe('mac');
  // The Mac pushes its rooms; a different list each test so the push always broadcasts.
  const res = await call('PUT', '/rooms', MAC_HEADERS, { rooms: [...MAC_ROOMS, room(`run-${Math.random()}`, [])] });
  expect(res.status).toBe(200);
  await vi.waitFor(() => expect(phone.received('rooms_update')).toHaveLength(1));
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.emit('close');
});

const ids = (rooms: unknown) => (rooms as Array<{ id: string; sessionIds: string[] }>)
  .filter((r) => !r.id.startsWith('run-'))
  .map((r) => [r.id, r.sessionIds]);

describe('the Mac pushes its rooms', () => {
  it('broadcasts the whole list to this machine and a cut without hidden sessions to the phone', () => {
    const local = mac.received('rooms_update')[0];
    const remote = phone.received('rooms_update')[0];
    expect(ids(local.rooms)).toEqual([['mixed', ['ra-shared', 'ra-hidden']], ['secret', ['ra-hidden']], ['empty', []]]);
    expect(ids(remote.rooms)).toEqual([['mixed', ['ra-shared']], ['empty', []]]);
    expect(remote.revision).toBe(local.revision);
    expect(JSON.stringify(phone.sent)).not.toContain('ra-hidden');
    expect(JSON.stringify(phone.sent)).not.toContain('Room secret');
  });

  it('only the workspace writer may set the list', async () => {
    const fromBrowser = await call('PUT', '/rooms', { 'X-AASC-Client-Id': 'mac-chrome' }, { rooms: [] });
    expect(fromBrowser.status).toBe(409);
    expect(fromBrowser.json.error).toBe('not-workspace-writer');
  });

  it('the phone reads its cut with GET', async () => {
    const res = await call('GET', '/rooms', phoneHeaders());
    expect(res.status).toBe(200);
    expect(ids(res.json.rooms)).toEqual([['mixed', ['ra-shared']], ['empty', []]]);
    const local = await call('GET', '/rooms', MAC_HEADERS);
    expect(ids(local.json.rooms)).toEqual([['mixed', ['ra-shared', 'ra-hidden']], ['secret', ['ra-hidden']], ['empty', []]]);
  });
});

describe('a room change from the phone', () => {
  it('reaches the Mac\'s socket and no other', async () => {
    const res = await call('POST', '/rooms/ops', phoneHeaders(), { type: 'move', sessionId: 'ra-shared', roomId: 'empty' });
    expect(res.status).toBe(202);
    const ops = mac.received('room_op');
    expect(ops).toEqual([{ type: 'room_op', opId: res.json.opId, op: { type: 'move', sessionId: 'ra-shared', roomId: 'empty' } }]);
    expect(otherMacBrowser.received('room_op')).toEqual([]);
    expect(phone.received('room_op')).toEqual([]);
  });

  it('can not move a hidden session, nor delete a room that holds one', async () => {
    const move = await call('POST', '/rooms/ops', phoneHeaders(), { type: 'move', sessionId: 'ra-hidden', roomId: 'empty' });
    expect(move.status).toBe(404);
    const del = await call('POST', '/rooms/ops', phoneHeaders(), { type: 'delete', roomId: 'mixed' });
    expect(del.status).toBe(409);
    expect(mac.received('room_op')).toEqual([]);
  });

  it('is refused with no-writer when only phones are left to apply it', async () => {
    mac.emit('close');
    otherMacBrowser.emit('close');
    // The phone is now the workspace writer, but a paired phone can't set the list, so nobody can apply it.
    expect(presence.getWorkspaceWriter()).toBe('phone-r');
    const res = await call('POST', '/rooms/ops', phoneHeaders(), { type: 'rename', roomId: 'empty', name: 'x' });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('no-writer');
  });
});

describe('sharing a session changes what the phone sees at once', () => {
  it('re-broadcasts the phone\'s cut when a session is shared, and again when it is hidden', async () => {
    phone.sent.length = 0;
    expect((await call('PUT', '/sessions/ra-hidden/remote-visible', MAC_HEADERS, { remoteVisible: true })).status).toBe(200);
    await vi.waitFor(() => expect(phone.received('rooms_update')).toHaveLength(1));
    expect(ids(phone.received('rooms_update')[0].rooms)).toEqual([['mixed', ['ra-shared', 'ra-hidden']], ['secret', ['ra-hidden']], ['empty', []]]);

    phone.sent.length = 0;
    expect((await call('PUT', '/sessions/ra-hidden/remote-visible', MAC_HEADERS, { remoteVisible: false })).status).toBe(200);
    await vi.waitFor(() => expect(phone.received('rooms_update')).toHaveLength(1));
    expect(ids(phone.received('rooms_update')[0].rooms)).toEqual([['mixed', ['ra-shared']], ['empty', []]]);
  });
});

describe('wsManager helpers', () => {
  it('sendToClientId reaches every socket of that device and reports how many', () => {
    const popout = connect({ clientId: 'mac', address: '127.0.0.1', isLocal: true });
    expect(ws.sendToClientId('mac', { type: 'room_op', opId: 'x', op: { type: 'delete', roomId: 'empty' } })).toBe(2);
    expect(mac.received('room_op')).toHaveLength(1);
    expect(popout.received('room_op')).toHaveLength(1);
    expect(phone.received('room_op')).toHaveLength(0);
    expect(ws.sendToClientId('nobody', { type: 'room_op' })).toBe(0);
  });

  it('isPairedPhoneClient knows a paired phone\'s socket from a browser\'s', () => {
    expect(ws.isPairedPhoneClient('phone-r')).toBe(true);
    expect(ws.isPairedPhoneClient('mac')).toBe(false);
    expect(ws.isPairedPhoneClient('nobody')).toBe(false);
  });

  it('broadcastByLocality sends each side its own payload, and none to a side given null', () => {
    for (const s of sockets) s.sent.length = 0; // the push in beforeEach
    ws.broadcastByLocality({ type: 'rooms_update', side: 'local' }, null);
    expect(mac.received('rooms_update')).toEqual([{ type: 'rooms_update', side: 'local' }]);
    expect(phone.received('rooms_update')).toEqual([]);
    ws.broadcastByLocality(null, { type: 'rooms_update', side: 'remote' });
    expect(phone.received('rooms_update')).toEqual([{ type: 'rooms_update', side: 'remote' }]);
    expect(mac.received('rooms_update')).toHaveLength(1);
  });
});
