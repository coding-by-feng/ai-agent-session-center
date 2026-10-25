// test/mcp/activity.test.ts — the activity log (server/mcp/activity.ts) and how every way into a tool writes to it
// (server/mcp/runTool.ts, and server.ts for a refused argument check): every non-read call, every refusal of one,
// every policy refusal; never a read; never a token or text a central or a session wrote. Rows are kept 30 days.
//
// The store runs on an in-memory SQLite database (`node:sqlite`): the SQL is the server's own.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { MCP_ACTIVITY, MCP_TASK_UPDATE } from '../../src/types/mcpEvents.js';
import {
  ACTIVITY_KEEP_MS,
  ACTIVITY_LIST_MAX,
  ACTIVITY_PRUNE_EVERY_MS,
  createActivityLog,
  type ActivityInput,
} from '../../server/mcp/activity.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { ToolDef } from '../../server/mcp/registry.js';
import { runTool, type Via } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { connect, harness, runCleanups } from './endpointHarness.js';
import { connectAs, freshWorld, startWorld } from './resourceWorld.js';
import { fakeClient, makeSession, NOW } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

beforeEach(() => {
  log.warn.mockClear();
});
afterEach(runCleanups);

const TOKEN = 'aasc_mcp_Q2hhbmdlZEFsbE1lVGhpc0lzQVRlc3RUb2tlbjEyMzQ1Ng';
const SECRET = 'my bank password is hunter2';

/** A tool of the test's own: a P2 write by default. */
const tool = (over: Partial<ToolDef> & Pick<ToolDef, 'name'>): ToolDef => ({
  toolset: 'prompts',
  title: `Stub ${over.name}`,
  description: 'A stand-in.',
  risk: 'write',
  phase: 2,
  input: {},
  run: async () => ({ data: null, summary: 'ok' }),
  ...over,
});

/** A global central with its own card, two workers (w2 hands-off), and a deliver runtime on fakes. */
function world(opts: { wired?: boolean } = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const sessions: Session[] = [
    makeSession('card-1', {
      terminalId: 'term-card',
      central: { centralId: central.centralId, kind: 'global', scopeRef: null },
    }),
    makeSession('w1', { terminalId: 'term-w1', status: 'waiting' }),
    makeSession('w2', { terminalId: 'term-w2', status: 'waiting', handsOff: true }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  const deps: McpDeps = {
    registry,
    client: () => fakeClient(),
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    ...(opts.wired === false ? {} : { deliver: t.deliver }),
  };
  const call = (def: ToolDef, args: Record<string, unknown> = {}, via: Via = 'call') =>
    runTool(def, args, { centralId: central.centralId, deps, signal: neverAborted, via });
  return { ...t, registry, central, sessions, deps, call };
}

const failureOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the activity table', () => {
  const input = (over: Partial<ActivityInput> = {}): ActivityInput => ({
    centralId: 'c1',
    centralSessionId: 'card-1',
    tool: 'prompt_send',
    risk: 'steers',
    targetSessionId: 'w1',
    taskId: null,
    summary: 'Sent a prompt',
    outcome: 'ok',
    ...over,
  });

  it('has the columns the plan names, created on first use', () => {
    const db = new DatabaseSync(':memory:');
    const activity = createActivityLog({ db: () => db, now: () => NOW, pruneEveryMs: null });
    activity.listActivity();

    const columns = (db.prepare('PRAGMA table_info(mcp_activity)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'at',
      'central_id',
      'central_session_id',
      'tool',
      'risk',
      'target_session_id',
      'task_id',
      'summary',
      'outcome',
      'detail_json',
    ]);
  });

  it('logs a row and answers it with its id and time', () => {
    const { activity } = testDeliver({ now: () => NOW });

    const row = activity.logActivity(input({ detail: { code: 'BUSY', count: 2, ok: false } }));

    expect(row).toEqual({
      id: 1,
      at: NOW,
      centralId: 'c1',
      centralSessionId: 'card-1',
      tool: 'prompt_send',
      risk: 'steers',
      targetSessionId: 'w1',
      taskId: null,
      summary: 'Sent a prompt',
      outcome: 'ok',
      detail: { code: 'BUSY', count: 2, ok: false },
    });
    expect(activity.listActivity()).toEqual([row]);
  });

  it('lists newest first, by central, at most 500, 100 unless told', () => {
    const { activity } = testDeliver({ now: () => NOW });
    for (let i = 0; i < 520; i += 1) activity.logActivity(input({ centralId: i % 2 === 0 ? 'c1' : 'c2', summary: `row ${i}` }));

    expect(activity.listActivity()).toHaveLength(100);
    expect(activity.listActivity()[0].summary).toBe('row 519');
    expect(activity.listActivity({ limit: 10_000 })).toHaveLength(ACTIVITY_LIST_MAX);
    expect(ACTIVITY_LIST_MAX).toBe(500);
    expect(activity.listActivity({ limit: 0 })).toHaveLength(1);
    const c2 = activity.listActivity({ centralId: 'c2', limit: 3 });
    expect(c2.map((r) => r.summary)).toEqual(['row 519', 'row 517', 'row 515']);
    expect(activity.listActivity({ centralId: 'c2', limit: 2, beforeId: c2[1].id }).map((r) => r.summary)).toEqual([
      'row 515',
      'row 513',
    ]);
  });

  it('prune drops rows older than 30 days', () => {
    let now = NOW;
    const { activity } = testDeliver({ now: () => now });
    activity.logActivity(input({ at: NOW - ACTIVITY_KEEP_MS - 1, summary: 'old' }));
    activity.logActivity(input({ at: NOW - ACTIVITY_KEEP_MS + 60_000, summary: 'recent' }));
    activity.logActivity(input({ summary: 'now' }));

    expect(ACTIVITY_KEEP_MS).toBe(30 * 24 * 60 * 60_000);
    expect(activity.pruneActivity()).toBe(1);
    expect(activity.listActivity().map((r) => r.summary)).toEqual(['now', 'recent']);

    now = NOW + 120_000;
    expect(activity.pruneActivity()).toBe(1);
    expect(activity.listActivity().map((r) => r.summary)).toEqual(['now']);
  });

  it('prunes on its own every hour, on a timer that never keeps the process alive', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const db = new DatabaseSync(':memory:');
      const activity = createActivityLog({ db: () => db });
      activity.logActivity(input({ at: NOW - ACTIVITY_KEEP_MS + 30 * 60_000, summary: 'ages out within the hour' }));
      expect(ACTIVITY_PRUNE_EVERY_MS).toBe(60 * 60_000);

      vi.advanceTimersByTime(ACTIVITY_PRUNE_EVERY_MS);
      expect(activity.listActivity()).toEqual([]);

      activity.logActivity(input({ at: Date.now() - ACTIVITY_KEEP_MS - 1, summary: 'old again' }));
      activity.close();
      vi.advanceTimersByTime(ACTIVITY_PRUNE_EVERY_MS * 2);
      expect(activity.listActivity()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells its listeners each new row; one that throws stops neither the others nor the log', () => {
    const { activity } = testDeliver({ now: () => NOW });
    const heard: number[] = [];
    activity.onActivity(() => {
      throw new Error('a broken listener');
    });
    const off = activity.onActivity((row) => heard.push(row.id));

    activity.logActivity(input());
    off();
    activity.logActivity(input());

    expect(heard).toEqual([1]);
    expect(activity.listActivity()).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('a broken listener'));
  });

  it('keeps each text short and on one line, and drops a detail that is not flat', () => {
    const { activity } = testDeliver({ now: () => NOW });

    const row = activity.logActivity(
      input({
        summary: `line one\nline two\t${'z'.repeat(1_000)}`,
        detail: { nested: { a: 1 } as unknown as string, long: 'q'.repeat(1_000) },
      }),
    );

    expect(row.summary).not.toMatch(/[\n\t]/);
    expect(row.summary.length).toBeLessThanOrEqual(300);
    expect(row.detail).toEqual({ long: expect.any(String) });
    expect(String(row.detail?.long).length).toBeLessThanOrEqual(200);
  });

  it('names the two event types the server sends for it', () => {
    expect(MCP_ACTIVITY).toBe('mcp_activity');
    expect(MCP_TASK_UPDATE).toBe('mcp_task_update');
  });
});

// ---------------------------------------------------------------------------
// What runTool writes
// ---------------------------------------------------------------------------

describe('every non-read call is logged', () => {
  it('a write is logged with outcome ok', async () => {
    const w = world();

    await w.call(tool({ name: 'demo_write', title: 'Demo write' }), { text: SECRET });

    expect(w.activity.listActivity()).toEqual([
      expect.objectContaining({
        centralId: w.central.centralId,
        centralSessionId: 'card-1',
        tool: 'demo_write',
        risk: 'write',
        targetSessionId: null,
        taskId: null,
        summary: 'Demo write',
        outcome: 'ok',
      }),
    ]);
  });

  it('a non-read call over the endpoint is logged as the central that made it', async () => {
    const t = testDeliver();
    const h = await harness({}, { deps: { deliver: t.deliver } });
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const answer = await client.callTool({ name: 'deleter', arguments: {} });

    expect(answer.structuredContent).toMatchObject({ ok: true });
    expect(t.activity.listActivity()).toEqual([
      expect.objectContaining({ centralId: central.centralId, tool: 'deleter', risk: 'destructive', outcome: 'ok' }),
    ]);
  });

  it('writes one row per note a tool gives about what it did', async () => {
    const w = world();
    const fanOut = tool({
      name: 'demo_send',
      risk: 'steers',
      run: async () => ({
        data: null,
        summary: 'sent to two',
        activity: [
          { summary: 'Sent the prompt', targetSessionId: 'w1' },
          { summary: 'The prompt route refused it: busy', targetSessionId: 'w9', outcome: 'refused', detail: { code: 'busy' } },
        ],
      }),
    });

    await w.call(fanOut);

    expect(w.activity.listActivity().reverse()).toEqual([
      expect.objectContaining({ tool: 'demo_send', risk: 'steers', targetSessionId: 'w1', outcome: 'ok', summary: 'Sent the prompt' }),
      expect.objectContaining({ targetSessionId: 'w9', outcome: 'refused', detail: { code: 'busy' } }),
    ]);
  });

  it('logs a failure inside AASC as failed, in fixed words', async () => {
    const w = world();
    const explode = tool({
      name: 'demo_explode',
      run: async () => {
        throw new Error('ENOENT /Users/someone/secret');
      },
    });

    const failure = await failureOf(w.call(explode));

    expect(failure).toMatchObject({ code: 'UPSTREAM' });
    const [row] = w.activity.listActivity();
    expect(row).toMatchObject({ tool: 'demo_explode', outcome: 'failed', detail: { code: 'UPSTREAM' } });
    expect(JSON.stringify(row)).not.toMatch(/ENOENT|someone|secret/);
  });
});

describe('refusals are logged', () => {
  it('a write tool’s own refusal, with its code', async () => {
    const w = world();
    const refuse = tool({
      name: 'demo_refuse',
      run: async () => {
        throw new ToolError('NO_WINDOW', 'The AASC window is not open.', 'Ask the person to open it.');
      },
    });

    expect(await failureOf(w.call(refuse))).toMatchObject({ code: 'NO_WINDOW' });

    expect(w.activity.listActivity()).toEqual([
      expect.objectContaining({
        tool: 'demo_refuse',
        outcome: 'refused',
        detail: { code: 'NO_WINDOW' },
        summary: expect.stringContaining('NO_WINDOW'),
      }),
    ]);
  });

  it('a policy refusal the tool lets through: once, with the session refused', async () => {
    const w = world();
    const steer = tool({
      name: 'demo_steer',
      risk: 'steers',
      run: async (_args, ctx) => {
        ctx.mayDrive(ctx.sessions().find((s) => s.sessionId === 'w2')!);
        return { data: null, summary: 'never' };
      },
    });

    expect(await failureOf(w.call(steer))).toMatchObject({ code: 'HANDS_OFF' });

    expect(w.activity.listActivity()).toEqual([
      expect.objectContaining({
        tool: 'demo_steer',
        risk: 'steers',
        targetSessionId: 'w2',
        outcome: 'refused',
        detail: { code: 'HANDS_OFF' },
      }),
    ]);
  });

  it('a policy refusal the tool catches (a fan-out going on to the next session) is logged all the same', async () => {
    const w = world();
    const fanOut = tool({
      name: 'demo_fan_out',
      risk: 'steers',
      run: async (_args, ctx) => {
        const sent: string[] = [];
        for (const s of ctx.sessions().filter((x) => x.sessionId !== 'card-1')) {
          try {
            ctx.mayDrive(s);
            sent.push(s.sessionId);
          } catch {
            // The tool reports the refusal in its answer and carries on.
          }
        }
        return { data: sent, summary: 'sent', activity: sent.map((id) => ({ summary: 'Sent the prompt', targetSessionId: id })) };
      },
    });

    await w.call(fanOut);

    const rows = w.activity.listActivity().reverse();
    expect(rows.map((r) => [r.targetSessionId, r.outcome])).toEqual([
      ['w2', 'refused'],
      ['w1', 'ok'],
    ]);
  });

  it('a policy refusal is logged whatever the tool’s risk', async () => {
    const w = world();
    const peek = tool({
      name: 'demo_peek',
      risk: 'read',
      run: async (_args, ctx) => {
        ctx.mayDrive(ctx.sessions().find((s) => s.sessionId === 'w2')!);
        return { data: null, summary: 'never' };
      },
    });

    await failureOf(w.call(peek));

    expect(w.activity.listActivity()).toEqual([expect.objectContaining({ tool: 'demo_peek', outcome: 'refused' })]);
  });

  it('a write refused by its argument check, before it runs', async () => {
    const t = testDeliver();
    const h = await harness({}, { deps: { deliver: t.deliver } });
    const central = h.registry.mint(globalInput());
    const { client } = await connect(h, central.token);

    const missing = await client.callTool({ name: 'setter', arguments: { id: TOKEN } });
    const readRefused = await client.callTool({ name: 'echo', arguments: { text: 42 } });

    expect(missing.structuredContent).toMatchObject({ ok: false, code: 'INVALID' });
    expect(readRefused.structuredContent).toMatchObject({ ok: false, code: 'INVALID' });
    const rows = t.activity.listActivity();
    expect(rows).toEqual([
      expect.objectContaining({ centralId: central.centralId, tool: 'setter', risk: 'write', outcome: 'refused', detail: { code: 'INVALID' } }),
    ]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });
});

describe('reads are not logged', () => {
  it('neither a read tool’s answer nor its refusal', async () => {
    const w = world();
    const read = tool({ name: 'demo_read', risk: 'read' });
    const readRefusal = tool({
      name: 'demo_read_refused',
      risk: 'read',
      run: async () => {
        throw new ToolError('NOT_FOUND', 'No such thing.');
      },
    });

    await w.call(read);
    await w.call(read, {}, 'read');
    await failureOf(w.call(readRefusal));

    expect(w.activity.listActivity()).toEqual([]);
  });

  it('nor a read of a resource over the endpoint', async () => {
    const t = testDeliver();
    const started = await startWorld(freshWorld(), { deliver: t.deliver });
    const { client } = await connectAs(started, globalInput());

    await client.callTool({ name: 'session_list', arguments: {} });
    await client.readResource({ uri: 'aasc://sessions' });

    expect(t.activity.listActivity()).toEqual([]);
  });
});

describe('no token or secret text in rows', () => {
  it('keeps out what the central sent, what the tool said, and anything shaped like a token', async () => {
    const w = world();
    const leaky = tool({
      name: 'demo_leaky',
      risk: 'steers',
      run: async () => ({
        data: { echoed: SECRET },
        summary: `I sent ${SECRET} with ${TOKEN}`,
        activity: [
          {
            summary: `Sent with Authorization: Bearer ${TOKEN}`,
            targetSessionId: 'w1',
            detail: { header: `Bearer ${TOKEN}`, raw: TOKEN },
          },
        ],
      }),
    });
    const refusing = tool({
      name: 'demo_refusing',
      run: async () => {
        throw new ToolError('INVALID', `Refused, though the message carries ${TOKEN}`);
      },
    });

    await w.call(leaky, { text: SECRET, token: TOKEN });
    await failureOf(w.call(refusing, { text: SECRET }));

    const stored = JSON.stringify(w.rawRows());
    const listed = JSON.stringify(w.activity.listActivity());
    for (const text of [stored, listed]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('Q2hhbmdlZEFsbE1l');
      expect(text).not.toContain('hunter2');
    }
    expect(w.rawRows()).toHaveLength(2);
  });
});

describe('when the activity log is not wired', () => {
  it('refuses every non-read tool with UNAVAILABLE and never runs it; reads still run', async () => {
    const w = world({ wired: false });
    const run = vi.fn(async () => ({ data: null, summary: 'ran' }));

    expect(await failureOf(w.call(tool({ name: 'demo_write', run })))).toMatchObject({ code: 'UNAVAILABLE' });
    expect(run).not.toHaveBeenCalled();

    expect(await w.call(tool({ name: 'demo_read', risk: 'read', run }))).toEqual({ data: null, summary: 'ran' });
  });
});

describe('a log that cannot be written', () => {
  it('never fails the call: the tool’s answer goes back, the failure goes to the server log', async () => {
    const registry = createCentralRegistry();
    const central = registry.mint(globalInput());
    const broken = createActivityLog({
      db: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
      pruneEveryMs: null,
    });
    const t = testDeliver();
    const deps: McpDeps = {
      registry,
      client: () => fakeClient(),
      sessions: () => [],
      rooms: () => [],
      events: createEventHub(fakeBus().subscribe),
      deliver: { ...t.deliver, activity: broken },
    };

    const result = await runTool(tool({ name: 'demo_write' }), {}, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });

    expect(result).toEqual({ data: null, summary: 'ok' });
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SQLITE_FULL'));
  });
});
