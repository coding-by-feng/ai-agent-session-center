// test/tunnelVisibility.test.ts — AASC-13: a WebSocket that arrives through a tunnel is a remote device.
//
// Its socket is 127.0.0.1 (the tunnel runs on this machine), so the old address-only rule put it on the
// desktop's side of the visibility boundary: every session, hidden or not, and every queue's prompt text.
// The upgrade handler now decides locality with `isLocalRequest` and passes it as `identity.isLocal`.
import { EventEmitter } from 'node:events';
import { describe, it, beforeAll, afterEach, expect, vi } from 'vitest';

// sessionStore/wsManager open better-sqlite3 at module scope via db.ts; stub it so the suite runs under any ABI.
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

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

let auth: typeof import('../server/authManager.js');
let ws: typeof import('../server/wsManager.js');
let store: typeof import('../server/sessionStore.js');
let presence: typeof import('../server/presenceManager.js');
let WS_TYPES: typeof import('../server/constants.js').WS_TYPES;
const connected: FakeSocket[] = [];
let nextClient = 0;

function connect(identity: { address: string; isLocal?: boolean }): { socket: FakeSocket; clientId: string } {
  const socket = new FakeSocket();
  const clientId = `tunnel-device-${nextClient++}`;
  // A remote socket is always signed in, and its device id is tied to that sign-in (AASC-27).
  const lineage = identity.isLocal ? null : auth.getTokenLineage(auth.createToken());
  ws.handleConnection(socket as never, { clientId, label: 'test device', lineage, ...identity });
  connected.push(socket);
  return { socket, clientId };
}

const SECRET = 'prompt text of a session nobody shared';
const queueUpdate = (sessionId: string) => ({
  type: WS_TYPES.QUEUE_UPDATE,
  sessionId,
  items: [{ id: 1, sessionId, text: SECRET, position: 0, createdAt: 1 }],
  automation: null,
  updatedAt: 1,
  originClientId: 'someone-else',
});

beforeAll(async () => {
  auth = await import('../server/authManager.js');
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
  presence = await import('../server/presenceManager.js');
  ({ WS_TYPES } = await import('../server/constants.js'));
  await store.createTerminalSession('tv-private', { host: 'localhost', workingDir: '/tmp/tunnel-visibility/p', command: 'claude' });
  await store.createTerminalSession('tv-shared', { host: 'localhost', workingDir: '/tmp/tunnel-visibility/s', command: 'claude' });
  store.setSessionRemoteVisible('tv-shared', true);
});

afterEach(() => {
  for (const socket of connected.splice(0)) socket.emit('close');
});

describe('a tunnelled WebSocket (127.0.0.1, isLocal: false)', () => {
  it('never receives a hidden session’s queue', () => {
    const { socket } = connect({ address: '127.0.0.1', isLocal: false });
    socket.sent.length = 0;
    ws.broadcast(queueUpdate('tv-private'));
    expect(socket.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(0);
    expect(JSON.stringify(socket.sent)).not.toContain(SECRET);
  });

  it('still receives a shared session’s queue', () => {
    const { socket } = connect({ address: '127.0.0.1', isLocal: false });
    socket.sent.length = 0;
    ws.broadcast(queueUpdate('tv-shared'));
    expect(socket.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
  });

  it('is listed as a remote device in presence', () => {
    const { clientId } = connect({ address: '127.0.0.1', isLocal: false });
    expect(presence.getDevice(clientId)?.isLocal).toBe(false);
  });
});

describe('the desktop app (127.0.0.1, isLocal: true)', () => {
  it('keeps seeing hidden sessions and is listed as local', () => {
    const { socket, clientId } = connect({ address: '127.0.0.1', isLocal: true });
    socket.sent.length = 0;
    ws.broadcast(queueUpdate('tv-private'));
    expect(socket.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
    expect(presence.getDevice(clientId)?.isLocal).toBe(true);
  });
});
