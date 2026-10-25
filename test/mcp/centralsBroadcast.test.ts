// test/mcp/centralsBroadcast.test.ts — the `centrals_update` feed through the REAL socket manager: this
// Mac's window gets the list, a remote device and a paired phone get nothing, and the list carries no token.
//
// The router is wired the way server/index.ts wires it (`broadcastByLocality` handed over as it is), to
// the real wsManager, with fake sockets standing in for the browsers. No PTY is ever spawned and the
// AASC server is not started.
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { createCentralsRouter, type CentralsRouter } from '../../server/mcp/http.js';
import { globalInput, projectInput, roomInput } from './centralFixtures.js';

// What wsManager's import graph needs of the database, as test/roomsApi.test.ts does it: nothing real.
vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));
vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** A WebSocket as far as wsManager can tell: it records what it was sent. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  raw: string[] = [];
  send = vi.fn((raw: string) => {
    this.raw.push(raw);
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  received(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
}

let ws: typeof import('../../server/wsManager.js');

const sockets: FakeSocket[] = [];
function connect(identity: { clientId: string; address: string; isLocal: boolean; deviceId?: string }): FakeSocket {
  const socket = new FakeSocket();
  ws.handleConnection(socket as never, { label: identity.clientId, ...identity });
  sockets.push(socket);
  // What the connection itself sends (snapshot, presence) is not what these tests look at.
  for (const s of sockets) {
    s.sent.length = 0;
    s.raw.length = 0;
  }
  return socket;
}

beforeAll(async () => {
  ws = await import('../../server/wsManager.js');
});

let registry: CentralRegistry;
let router: CentralsRouter;
let mac: FakeSocket;
let macPopout: FakeSocket;
let remoteBrowser: FakeSocket;
let phone: FakeSocket;

beforeEach(() => {
  registry = createCentralRegistry();
  router = createCentralsRouter({
    registry,
    sessions: () => [],
    broadcastByLocality: ws.broadcastByLocality,
  });
  mac = connect({ clientId: 'mac', address: '127.0.0.1', isLocal: true });
  macPopout = connect({ clientId: 'mac', address: '127.0.0.1', isLocal: true });
  remoteBrowser = connect({ clientId: 'laptop', address: '192.168.1.40', isLocal: false });
  phone = connect({ clientId: 'phone', address: '192.168.1.80', isLocal: false, deviceId: 'dev-phone' });
});

afterEach(() => {
  router.close();
  for (const s of sockets.splice(0)) s.emit('close');
});

describe('centrals_update through the socket manager', () => {
  it('reaches every window of this Mac, and no remote device or phone', () => {
    const record = registry.mint(globalInput());

    for (const local of [mac, macPopout]) {
      expect(local.received('centrals_update')).toHaveLength(1);
      expect(local.received('centrals_update')[0]).toMatchObject({
        type: 'centrals_update',
        centrals: [{ centralId: record.centralId, kind: 'global' }],
      });
    }
    for (const remote of [remoteBrowser, phone]) {
      expect(remote.sent).toEqual([]);
      expect(remote.raw).toEqual([]);
    }
  });

  it('keeps reaching only this Mac across every change, and a remote device hears of none', () => {
    const a = registry.mint(globalInput());
    const b = registry.mint(roomInput('room-1'));
    registry.mint(projectInput('/work/app'));
    registry.attachTerminal(a.centralId, 'term-1');
    registry.rotate(b.centralId);
    registry.revoke(a.centralId);

    expect(mac.received('centrals_update')).toHaveLength(6);
    expect(remoteBrowser.sent).toEqual([]);
    expect(phone.sent).toEqual([]);
  });

  it('never puts a token, a terminal id or a permission mode on the wire', () => {
    const a = registry.mint(globalInput({ permissionMode: 'bypassPermissions' }));
    registry.attachTerminal(a.centralId, 'term-secret-1');
    const b = registry.mint(roomInput('room-1'));
    registry.rotate(b.centralId);

    const wire = [...mac.raw, ...macPopout.raw].join('\n');
    expect(wire).toContain('centrals_update');
    for (const entry of registry.list()) expect(wire).not.toContain(entry.token);
    expect(wire).not.toContain(a.token);
    expect(wire).not.toContain('aasc_mcp_');
    expect(wire).not.toContain('term-secret-1');
    expect(wire).not.toContain('bypassPermissions');
    expect(wire).not.toMatch(/"token"/);
  });

  it('is not replayed to a window that connects later (it reads the list over HTTP instead)', () => {
    registry.mint(globalInput());
    const late = connect({ clientId: 'late-mac', address: '127.0.0.1', isLocal: true });

    expect(late.received('centrals_update')).toEqual([]);
  });
});
