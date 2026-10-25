// test/mcp/activityBroadcast.test.ts — the `mcp_activity` and `mcp_task_update` feeds through the REAL socket
// manager: this Mac's windows get every new row of a central's activity log and every change of a task, a remote
// device and a paired phone get nothing, and nothing on the wire holds a token.
//
// The router is wired the way server/index.ts wires it (`broadcastByLocality` handed over as it is), to the real
// wsManager, with fake sockets standing in for the browsers, over a real ledger and a real activity log
// (in-memory SQLite). No PTY is ever spawned and the AASC server is not started.
import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { createCentralsRouter, type CentralsRouter } from '../../server/mcp/http.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { makeCentral } from './toolHarness.js';

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
let t: ReturnType<typeof testDeliver>;
let mac: FakeSocket;
let macPopout: FakeSocket;
let remoteBrowser: FakeSocket;
let phone: FakeSocket;

beforeEach(() => {
  registry = createCentralRegistry();
  t = testDeliver();
  router = createCentralsRouter({
    registry,
    sessions: () => [],
    broadcastByLocality: ws.broadcastByLocality,
    deliver: t.deliver,
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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const logRow = (over: Partial<Parameters<typeof t.activity.logActivity>[0]> = {}) =>
  t.activity.logActivity({
    centralId: 'central-1',
    tool: 'prompt_send',
    risk: 'steers',
    targetSessionId: 'w1',
    summary: 'Sent a prompt to 1 session',
    outcome: 'ok',
    ...over,
  });

function startTask(id = 'w1'): void {
  t.ledger.create({ central: makeCentral(), session: t.ledgerDeps.worker(id), task: 'fix the flaky queue test' });
}

describe('mcp_activity through the socket manager', () => {
  it('reaches every window of this Mac, and no remote device or phone', () => {
    const row = logRow({ summary: 'Sent a prompt to 2 sessions' });

    for (const local of [mac, macPopout]) {
      expect(local.received('mcp_activity')).toEqual([{ type: 'mcp_activity', row }]);
    }
    for (const remote of [remoteBrowser, phone]) {
      expect(remote.sent).toEqual([]);
      expect(remote.raw).toEqual([]);
    }
  });

  it('carries a refusal like any other row', () => {
    logRow({ outcome: 'refused', summary: 'Refused: that session is hands-off', detail: { code: 'HANDS_OFF' } });

    expect(mac.received('mcp_activity')).toHaveLength(1);
    expect(mac.received('mcp_activity')[0]).toMatchObject({
      row: { outcome: 'refused', detail: { code: 'HANDS_OFF' } },
    });
  });

  it('keeps reaching only this Mac across a run of rows', () => {
    for (let i = 0; i < 5; i += 1) logRow({ summary: `row ${i}` });

    expect(mac.received('mcp_activity')).toHaveLength(5);
    expect(remoteBrowser.sent).toEqual([]);
    expect(phone.sent).toEqual([]);
  });

  it('never puts a token on the wire, in a row’s text or beside it', () => {
    const a = registry.mint(globalInput());
    const b = registry.mint(roomInput('room-1'));
    logRow({
      centralId: a.centralId,
      summary: `Sent it with Bearer ${a.token}`,
      detail: { echoed: `token ${b.token}` },
    });

    const wire = [...mac.raw, ...macPopout.raw].join('\n');
    expect(wire).toContain('mcp_activity');
    for (const record of registry.list()) expect(wire).not.toContain(record.token);
    // The log blanks a token to `aasc_mcp_[redacted]`: the prefix may stay, never what follows it.
    expect(wire).toContain('aasc_mcp_[redacted]');
    expect(wire).not.toMatch(/aasc_mcp_(?!\[redacted\])/);
    expect(wire).not.toMatch(/"token"/);
  });

  it('is not replayed to a window that connects later (it reads the log over HTTP instead)', () => {
    logRow();
    const late = connect({ clientId: 'late-mac', address: '127.0.0.1', isLocal: true });

    expect(late.received('mcp_activity')).toEqual([]);
  });
});

describe('mcp_task_update through the socket manager', () => {
  it('reaches every window of this Mac, and no remote device or phone', async () => {
    startTask();
    await settle();

    for (const local of [mac, macPopout]) {
      const updates = local.received('mcp_task_update');
      expect(updates.length).toBeGreaterThanOrEqual(1);
      expect(updates[0]).toMatchObject({ task: { taskId: 'T1', sessionId: 'w1', state: 'queued' } });
    }
    for (const remote of [remoteBrowser, phone]) {
      expect(remote.received('mcp_task_update')).toEqual([]);
      expect(remote.received('mcp_activity')).toEqual([]);
      expect(remote.raw).toEqual([]);
    }
  });

  it('follows a task to its end, on this Mac only', async () => {
    startTask();
    await settle();
    t.ledgerDeps.exit('term-w1');

    const states = mac.received('mcp_task_update').map((m) => (m.task as { state: string }).state);
    expect(states[states.length - 1]).toBe('failed');
    expect(remoteBrowser.sent).toEqual([]);
    expect(phone.sent).toEqual([]);
  });

  it('never puts a token, a terminal id, a prompt key or an answer on the wire', async () => {
    const record = registry.mint(globalInput());
    startTask();
    await settle();

    const wire = [...mac.raw, ...macPopout.raw].join('\n');
    expect(wire).toContain('mcp_task_update');
    expect(wire).not.toContain(record.token);
    expect(wire).not.toContain('aasc_mcp_');
    expect(wire).not.toContain('term-w1');
    expect(wire).not.toContain('mcp-');
    expect(wire).not.toMatch(/"token"|promptKey|terminalId|"answer"/);
  });
});
