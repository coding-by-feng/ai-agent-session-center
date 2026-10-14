// test/remoteSessionLeaks.test.ts — AASC-27: the remaining paths by which a remote device reached hidden
// sessions: live-connection replay, terminals that stayed subscribed after un-sharing, anonymous remote
// sockets typing, borrowing the desktop's device id, and hidden sessions' ids in the baton list.
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const pty = vi.hoisted(() => ({
  owner: new Map<string, string>([['t-shared', 'leak-shared'], ['t-hidden', 'leak-hidden']]),
  write: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    setWsClient: (id: string) => pty.owner.has(id),
    removeWsClient: pty.remove,
    writeToTerminal: pty.write,
    getTerminalSessionId: (id: string) => pty.owner.get(id) ?? null,
  };
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw) as Record<string, unknown>); });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  say(msg: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  of(type: string): Array<Record<string, unknown>> { return this.sent.filter((m) => m.type === type); }
}

let auth: typeof import('../server/authManager.js');
let ws: typeof import('../server/wsManager.js');
let store: typeof import('../server/sessionStore.js');
let presence: typeof import('../server/presenceManager.js');
let WS_TYPES: typeof import('../server/constants.js').WS_TYPES;
const sockets: FakeSocket[] = [];
let n = 0;

/** A remote socket is signed in; `token` picks its sign-in (a fresh one by default). */
function connect(isLocal: boolean, clientId: string | null = `leak-${n++}`, token?: string): FakeSocket {
  const socket = new FakeSocket();
  const lineage = isLocal ? null : auth.getTokenLineage(token ?? auth.createToken());
  ws.handleConnection(socket as never, {
    clientId: clientId ?? '', label: isLocal ? 'Desktop' : 'Phone', address: isLocal ? '127.0.0.1' : '192.168.1.50', isLocal, lineage,
  });
  sockets.push(socket);
  socket.sent.length = 0;
  return socket;
}

beforeAll(async () => {
  auth = await import('../server/authManager.js');
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
  presence = await import('../server/presenceManager.js');
  ({ WS_TYPES } = await import('../server/constants.js'));
  await store.createTerminalSession('leak-shared', { host: 'localhost', workingDir: '/tmp/leak/s', command: 'claude' });
  await store.createTerminalSession('leak-hidden', { host: 'localhost', workingDir: '/tmp/leak/h', command: 'claude' });
});

beforeEach(() => {
  store.setSessionRemoteVisible('leak-shared', true);
  store.setSessionRemoteVisible('leak-hidden', false);
  pty.write.mockClear();
  pty.remove.mockClear();
});

afterEach(() => {
  for (const s of sockets.splice(0)) s.emit('close');
});

describe('replay', () => {
  it('returns a remote device only the events of sessions it can see; the desktop gets everything', () => {
    const since = store.getEventSeq();
    store.pushEvent(WS_TYPES.SESSION_UPDATE, { session: store.getSession('leak-hidden') });
    store.pushEvent(WS_TYPES.SESSION_UPDATE, { session: store.getSession('leak-shared') });
    const remote = connect(false);
    const local = connect(true);
    remote.say({ type: 'replay', sinceSeq: since });
    local.say({ type: 'replay', sinceSeq: since });
    // Only session events count (connecting the second socket also broadcasts presence).
    const ids = (s: FakeSocket) => s.sent.filter((m) => m.session).map((m) => (m.session as { sessionId: string }).sessionId);
    expect(ids(remote)).toEqual(['leak-shared']);
    expect(ids(local)).toEqual(['leak-hidden', 'leak-shared']);
  });

  it('doesn’t replay a session’s old events once it has been hidden', () => {
    const since = store.getEventSeq();
    store.pushEvent(WS_TYPES.SESSION_UPDATE, { session: store.getSession('leak-shared') }); // recorded while shared
    store.setSessionRemoteVisible('leak-shared', false);
    const remote = connect(false);
    remote.say({ type: 'replay', sinceSeq: since });
    expect(remote.sent).toHaveLength(0);
  });
});

describe('un-sharing a session', () => {
  it('cuts remote watchers off at once and removes the card; the desktop keeps watching', () => {
    const remote = connect(false);
    const local = connect(true);
    remote.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    local.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    store.setSessionRemoteVisible('leak-shared', false);
    expect(ws.revokeRemoteSessionAccess('leak-shared')).toBe(1);
    expect(pty.remove).toHaveBeenCalledTimes(1);
    expect(remote.of(WS_TYPES.TERMINAL_CLOSED)).toEqual([{ type: WS_TYPES.TERMINAL_CLOSED, terminalId: 't-shared', reason: 'hidden' }]);
    expect(remote.of(WS_TYPES.SESSION_REMOVED)).toEqual([{ type: WS_TYPES.SESSION_REMOVED, sessionId: 'leak-shared' }]);
    expect(local.of(WS_TYPES.TERMINAL_CLOSED)).toHaveLength(0);
  });

  it('re-checks on every keystroke, even before the cut-off runs', () => {
    const remote = connect(false);
    remote.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    store.setSessionRemoteVisible('leak-shared', false);
    remote.say({ type: 'terminal_input', terminalId: 't-shared', data: 'rm -rf ~\r' });
    expect(pty.write).not.toHaveBeenCalled();
  });
});

describe('who may type', () => {
  it('a remote socket without a device id can watch but never type', () => {
    const anonymous = connect(false, null);
    anonymous.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    anonymous.say({ type: 'terminal_input', terminalId: 't-shared', data: 'ls\r' });
    expect(pty.write).not.toHaveBeenCalled();
  });

  it('an anonymous local socket still types, as before', () => {
    const local = connect(true, null);
    local.say({ type: 'terminal_subscribe', terminalId: 't-hidden' });
    local.say({ type: 'terminal_input', terminalId: 't-hidden', data: 'ls\r' });
    expect(pty.write).toHaveBeenCalledWith('t-hidden', 'ls\r');
  });

  it('a remote socket can’t borrow the desktop’s id: it connects anonymously and the desktop stays local', () => {
    connect(true, 'desk-borrowed');
    const impostor = connect(false, 'desk-borrowed');
    expect(presence.getDevice('desk-borrowed')?.isLocal).toBe(true);
    impostor.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    impostor.say({ type: 'terminal_input', terminalId: 't-shared', data: 'ls\r' });
    expect(pty.write).not.toHaveBeenCalled();
  });
});

describe('a device id belongs to the sign-in that first used it', () => {
  it('another remote sign-in presenting the same id connects anonymously and can’t type', () => {
    const tokenA = auth.createToken();
    const phoneA = connect(false, 'phone-owned', tokenA);
    phoneA.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    phoneA.say({ type: 'terminal_input', terminalId: 't-shared', data: 'a' });
    expect(pty.write).toHaveBeenCalledTimes(1);
    phoneA.emit('close');
    presence.releaseAllControls('phone-owned');
    const phoneB = connect(false, 'phone-owned', auth.createToken());
    phoneB.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    phoneB.say({ type: 'terminal_input', terminalId: 't-shared', data: 'b' });
    expect(pty.write).toHaveBeenCalledTimes(1);
  });

  it('survives the hourly token refresh, and passes to a new sign-in once the old one has expired', () => {
    const first = auth.createToken();
    connect(false, 'phone-refresh', first).emit('close');
    const refreshed = auth.refreshToken(first)!; // same sign-in, new token
    const again = connect(false, 'phone-refresh', refreshed);
    again.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    again.say({ type: 'terminal_input', terminalId: 't-shared', data: 'x' });
    expect(pty.write).toHaveBeenCalledTimes(1);
    again.emit('close');
    presence.releaseAllControls('phone-refresh');
    auth.removeToken(refreshed); // the old sign-in is gone (logged out / expired)
    const fresh = connect(false, 'phone-refresh', auth.createToken());
    fresh.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    fresh.say({ type: 'terminal_input', terminalId: 't-shared', data: 'y' });
    expect(pty.write).toHaveBeenCalledTimes(2);
  });
});

describe('presence', () => {
  it('a remote device doesn’t see the batons of hidden sessions', () => {
    const local = connect(true, 'desk-p');
    const remote = connect(false, 'phone-p');
    expect(presence.claimControl('leak-hidden', 'desk-p').ok).toBe(true);
    expect(presence.claimControl('leak-shared', 'desk-p').ok).toBe(true);
    ws.broadcastPresence();
    const held = (s: FakeSocket) => (s.of(WS_TYPES.PRESENCE_UPDATE).at(-1)?.controllers as Array<{ sessionId: string }>).map((c) => c.sessionId).sort();
    expect(held(remote)).toEqual(['leak-shared']);
    expect(held(local)).toEqual(['leak-hidden', 'leak-shared']);
    presence.releaseAllControls('desk-p');
  });
});

// ── HTTP: the presence routes ─────────────────────────────────────────────────────────────────────────
describe('presence routes over HTTP', () => {
  it('refuse remote control actions on hidden sessions, and a remote request using the desktop’s id', async () => {
    const express = (await import('express')).default;
    const { createServer } = await import('http');
    const { default: apiRouter } = await import('../server/apiRouter.js');
    const app = express();
    app.use(express.json());
    app.use('/api', apiRouter);
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`http://127.0.0.1:${addr.port}/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const tokenA = auth.createToken();
    const tokenB = auth.createToken();
    const REMOTE = { 'X-Forwarded-For': '192.168.1.50', Authorization: `Bearer ${tokenA}` };
    try {
      connect(true, 'desk-http');
      expect((await post('/presence/control/claim', { sessionId: 'leak-hidden' }, { ...REMOTE, 'X-AASC-Client-Id': 'phone-http' })).status).toBe(404);
      expect((await post('/presence/control/request', { sessionId: 'leak-hidden' }, { ...REMOTE, 'X-AASC-Client-Id': 'phone-http' })).status).toBe(404);
      expect((await post('/presence/control/claim', { sessionId: 'leak-shared' }, { ...REMOTE, 'X-AASC-Client-Id': 'phone-http' })).status).toBe(200);
      presence.releaseAllControls('phone-http');
      const borrowed = await post('/presence/control/claim', { sessionId: 'leak-shared' }, { ...REMOTE, 'X-AASC-Client-Id': 'desk-http' });
      expect(borrowed.status).toBe(400); // the desktop's id is not accepted from a remote device
      // Another remote sign-in can't use phone-http's id either.
      const otherSignIn = await post('/presence/control/claim', { sessionId: 'leak-shared' },
        { 'X-Forwarded-For': '192.168.1.51', Authorization: `Bearer ${tokenB}`, 'X-AASC-Client-Id': 'phone-http' });
      expect(otherSignIn.status).toBe(400);
      // The desktop itself is unaffected.
      expect((await post('/presence/control/claim', { sessionId: 'leak-hidden' }, { 'X-AASC-Client-Id': 'desk-http' })).status).toBe(200);
      presence.releaseAllControls('desk-http');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
