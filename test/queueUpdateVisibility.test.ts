// test/queueUpdateVisibility.test.ts — `queue_update` must obey the same visibility rule as every other
// path that carries a session. A queue is made of PROMPT TEXT, so it is the most sensitive thing a session
// owns, and the message that fans a queue out names its session only by id: `broadcastSubject` looked for a
// `session` object (which `session_update` carries and `queue_update` does not), found none, and sent the
// message to every client. Editing a hidden session's queue on the desktop therefore pushed its prompts to
// every remote device on every change — while `GET /api/queues` and `/sessions/:id/queue` were already
// filtering, so the leak sat on the one path nobody had to remember.
import { EventEmitter } from 'node:events';
import { describe, it, beforeAll, afterEach, expect, vi } from 'vitest';

// sessionStore/wsManager open better-sqlite3 at module scope via db.ts. Stub it so this suite runs under
// any Node ABI — otherwise the file fails at import and silently covers nothing.
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
let WS_TYPES: typeof import('../server/constants.js').WS_TYPES;

const connected: FakeSocket[] = [];
let nextClient = 0;

/**
 * Connect a client from `address` and forget the snapshot / presence traffic of connecting — its own and, for
 * the clients already connected, the presence update that announces the newcomer.
 */
function connect(address: string): FakeSocket {
  const socket = new FakeSocket();
  ws.handleConnection(socket as never, { clientId: `device-${nextClient++}`, label: 'test device', address });
  connected.push(socket);
  for (const c of connected) c.sent.length = 0;
  return socket;
}

const queueUpdate = (sessionId: string) => ({
  type: WS_TYPES.QUEUE_UPDATE,
  sessionId,
  items: [{ id: 1, sessionId, text: 'a prompt only the owner should read', position: 0, createdAt: 1 }],
  automation: null,
  updatedAt: 1,
  originClientId: 'someone-else',
});

async function newSession(id: string, remoteVisible?: boolean): Promise<void> {
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/queue-visibility/${id}`, command: 'claude' });
  if (remoteVisible !== undefined) store.setSessionRemoteVisible(id, remoteVisible);
}

const LOCAL = '127.0.0.1';
const REMOTE = '192.168.1.50';

beforeAll(async () => {
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
  ({ WS_TYPES } = await import('../server/constants.js'));
  await newSession('qv-shared', true);
  await newSession('qv-private'); // never opted in: the default
  await newSession('qv-explicitly-hidden', false);
});

afterEach(() => {
  // Closing detaches the client and, with the last one gone, stops the heartbeat timer.
  for (const socket of connected.splice(0)) socket.emit('close');
});

describe('queue_update', () => {
  it('reaches a remote device for a session that has been shared with it', () => {
    const remote = connect(REMOTE);
    ws.broadcast(queueUpdate('qv-shared'));
    expect(remote.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
  });

  it.each(['qv-private', 'qv-explicitly-hidden'])(
    'never reaches a remote device for %s, a session hidden from it',
    (sessionId) => {
      const remote = connect(REMOTE);
      ws.broadcast(queueUpdate(sessionId));
      expect(remote.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(0);
      // Not the prompt text in some other message either.
      expect(JSON.stringify(remote.sent)).not.toContain('a prompt only the owner should read');
    },
  );

  it('still reaches the local desktop for a hidden session — the rule is "remote devices only"', () => {
    const local = connect(LOCAL);
    ws.broadcast(queueUpdate('qv-private'));
    expect(local.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
  });

  it('fails CLOSED for a session the server cannot resolve', () => {
    // A removed or archived session has no live record to carry the opt-in, and an id the server has never
    // heard of must not be a way to tell "no such session" from "hidden from you".
    const remote = connect(REMOTE);
    const local = connect(LOCAL);
    ws.broadcast(queueUpdate('qv-does-not-exist'));
    expect(remote.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(0);
    expect(local.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
  });

  it('follows a session alias, as the REST routes do', () => {
    // A queue pushed under an id the session has since been re-keyed away from resolves to the live session.
    store.registerSessionAlias('qv-shared-old-id', 'qv-shared');
    store.registerSessionAlias('qv-private-old-id', 'qv-private');
    const remote = connect(REMOTE);

    ws.broadcast(queueUpdate('qv-shared-old-id'));
    ws.broadcast(queueUpdate('qv-private-old-id'));

    expect(remote.received(WS_TYPES.QUEUE_UPDATE).map((m) => m.sessionId)).toEqual(['qv-shared-old-id']);
  });

  it('is decided per client: one broadcast, one device that may see it and one that may not', () => {
    const remote = connect(REMOTE);
    const local = connect(LOCAL);
    ws.broadcast(queueUpdate('qv-private'));
    expect(local.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(1);
    expect(remote.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(0);
  });

  it('a message without a usable session id is not sent to a remote device either', () => {
    const remote = connect(REMOTE);
    ws.broadcast({ type: WS_TYPES.QUEUE_UPDATE, items: [], automation: null, updatedAt: 1, originClientId: null });
    ws.broadcast({ type: WS_TYPES.QUEUE_UPDATE, sessionId: 42, items: [], automation: null, updatedAt: 1, originClientId: null });
    expect(remote.received(WS_TYPES.QUEUE_UPDATE)).toHaveLength(0);
  });
});

describe('the paths this fix shares code with', () => {
  it('a session_update for a hidden session still stays off a remote device', () => {
    const remote = connect(REMOTE);
    const session = store.getSession('qv-private');
    ws.broadcast({ type: WS_TYPES.SESSION_UPDATE, session });
    expect(remote.received(WS_TYPES.SESSION_UPDATE)).toHaveLength(0);
  });

  it('a message that is not about one session (presence) still reaches everyone', () => {
    const remote = connect(REMOTE);
    const local = connect(LOCAL);
    ws.broadcast({ type: WS_TYPES.PRESENCE_UPDATE, devices: [] });
    expect(remote.received(WS_TYPES.PRESENCE_UPDATE)).toHaveLength(1);
    expect(local.received(WS_TYPES.PRESENCE_UPDATE)).toHaveLength(1);
  });
});
