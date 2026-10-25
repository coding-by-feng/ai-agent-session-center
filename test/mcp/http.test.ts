// test/mcp/http.test.ts — GET /api/mcp/centrals and the `centrals_update` feed (server/mcp/http.ts): what
// the dashboard's Central picker and badges read. The rows are built field by field and never carry a
// token; only this Mac may read them or hear of a change; the feed goes out on the local-only path.
//
// The router is mounted on a real Express app on an ephemeral port, with the real registry and the real
// `isLocalRequest`. The AASC server is never started and nothing here reaches a process.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { phoneRuleFor } from '../../server/mobile/phoneProfile.js';
import {
  centralSummaries,
  createCentralsRouter,
  type CentralsRouter,
  type CentralsRouterDeps,
  type CentralsUpdateMessage,
} from '../../server/mcp/http.js';
import { createWorkerRegistry, type WorkerRegistry } from '../../server/mcp/workers.js';
import { globalInput, makeMarker, projectInput, roomInput } from './centralFixtures.js';

// A publish that fails is logged; the logger would append to a file on disk.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

/** The public fields of a row, and nothing else. */
const ROW_FIELDS = ['centralId', 'cli', 'createdAt', 'kind', 'scopeRef', 'sessionId', 'toolsets', 'workerCount'];

type Sent = [local: CentralsUpdateMessage, remote: null];

interface Rig {
  port: number;
  registry: CentralRegistry;
  router: CentralsRouter;
  /** Every `broadcastByLocality(local, remote)` call the router made. */
  sent: Sent[];
  sessions: Session[];
  /** The sessions centrals opened themselves (P4), this rig's own and not the server's. */
  workers: WorkerRegistry;
}

let server: Server | undefined;

async function rig(over: Partial<CentralsRouterDeps> = {}): Promise<Rig> {
  const registry = createCentralRegistry({ now: () => 1_700_000_000_000 });
  const sent: Sent[] = [];
  const sessions: Session[] = [];
  const workers = createWorkerRegistry({ controller: () => null });
  const router = createCentralsRouter({
    registry,
    sessions: () => sessions,
    workers,
    // No P2 runtime is wired in this file, so the only thing the router sends is the centrals list.
    broadcastByLocality: (local, remote) => {
      sent.push([local as CentralsUpdateMessage, remote]);
    },
    ...over,
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, registry, router, sent, sessions, workers };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  log.warn.mockClear();
});

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One GET, with the headers a test chooses (`fetch` would not let it name another Host). */
function get(port: number, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/api/mcp/centrals', method: 'GET', headers },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, text, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const card = (centralId: string, over: Partial<Session> = {}): Session =>
  ({
    sessionId: `card-${centralId}`,
    status: 'idle',
    lastActivityAt: 1,
    central: makeMarker(centralId),
    ...over,
  }) as unknown as Session;

describe('GET /api/mcp/centrals', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('answers an empty list while no central runs', async () => {
    const answer = await get(r.port);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, centrals: [] });
  });

  it('lists every central with exactly the public fields', async () => {
    const global = r.registry.mint(globalInput());
    const room = r.registry.mint(roomInput('room-1', { cli: 'codex' }));
    const project = r.registry.mint(projectInput('/work/app'));

    const answer = await get(r.port);

    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    const rows = answer.body.centrals as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.centralId)).toEqual([
      global.centralId,
      room.centralId,
      project.centralId,
    ]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
    expect(rows[0]).toEqual({
      centralId: global.centralId,
      kind: 'global',
      scopeRef: null,
      cli: 'claude',
      sessionId: null,
      toolsets: global.toolsets,
      createdAt: 1_700_000_000_000,
      workerCount: 0,
    });
    expect(rows[1]).toMatchObject({ kind: 'room', scopeRef: 'room-1', cli: 'codex' });
    expect(rows[2]).toMatchObject({ kind: 'project', scopeRef: '/work/app' });
  });

  it('workerCount counts live own workers', async () => {
    const a = r.registry.mint(globalInput());
    const b = r.registry.mint(roomInput('room-1'));
    const own = (terminalId: string, centralId: string): void =>
      r.workers.add({ centralId, terminalId, openedAt: 1, folder: '/work/app', cli: 'claude' });
    own('t-1', a.centralId);
    own('t-2', a.centralId);
    own('t-3', a.centralId);
    own('t-4', b.centralId);
    r.sessions.push(
      card('w1', { sessionId: 'w1', terminalId: 't-1', central: undefined }),
      card('w2', { sessionId: 'w2', terminalId: 't-2', central: undefined }),
      // An ended card is no live worker, and a person's session is no one's.
      card('w3', { sessionId: 'w3', terminalId: 't-3', status: 'ended', central: undefined }),
      card('mine', { sessionId: 'mine', terminalId: 't-9', central: undefined }),
    );

    const rows = (await get(r.port)).body.centrals as Array<Record<string, unknown>>;

    expect(rows.find((row) => row.centralId === a.centralId)?.workerCount).toBe(2);
    // b's worker has no card yet.
    expect(rows.find((row) => row.centralId === b.centralId)?.workerCount).toBe(0);
  });

  it('names the card each central runs in, through the marker the card carries', async () => {
    const a = r.registry.mint(globalInput());
    const b = r.registry.mint(roomInput('room-1'));
    r.sessions.push(card(a.centralId, { sessionId: 'claude-uuid-a' }));
    // An ended card left beside its relaunch: the live one is the answer.
    r.sessions.push(card(b.centralId, { sessionId: 'old-b', status: 'ended' }));
    r.sessions.push(card(b.centralId, { sessionId: 'new-b', status: 'idle' }));

    const rows = (await get(r.port)).body.centrals as Array<Record<string, unknown>>;

    expect(rows.find((row) => row.centralId === a.centralId)?.sessionId).toBe('claude-uuid-a');
    expect(rows.find((row) => row.centralId === b.centralId)?.sessionId).toBe('new-b');
  });

  it('never carries a token: not in the text, not as a field, and no terminal id or mode either', async () => {
    const record = r.registry.mint(globalInput({ permissionMode: 'bypassPermissions' }));
    r.registry.attachTerminal(record.centralId, 'term-secret-1');
    const other = r.registry.mint(roomInput('room-9'));
    expect(record.token).toMatch(/^aasc_mcp_/);

    const answer = await get(r.port);

    expect(answer.status).toBe(200);
    for (const token of [record.token, other.token]) expect(answer.text).not.toContain(token);
    expect(answer.text).not.toContain('aasc_mcp_');
    expect(answer.text).not.toContain('term-secret-1');
    expect(answer.text).not.toContain('bypassPermissions');
    for (const row of answer.body.centrals as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('token');
      expect(row).not.toHaveProperty('terminalId');
      expect(row).not.toHaveProperty('permissionMode');
    }
  });

  it('hands out copies: a row changed by the caller changes nothing the registry holds', async () => {
    const record = r.registry.mint(globalInput());
    const before = [...record.toolsets];

    const rows = centralSummaries(r.registry, r.sessions);
    rows[0].toolsets.length = 0;

    expect(r.registry.byId(record.centralId)?.toolsets).toEqual(before);
    expect(centralSummaries(r.registry, r.sessions)[0].toolsets).toEqual(before);
  });

  describe('is for this Mac only', () => {
    beforeEach(() => {
      r.registry.mint(globalInput());
    });

    it('refuses a request relayed by a proxy (a forwarding header) with a 404 and no data', async () => {
      const answer = await get(r.port, { 'x-forwarded-for': '203.0.113.9' });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ ok: false, error: 'Not found' });
      expect(answer.text).not.toContain('centralId');
    });

    it('refuses a request that names another host (a page re-resolved to loopback)', async () => {
      const answer = await get(r.port, { host: 'attacker.example' });

      expect(answer.status).toBe(404);
      expect(answer.text).not.toContain('centralId');
    });

    it('refuses a cross-site browser request', async () => {
      const answer = await get(r.port, { 'sec-fetch-site': 'cross-site' });

      expect(answer.status).toBe(404);
    });

    it('answers a plain loopback request', async () => {
      const answer = await get(r.port);

      expect(answer.status).toBe(200);
    });
  });

  it('is not on a paired phone\'s allow-list: the phone profile (deny by default) refuses it before this router', () => {
    expect(phoneRuleFor('GET', '/mcp/centrals')).toBeNull();
  });

  describe('with an injected rule', () => {
    it('takes its answer from `isLocal`', async () => {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      let local = false;
      const custom = await rig({ isLocal: () => local });

      expect((await get(custom.port)).status).toBe(404);
      local = true;
      expect((await get(custom.port)).status).toBe(200);
    });

    it('is not served with the feature off (`mcp.enabled: false`): the picker hides', async () => {
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      let on = false;
      const custom = await rig({ enabled: () => on });

      expect((await get(custom.port)).status).toBe(404);
      on = true;
      expect((await get(custom.port)).status).toBe(200);
    });
  });
});

describe('the centrals_update feed', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('sends the whole list to this Mac\'s windows after a central starts', async () => {
    const record = r.registry.mint(globalInput());

    expect(r.sent).toHaveLength(1);
    const [local] = r.sent[0];
    expect(local?.type).toBe('centrals_update');
    expect(local?.centrals).toHaveLength(1);
    expect(local?.centrals[0]).toMatchObject({ centralId: record.centralId, kind: 'global' });
  });

  it('is local-only: the remote side of the call is always null', () => {
    r.registry.mint(globalInput());
    r.registry.mint(roomInput('room-1'));
    r.registry.revoke(r.registry.list()[0].centralId);

    expect(r.sent.length).toBeGreaterThanOrEqual(3);
    for (const [local, remote] of r.sent) {
      expect(local).not.toBeNull();
      expect(remote).toBeNull();
    }
  });

  it('carries the same rows GET answers, and no token', async () => {
    const record = r.registry.mint(globalInput());
    r.registry.mint(projectInput('/work/app'));
    r.registry.attachTerminal(record.centralId, 'term-1');
    r.sessions.push(card(record.centralId));
    r.registry.rotate(record.centralId);

    const last = r.sent[r.sent.length - 1][0];
    const answer = await get(r.port);

    expect(last?.centrals).toEqual(answer.body.centrals);
    const wire = JSON.stringify(r.sent);
    for (const entry of r.registry.list()) expect(wire).not.toContain(entry.token);
    expect(wire).not.toContain('aasc_mcp_');
    expect(wire).not.toContain('term-1');
    expect(JSON.stringify(last)).not.toMatch(/token/i);
  });

  it('follows every kind of change the registry reports', () => {
    const record = r.registry.mint(globalInput());
    const afterMint = r.sent.length;
    r.registry.attachTerminal(record.centralId, 'term-1');
    const afterAttach = r.sent.length;
    r.registry.rotate(record.centralId);
    const afterRotate = r.sent.length;
    r.registry.revoke(record.centralId);

    expect(afterMint).toBe(1);
    expect(afterAttach).toBe(2);
    expect(afterRotate).toBe(3);
    expect(r.sent).toHaveLength(4);
  });

  it('sends the empty list when the last central goes', () => {
    const record = r.registry.mint(globalInput());
    r.registry.revoke(record.centralId);

    expect(r.sent[r.sent.length - 1][0]).toEqual({ type: 'centrals_update', centrals: [] });
  });

  it('sends the list again when a central’s own workers change, with the new count (P4)', () => {
    const record = r.registry.mint(globalInput());
    r.sessions.push(card('w1', { sessionId: 'w1', terminalId: 't-1', central: undefined }));

    r.workers.add({ centralId: record.centralId, terminalId: 't-1', openedAt: 1, folder: '/work/app', cli: 'claude' });
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1][0]?.centrals[0].workerCount).toBe(1);
    expect(r.sent[1][1]).toBeNull();

    r.workers.release('t-1', 'closed');
    expect(r.sent).toHaveLength(3);
    expect(r.sent[2][0]?.centrals[0].workerCount).toBe(0);

    r.router.close();
    r.workers.add({ centralId: record.centralId, terminalId: 't-1', openedAt: 2, folder: '/work/app', cli: 'claude' });
    expect(r.sent).toHaveLength(3);
  });

  it('names the card at the moment it sends, not at the moment the central was minted', () => {
    const record = r.registry.mint(globalInput());
    expect(r.sent[0][0]?.centrals[0].sessionId).toBeNull();

    r.sessions.push(card(record.centralId, { sessionId: 'claude-uuid' }));
    r.registry.attachTerminal(record.centralId, 'term-1');

    expect(r.sent[1][0]?.centrals[0].sessionId).toBe('claude-uuid');
  });

  it('never breaks the registry when sending fails, and says so in the log', async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const failing = await rig({
      broadcastByLocality: () => {
        throw new Error('socket closed');
      },
    });

    const record = failing.registry.mint(globalInput());

    expect(failing.registry.byId(record.centralId)).not.toBeNull();
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('socket closed'));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(record.token);
  });

  it('stops after close(), once however often it is called', () => {
    r.router.close();
    r.router.close();

    r.registry.mint(globalInput());

    expect(r.sent).toHaveLength(0);
  });
});
