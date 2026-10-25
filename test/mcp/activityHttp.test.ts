// test/mcp/activityHttp.test.ts — what the dashboard reads of P2's runtime (server/mcp/http.ts): the activity log
// (GET /api/mcp/activity), the tasks in flight (GET /api/mcp/tasks) and the two feeds of change, `mcp_activity`
// and `mcp_task_update`. Rows and tasks are built field by field and never carry a token; only this Mac may read
// them or hear of a change; both feeds go out on the local-only path (`broadcastByLocality(message, null)`).
//
// The router is mounted on a real Express app on an ephemeral port, with the real `isLocalRequest`, over a real
// ledger and a real activity log (in-memory SQLite) from test/mcp/deliverFixtures.ts. The AASC server is never
// started and nothing here reaches a terminal or a process.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpActivityRow, McpTaskView } from '../../src/types/mcpEvents.js';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { phoneRuleFor } from '../../server/mobile/phoneProfile.js';
import {
  createCentralsRouter,
  type CentralsFeedMessage,
  type CentralsRouter,
  type CentralsRouterDeps,
} from '../../server/mcp/http.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { makeCentral } from './toolHarness.js';

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
const ROW_FIELDS = [
  'at',
  'centralId',
  'centralSessionId',
  'detail',
  'id',
  'outcome',
  'risk',
  'summary',
  'targetSessionId',
  'taskId',
  'tool',
];
/** The public fields of a task view, and nothing else. */
const TASK_FIELDS = [
  'answerChars',
  'answerTruncated',
  'centralId',
  'createdAt',
  'error',
  'retargetedFrom',
  'route',
  'sentAt',
  'sessionId',
  'state',
  'taskId',
  'title',
  'updatedAt',
];

type Sent = [local: CentralsFeedMessage, remote: null];

interface Rig {
  port: number;
  registry: CentralRegistry;
  router: CentralsRouter;
  t: ReturnType<typeof testDeliver>;
  /** Every `broadcastByLocality(local, remote)` call the router made. */
  sent: Sent[];
}

let server: Server | undefined;

async function rig(over: Partial<CentralsRouterDeps> = {}): Promise<Rig> {
  const registry = createCentralRegistry({ now: () => 1_700_000_000_000 });
  const t = testDeliver();
  const sent: Sent[] = [];
  const router = createCentralsRouter({
    registry,
    sessions: () => [],
    broadcastByLocality: (local, remote) => {
      sent.push([local, remote]);
    },
    deliver: t.deliver,
    ...over,
  });
  const app = express();
  app.use('/api', router);
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, registry, router, t, sent };
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
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
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
    });
    req.on('error', reject);
    req.end();
  });
}

const activity = (port: number, query = '', headers: Record<string, string> = {}) =>
  get(port, `/api/mcp/activity${query}`, headers);
const tasks = (port: number, headers: Record<string, string> = {}) => get(port, '/api/mcp/tasks', headers);

/** Writes one row the way runTool does, and answers it. */
function logRow(r: Rig, over: Partial<Parameters<Rig['t']['activity']['logActivity']>[0]> = {}): McpActivityRow {
  return r.t.activity.logActivity({
    centralId: 'central-1',
    tool: 'prompt_send',
    risk: 'steers',
    targetSessionId: 'w1',
    summary: 'Sent a prompt to 1 session',
    outcome: 'ok',
    ...over,
  });
}

/** A worker the ledger can hand a task to, and the central that hands it. */
function newTask(r: Rig, id = 'w1', task = 'fix the flaky queue test'): string {
  const central = makeCentral();
  const session = r.t.ledgerDeps.worker(id);
  return r.t.ledger.create({ central, session, task }).taskId;
}

/** Lets the promises the ledger started settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe('GET /api/mcp/activity', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('answers an empty list while nothing was logged', async () => {
    const answer = await activity(r.port);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, rows: [] });
  });

  it('lists every central’s rows, newest first, with exactly the public fields', async () => {
    const first = logRow(r, { centralId: 'central-1', summary: 'first' });
    const second = logRow(r, { centralId: 'central-2', summary: 'second', outcome: 'refused', detail: { code: 'HANDS_OFF' } });

    const answer = await activity(r.port);

    expect(answer.status).toBe(200);
    const rows = answer.body.rows as McpActivityRow[];
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
    expect(rows[0]).toMatchObject({
      centralId: 'central-2',
      tool: 'prompt_send',
      risk: 'steers',
      targetSessionId: 'w1',
      summary: 'second',
      outcome: 'refused',
      detail: { code: 'HANDS_OFF' },
    });
  });

  it('lists one central’s rows with ?central=', async () => {
    logRow(r, { centralId: 'central-1', summary: 'mine' });
    logRow(r, { centralId: 'central-2', summary: 'theirs' });

    const answer = await activity(r.port, '?central=central-1');

    expect((answer.body.rows as McpActivityRow[]).map((row) => row.summary)).toEqual(['mine']);
  });

  it('answers no rows for a central that wrote none, rather than every central’s', async () => {
    logRow(r, { centralId: 'central-1' });

    const answer = await activity(r.port, '?central=nobody');

    expect(answer.body).toEqual({ ok: true, rows: [] });
  });

  it('treats an empty ?central= as no filter', async () => {
    logRow(r, { centralId: 'central-1' });
    logRow(r, { centralId: 'central-2' });

    const answer = await activity(r.port, '?central=');

    expect(answer.body.rows).toHaveLength(2);
  });

  describe('?limit=', () => {
    beforeEach(() => {
      for (let i = 0; i < 520; i += 1) logRow(r, { summary: `row ${i}` });
    });

    it('is 100 rows when it is not given', async () => {
      expect((await activity(r.port)).body.rows).toHaveLength(100);
    });

    it('takes the number asked for, newest first', async () => {
      const rows = (await activity(r.port, '?limit=3')).body.rows as McpActivityRow[];

      expect(rows.map((row) => row.summary)).toEqual(['row 519', 'row 518', 'row 517']);
    });

    it('never answers more than 500 rows', async () => {
      expect((await activity(r.port, '?limit=100000')).body.rows).toHaveLength(500);
      expect((await activity(r.port, '?limit=501')).body.rows).toHaveLength(500);
      expect((await activity(r.port, '?limit=500')).body.rows).toHaveLength(500);
    });

    it('answers at least one row for zero or a negative number', async () => {
      expect((await activity(r.port, '?limit=0')).body.rows).toHaveLength(1);
      expect((await activity(r.port, '?limit=-7')).body.rows).toHaveLength(1);
    });

    it('rounds a fraction down', async () => {
      expect((await activity(r.port, '?limit=2.9')).body.rows).toHaveLength(2);
    });

    it('falls back to the default for something that is not a number', async () => {
      expect((await activity(r.port, '?limit=lots')).body.rows).toHaveLength(100);
      expect((await activity(r.port, '?limit=')).body.rows).toHaveLength(100);
      expect((await activity(r.port, '?limit=1e999')).body.rows).toHaveLength(100);
    });
  });

  it('lists a task’s changes of state beside the writes (the rows deliver.ts logs for the ledger)', async () => {
    const id = newTask(r);
    await settle();

    const rows = (await activity(r.port)).body.rows as McpActivityRow[];

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.tool === 'task' && row.taskId === id)).toBe(true);
    expect(rows.map((row) => row.outcome)).toContain('queued');
  });

  describe('never carries a token', () => {
    it('blanks token-shaped text a row holds, in the summary and in the detail', async () => {
      const record = r.registry.mint(globalInput());
      logRow(r, {
        summary: `Sent it with Bearer ${record.token} and aasc_mcp_LEAKEDVALUE`,
        detail: { note: `key ${record.token}` },
      });

      const answer = await activity(r.port);

      expect(answer.text).not.toContain(record.token);
      expect(answer.text).not.toContain('LEAKEDVALUE');
    });

    it('never writes a live central’s token into a row, whatever is logged beside it', async () => {
      const a = r.registry.mint(globalInput());
      const b = r.registry.mint(roomInput('room-1'));
      logRow(r, { centralId: a.centralId });
      logRow(r, { centralId: b.centralId });

      const answer = await activity(r.port);

      for (const record of r.registry.list()) expect(answer.text).not.toContain(record.token);
      expect(answer.text).not.toContain('aasc_mcp_');
      expect(answer.text).not.toMatch(/token/i);
    });

    it('builds each row from its public fields: a source that holds more is cut down, and its text scrubbed again', async () => {
      const hostile = {
        id: 7,
        at: 1,
        centralId: 'c1',
        centralSessionId: null,
        tool: 'prompt_send',
        risk: 'steers',
        targetSessionId: 'w1',
        taskId: null,
        summary: 'went out with Bearer sk-abcdefghijklmnopqrstuvwx',
        outcome: 'ok',
        detail: { from: 'aasc_mcp_SECRETDETAIL', n: 3, ok: true, nothing: null },
        token: 'aasc_mcp_SECRETFIELD',
        terminalId: 'term-secret-1',
        detailJson: '{"token":"aasc_mcp_SECRETJSON"}',
      };
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      const custom = await rig({
        deliver: {
          activity: { listActivity: () => [hostile as unknown as McpActivityRow], onActivity: () => () => undefined },
          onTaskUpdate: () => () => undefined,
          ledger: { list: () => [] },
        },
      });

      const answer = await activity(custom.port);

      expect(answer.status).toBe(200);
      expect(Object.keys(answer.body.rows[0]).sort()).toEqual(ROW_FIELDS);
      for (const needle of ['SECRETFIELD', 'SECRETDETAIL', 'SECRETJSON', 'term-secret-1', 'sk-abcdefghijklmnop']) {
        expect(answer.text).not.toContain(needle);
      }
      expect(answer.body.rows[0].detail).toEqual({ from: 'aasc_mcp_[redacted]', n: 3, ok: true, nothing: null });
    });
  });

  describe('is for this Mac only', () => {
    beforeEach(() => {
      logRow(r);
    });

    it('refuses a request relayed by a proxy (a forwarding header) with a 404 and no data', async () => {
      const answer = await activity(r.port, '', { 'x-forwarded-for': '203.0.113.9' });

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({ ok: false, error: 'Not found' });
      expect(answer.text).not.toContain('prompt_send');
    });

    it('refuses a request that names another host (a page re-resolved to loopback)', async () => {
      const answer = await activity(r.port, '', { host: 'attacker.example' });

      expect(answer.status).toBe(404);
      expect(answer.text).not.toContain('prompt_send');
    });

    it('refuses a cross-site browser request', async () => {
      expect((await activity(r.port, '', { 'sec-fetch-site': 'cross-site' })).status).toBe(404);
    });

    it('answers a plain loopback request', async () => {
      expect((await activity(r.port)).status).toBe(200);
    });
  });

  describe('with an injected rule', () => {
    it('takes its answer from `isLocal`', async () => {
      let local = false;
      const custom = await rig({ isLocal: () => local });

      expect((await activity(custom.port)).status).toBe(404);
      local = true;
      expect((await activity(custom.port)).status).toBe(200);
    });

    it('is not served with the feature off (`mcp.enabled: false`)', async () => {
      let on = false;
      const custom = await rig({ enabled: () => on });

      expect((await activity(custom.port)).status).toBe(404);
      on = true;
      expect((await activity(custom.port)).status).toBe(200);
    });

    it('answers 404 when the server runs no P2 runtime (nothing records activity)', async () => {
      const bare = await rig({ deliver: undefined });

      expect((await activity(bare.port)).status).toBe(404);
    });

    it('answers 500 in fixed words when the log fails, and never the error text', async () => {
      const custom = await rig({
        deliver: {
          activity: {
            listActivity: () => {
              throw new Error('database SECRET-DETAIL is locked');
            },
            onActivity: () => () => undefined,
          },
          onTaskUpdate: () => () => undefined,
          ledger: { list: () => [] },
        },
      });

      const answer = await activity(custom.port);

      expect(answer.status).toBe(500);
      expect(answer.body.ok).toBe(false);
      expect(answer.text).not.toContain('SECRET-DETAIL');
      expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SECRET-DETAIL'));
    });
  });
});

// The two names the P2 plan gives Task 6's route tests (the others of that list are C1's, in activity.test.ts):
// each gathers what the groups above test in detail, so a grep for the plan's list finds them.
describe('the plan’s Task 6 route tests', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('GET refuses remote callers', async () => {
    logRow(r, { summary: 'a row that stays on this Mac' });
    const outsiders: Array<Record<string, string>> = [
      { 'x-forwarded-for': '203.0.113.9' },
      { host: 'attacker.example' },
      { 'sec-fetch-site': 'cross-site' },
    ];

    for (const headers of outsiders) {
      const answer = await activity(r.port, '', headers);
      expect(answer.status).toBe(404);
      expect(answer.text).not.toContain('stays on this Mac');
    }
    expect((await activity(r.port)).status).toBe(200);
  });

  it('no token or secret text in rows', async () => {
    const record = r.registry.mint(globalInput());
    logRow(r, {
      summary: `Sent it with Bearer ${record.token} and sk-abcdefghijklmnopqrstuvwx`,
      detail: { note: `key ${record.token} ghp_${'abcdefghijklmnopqrstuvwxyz0123'}` },
    });

    const answer = await activity(r.port);

    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(record.token);
    expect(answer.text).not.toContain('sk-abcdefghijklmnop');
    expect(answer.text).not.toContain('ghp_abcdefghijklmnop');
    expect(answer.text).not.toMatch(/aasc_mcp_(?!\[redacted\])/);
  });
});

describe('a paired phone', () => {
  it('may not read the activity log or the tasks: the phone profile (deny by default) refuses both before this router', () => {
    expect(phoneRuleFor('GET', '/mcp/activity')).toBeNull();
    expect(phoneRuleFor('GET', '/mcp/tasks')).toBeNull();
  });
});

describe('GET /api/mcp/tasks', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  it('answers an empty list while no task is open', async () => {
    expect((await tasks(r.port)).body).toEqual({ ok: true, tasks: [] });
  });

  it('lists the tasks in flight, as views with exactly the public fields', async () => {
    const id = newTask(r, 'w1', 'fix the flaky queue test');
    await settle();

    const answer = await tasks(r.port);

    expect(answer.status).toBe(200);
    const list = answer.body.tasks as McpTaskView[];
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(TASK_FIELDS);
    expect(list[0]).toMatchObject({ taskId: id, sessionId: 'w1', title: 'fix the flaky queue test', error: null });
    expect(['queued', 'sent', 'running']).toContain(list[0].state);
  });

  // P4-18 (queued): the window must see what AASC decided and whether the answer was cut, as the tools do (Ruling 66).
  it('sends how AASC routed a task, that its answer was cut, and where it was re-routed from', async () => {
    const central = makeCentral();
    const route = { by: 'auto', decision: 'reuse', reasons: ['an idle session in the project'] } as const;
    r.t.ledger.create({ central, session: r.t.ledgerDeps.worker('w1'), task: 'routed by AASC', route });
    newTask(r, 'w2');
    await settle();

    const list = (await tasks(r.port)).body.tasks as McpTaskView[];

    expect(list[0]).toMatchObject({ answerTruncated: false, route, retargetedFrom: null });
    expect(list[1]).toMatchObject({ answerTruncated: false, route: null, retargetedFrom: null });
  });

  it('scrubs the reasons of a route like any other words that leave the server', async () => {
    const central = makeCentral();
    const route = { by: 'auto', decision: 'create', reasons: [`picked   the folder sk-ant-api03-${'abcdefghijklmnopqrstuvwxyz0123'}`] } as const;
    r.t.ledger.create({ central, session: r.t.ledgerDeps.worker('w1'), task: 'routed by AASC', route });
    await settle();

    const answer = await tasks(r.port);

    expect(answer.text).not.toContain('sk-ant-api03');
    expect(answer.text).toContain('picked the folder');
  });

  it('never carries the answer, the prompt key or the terminal id', async () => {
    newTask(r);
    await settle();

    const answer = await tasks(r.port);

    expect(answer.text).not.toContain('term-w1');
    expect(answer.text).not.toContain('mcp-');
    expect(answer.text).not.toMatch(/promptKey|terminalId|"answer"/);
  });

  it('leaves out a task that has ended (a window needs no badge for it)', async () => {
    newTask(r, 'w1');
    const second = newTask(r, 'w2');
    await settle();
    r.t.ledgerDeps.exit('term-w1');

    const list = (await tasks(r.port)).body.tasks as McpTaskView[];

    expect(list.map((task) => task.taskId)).toEqual([second]);
  });

  it('lists the oldest first', async () => {
    const a = newTask(r, 'w1');
    const b = newTask(r, 'w2');
    await settle();

    expect(((await tasks(r.port)).body.tasks as McpTaskView[]).map((task) => task.taskId)).toEqual([a, b]);
  });

  it('is for this Mac only: a proxy header, a foreign host and a cross-site request get a 404 and no data', async () => {
    newTask(r);
    await settle();

    const outsiders: Array<Record<string, string>> = [
      { 'x-forwarded-for': '203.0.113.9' },
      { host: 'attacker.example' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of outsiders) {
      const answer = await tasks(r.port, headers);
      expect(answer.status).toBe(404);
      expect(answer.text).not.toContain('T1');
    }
  });

  it('is not served with the feature off, or without a P2 runtime', async () => {
    let on = false;
    const off = await rig({ enabled: () => on });
    expect((await tasks(off.port)).status).toBe(404);
    on = true;
    expect((await tasks(off.port)).status).toBe(200);

    const bare = await rig({ deliver: undefined });
    expect((await tasks(bare.port)).status).toBe(404);
  });

  it('answers 500 in fixed words when the ledger fails, and never the error text', async () => {
    const custom = await rig({
      deliver: {
        activity: { listActivity: () => [], onActivity: () => () => undefined },
        onTaskUpdate: () => () => undefined,
        ledger: {
          list: () => {
            throw new Error('ledger SECRET-DETAIL is corrupt');
          },
        },
      },
    });

    const answer = await tasks(custom.port);

    expect(answer.status).toBe(500);
    expect(answer.body.ok).toBe(false);
    expect(answer.text).not.toContain('SECRET-DETAIL');
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SECRET-DETAIL'));
  });
});

describe('the mcp_activity feed', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  const activityMessages = (sent: Sent[]) => sent.map(([local]) => local).filter((m) => m.type === 'mcp_activity');

  it('sends each new row to this Mac’s windows, with the row GET answers', async () => {
    const row = logRow(r, { summary: 'Sent a prompt to 2 sessions' });

    const messages = activityMessages(r.sent);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: 'mcp_activity', row });
    expect(Object.keys((messages[0] as { row: McpActivityRow }).row).sort()).toEqual(ROW_FIELDS);
    expect((await activity(r.port)).body.rows[0]).toEqual(row);
  });

  it('is local-only: the remote side of the call is always null', () => {
    logRow(r);
    logRow(r, { outcome: 'refused' });
    newTask(r);

    expect(r.sent.length).toBeGreaterThanOrEqual(3);
    for (const [local, remote] of r.sent) {
      expect(local).not.toBeNull();
      expect(remote).toBeNull();
    }
  });

  it('sends one message per row, refusals included', () => {
    logRow(r, { outcome: 'ok' });
    logRow(r, { outcome: 'refused', summary: 'Refused: that session is hands-off' });
    logRow(r, { outcome: 'failed' });

    expect(activityMessages(r.sent).map((m) => (m as { row: McpActivityRow }).row.outcome)).toEqual(['ok', 'refused', 'failed']);
  });

  it('puts no token on the wire, even for a source that hands one over', () => {
    server?.closeAllConnections();
    const listeners = new Set<(row: McpActivityRow) => void>();
    const sent: Sent[] = [];
    createCentralsRouter({
      registry: createCentralRegistry(),
      sessions: () => [],
      broadcastByLocality: (local, remote) => {
        sent.push([local, remote]);
      },
      deliver: {
        activity: {
          listActivity: () => [],
          onActivity: (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
          },
        },
        onTaskUpdate: () => () => undefined,
        ledger: { list: () => [] },
      },
    });
    const hostile = {
      id: 9,
      at: 1,
      centralId: 'c1',
      centralSessionId: null,
      tool: 'x',
      risk: 'write',
      targetSessionId: null,
      taskId: null,
      summary: 'Authorization: Bearer aasc_mcp_WIREOFFENCE',
      outcome: 'ok',
      detail: null,
      token: 'aasc_mcp_WIREFIELD',
    };

    for (const l of listeners) l(hostile as unknown as McpActivityRow);

    const wire = JSON.stringify(sent);
    expect(wire).toContain('mcp_activity');
    expect(wire).not.toContain('WIREOFFENCE');
    expect(wire).not.toContain('WIREFIELD');
    expect(wire).not.toMatch(/"token"/);
  });

  it('never breaks the log when sending fails, and says so in the log without the token', async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const failing = await rig({
      broadcastByLocality: () => {
        throw new Error('socket closed');
      },
    });

    const row = logRow(failing, { summary: 'went out' });

    expect(row.id).toBeGreaterThan(0);
    expect(failing.t.activity.listActivity()).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('socket closed'));
  });

  it('stops after close(), once however often it is called', () => {
    r.router.close();
    r.router.close();

    logRow(r);
    newTask(r);

    expect(r.sent).toHaveLength(0);
  });

  it('sends nothing for the log when the server runs no P2 runtime, and the centrals feed still works', async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const bare = await rig({ deliver: undefined });

    bare.registry.mint(globalInput());

    expect(bare.sent).toHaveLength(1);
    expect(bare.sent[0][0].type).toBe('centrals_update');
  });
});

describe('the mcp_task_update feed', () => {
  let r: Rig;
  beforeEach(async () => {
    r = await rig();
  });

  const taskMessages = (sent: Sent[]) =>
    sent.map(([local]) => local).filter((m): m is Extract<CentralsFeedMessage, { type: 'mcp_task_update' }> => m.type === 'mcp_task_update');

  it('sends a task’s change of state, as the view a badge needs', async () => {
    const id = newTask(r, 'w1', 'fix the flaky queue test');
    await settle();

    const messages = taskMessages(r.sent);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    for (const message of messages) {
      expect(message.task.taskId).toBe(id);
      expect(Object.keys(message.task).sort()).toEqual(TASK_FIELDS);
    }
    expect(messages[0].task).toMatchObject({ sessionId: 'w1', title: 'fix the flaky queue test', state: 'queued' });
  });

  it('follows the task to its end', async () => {
    newTask(r, 'w1');
    await settle();
    r.t.ledgerDeps.exit('term-w1');

    const states = taskMessages(r.sent).map((m) => m.task.state);

    expect(states[states.length - 1]).toBe('failed');
  });

  it('is local-only: the remote side of the call is always null', async () => {
    newTask(r);
    await settle();

    expect(taskMessages(r.sent).length).toBeGreaterThan(0);
    for (const [, remote] of r.sent) expect(remote).toBeNull();
  });

  it('never carries the task text beyond its title, the answer, the prompt key or the terminal id', async () => {
    newTask(r, 'w1', `${'fix the queue '.repeat(12)} LATE-TASK-TEXT and more`);
    await settle();

    const wire = JSON.stringify(taskMessages(r.sent));

    expect(wire).not.toContain('LATE-TASK-TEXT');
    expect(wire).not.toContain('term-w1');
    expect(wire).not.toContain('mcp-');
    expect(wire).not.toMatch(/promptKey|terminalId|"answer"|"history"/);
  });

  it('blanks token-shaped text in a title, for a source that did not', () => {
    const listeners = new Set<(task: McpTaskView) => void>();
    const sent: Sent[] = [];
    createCentralsRouter({
      registry: createCentralRegistry(),
      sessions: () => [],
      broadcastByLocality: (local, remote) => {
        sent.push([local, remote]);
      },
      deliver: {
        activity: { listActivity: () => [], onActivity: () => () => undefined },
        onTaskUpdate: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        ledger: { list: () => [] },
      },
    });
    const hostile = {
      taskId: 'T1',
      centralId: 'c1',
      sessionId: 'w1',
      state: 'running',
      title: 'use Bearer aasc_mcp_TITLELEAK please',
      createdAt: 1,
      sentAt: 2,
      updatedAt: 3,
      error: 'Authorization: Bearer aasc_mcp_ERRORLEAK',
      answerChars: null,
      token: 'aasc_mcp_FIELDLEAK',
    };

    for (const l of listeners) l(hostile as unknown as McpTaskView);

    const wire = JSON.stringify(sent);
    expect(wire).toContain('mcp_task_update');
    for (const needle of ['TITLELEAK', 'ERRORLEAK', 'FIELDLEAK']) expect(wire).not.toContain(needle);
  });

  it('stops after close()', async () => {
    r.router.close();

    newTask(r);
    await settle();

    expect(taskMessages(r.sent)).toHaveLength(0);
  });
});
