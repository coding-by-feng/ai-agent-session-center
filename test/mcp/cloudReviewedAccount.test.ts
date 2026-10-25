// test/mcp/cloudReviewedAccount.test.ts — the account the person reviewed is the account that acts (plan 2026-10-25
// P6-6; server/mcp/tools/cloudWrite.ts `reviewAccount`, `approvedAccount`). A stand-in outward cloud tool of the test's
// own asks with `reviewAccount` (the card names the account, the fingerprint carries its key) and runs with
// `approvedAccount` (the binding the gate's recheck recorded). It is driven through the real runTool, within the 45 s
// wait and through confirm_wait, and through the tool harness's runApproved (the stand-in is added to the registry's
// list here). An account switched after the allow is CHANGED and calls nothing; a status that flips after the recheck
// never reaches the route call; two calls of one central in flight across a switch each keep their own review. The 45 s wait runs on fake timers. Nothing reaches a route or a process: /api is a fake
// client, the activity log an in-memory database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { ASK_WAIT_MS, createConfirmBook, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { boundGet, CLOUD, cloudStatus } from '../../server/mcp/tools/cloudCall.js';
import { approvedAccount, cloudSend, cloudWriteBody, reviewAccount } from '../../server/mcp/tools/cloudWrite.js';
import { systemWriteTools } from '../../server/mcp/tools/systemWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { ACCOUNT, BACKEND, CLOUD_HEADERS, CLOUD_HEADERS_B, CONNECTION, CONNECTION_B, STATUS_PATH } from './cloudFixtures.js';
import { askAndRun, askOf, cloudCtx, MAC_OPEN, switchAccount, type Account } from './cloudWriteKit.js';
import { testDeliver } from './deliverFixtures.js';
import { envelope, fakeClient, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** The stand-in, once built: the registry's list gains it, so the tool harness's runApproved can find it. */
const held = vi.hoisted(() => ({ def: null as unknown }));
vi.mock('../../server/mcp/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/mcp/registry.js')>();
  return { ...actual, allTools: () => [...actual.allTools(), ...(held.def === null ? [] : [held.def as ToolDef])] };
});

const DEMO = `${CLOUD}/demo`;
const CHANGED = {
  code: 'INVALID',
  message: 'What you asked about changed after the person was asked, so nothing was done.',
};
const KEY_A = `${BACKEND}|${ACCOUNT}|3`;

/** An outward cloud write of the test's own: asks as the reviewed account, posts as the approved one. */
const demo: ToolDef = {
  name: 'demo_cloud_write',
  toolset: 'cloud',
  title: 'Demo cloud write',
  description: 'A stand-in.',
  risk: 'outward',
  // Phase 5, not 6: confirm_wait finds a tool by this build's phase.
  phase: 5,
  input: {},
  async confirm(_args, ctx) {
    const account = await reviewAccount(ctx);
    return { summary: `AASC Cloud: demo as ${account.label}`, detail: 'one item', fingerprint: `demo:${account.key}` };
  },
  async run(_args, ctx) {
    const account = approvedAccount(ctx);
    const body = cloudWriteBody(await cloudSend(ctx, 'post', DEMO, {}, account.binding));
    return { data: { body }, summary: 'done' };
  },
};
held.def = demo;

const confirmWait = systemWriteTools.find((t) => t.name === 'confirm_wait') as ToolDef;

const CONNECTIONS: Readonly<Record<Account, object>> = { A: CONNECTION, B: CONNECTION_B };

/** Who the status route says is connected: account A or B, a connection of the test's own, or nobody (null). */
type Side = Account | object | null;

/**
 * A global central calling `demo` through the real gate, the window open. The status route answers `script[n]` at its
 * n-th read (the last one for ever after), or what `switchTo` was given once it is called.
 */
function world(script: Side[] = ['A']) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const sessions: Session[] = [
    makeSession('card-1', { terminalId: 'term-card', central: { centralId: central.centralId, kind: 'global', scopeRef: null } }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  let reads = 0;
  let switched: Side | undefined;
  const client = fakeClient({
    'GET /presence': MAC_OPEN,
    [STATUS_PATH]: () => {
      const side = switched !== undefined ? switched : script[Math.min(reads, script.length - 1)];
      reads += 1;
      if (side === null) return envelope({ connection: null, state: 'disconnected', lastError: null });
      const connection = typeof side === 'string' ? CONNECTIONS[side] : side;
      return envelope({ connection, state: 'connected', lastError: null });
    },
    [`POST ${DEMO}`]: envelope({ done: true }),
  });
  const book: ConfirmBook = createConfirmBook();
  const deps: McpDeps = {
    registry,
    client: () => client,
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
    confirms: book,
    tools: () => [demo, ...systemWriteTools],
  };
  const call = (def: ToolDef, args: Record<string, unknown>) =>
    runTool(def, args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
  const posts = () => client.calls.filter((c) => c.method === 'POST');
  return {
    call,
    book,
    posts,
    reads: () => reads,
    switchTo: (to: Side) => {
      switched = to;
    },
  };
}

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

async function settle(p: Promise<unknown>): Promise<void> {
  p.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
}

/** A call that answered NEEDS_CONFIRMATION, and its confirmId. */
async function askedAndWaited(w: ReturnType<typeof world>): Promise<string> {
  const first = w.call(demo, {});
  await settle(first);
  await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
  const err = await failureOf(first);
  expect(err.code).toBe('NEEDS_CONFIRMATION');
  return (err.data as { confirmId: string }).confirmId;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the reviewed account', () => {
  it('the card’s summary names the account and the fingerprint carries its key', async () => {
    const a = world(['A']);
    const first = a.call(demo, {});
    await settle(first);
    const b = world(['B']);
    const second = b.call(demo, {});
    await settle(second);

    // Account A has no email: its id's first 8 characters. Account B's email.
    expect(a.book.pending()[0]).toMatchObject({ summary: 'AASC Cloud: demo as 0b1f6d5e', fingerprint: `demo:${KEY_A}` });
    expect(b.book.pending()[0]).toMatchObject({
      summary: 'AASC Cloud: demo as other@example.test',
      fingerprint: `demo:${BACKEND}|${CONNECTION_B.accountId}|4`,
    });
  });

  it('allowed as it is, the run posts as that account', async () => {
    const w = world(['A']);
    const call = w.call(demo, {});
    await settle(call);
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect((await call).data).toMatchObject({ body: { done: true } });
    expect(w.posts()).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS }]);
  });

  it('an account switched after the allow is CHANGED and calls nothing (within the 45 s wait)', async () => {
    const w = world(['A']);
    const call = w.call(demo, {});
    await settle(call);

    w.book.answer(w.book.pending()[0].cardId, 'allow');
    w.switchTo('B');

    expect(await failureOf(call)).toMatchObject(CHANGED);
    expect(w.posts()).toEqual([]);
  });

  it('an account switched after the allow is CHANGED and calls nothing (through confirm_wait)', async () => {
    const w = world(['A']);
    const confirmId = await askedAndWaited(w);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    w.switchTo('B');

    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject(CHANGED);
    expect(w.posts()).toEqual([]);
  });

  it('a reconnect as the same account with a new generation is a change too', async () => {
    const w = world(['A']);
    const call = w.call(demo, {});
    await settle(call);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    // A reconnect of account A: the same backend and account id, only the generation moved.
    w.switchTo({ ...CONNECTION, generation: 4 });

    expect(await failureOf(call)).toMatchObject(CHANGED);
    expect(w.posts()).toEqual([]);
  });

  it('run sends the binding the recheck recorded, not a re-read (within the wait)', async () => {
    // The first read is the ask, the second the recheck; every read after it would be account B.
    const w = world(['A', 'A', 'B']);
    const call = w.call(demo, {});
    await settle(call);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    await call;

    expect(w.reads()).toBe(2);
    expect(w.posts()).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS }]);
  });

  it('run sends the binding the recheck recorded, not a re-read (through confirm_wait)', async () => {
    const w = world(['A', 'A', 'B']);
    const confirmId = await askedAndWaited(w);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    await w.call(confirmWait, { confirmId });

    expect(w.reads()).toBe(2);
    expect(w.posts()).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS }]);
  });

  it('reviewAccount when not connected is UNAVAILABLE before any card', async () => {
    const w = world([null]);

    const err = await failureOf(w.call(demo, {}));

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/not connected to AASC Cloud/);
    expect(w.book.pending()).toEqual([]);
    expect(w.posts()).toEqual([]);
  });

  it('an offline or revoked connection is not connected either', async () => {
    for (const state of ['offline', 'revoked']) {
      const h = cloudCtx({ routes: { [STATUS_PATH]: envelope({ connection: CONNECTION, state, lastError: null }) } });
      const err = await failureOf(askOf(h, 'demo_cloud_write', {}));
      expect(err.code).toBe('UNAVAILABLE');
    }
  });
});

describe('two calls of one central in flight, the account switched between them', () => {
  const SUMMARY_A = 'AASC Cloud: demo as 0b1f6d5e';
  const SUMMARY_B = 'AASC Cloud: demo as other@example.test';

  const cardOf = (w: ReturnType<typeof world>, summary: string): string => {
    const card = w.book.pending().find((c) => c.summary === summary);
    if (card === undefined) throw new Error(`No card "${summary}"`);
    return card.cardId;
  };

  it('the second call’s review (as B) does not move the first’s: the first runs as A, the second is CHANGED', async () => {
    const w = world(['A']);
    const first = w.call(demo, {});
    await settle(first);
    w.switchTo('B');
    const second = w.call(demo, {});
    await settle(second);

    expect(w.book.pending().map((c) => c.summary).sort()).toEqual([SUMMARY_A, SUMMARY_B]);

    w.switchTo('A');
    w.book.answer(cardOf(w, SUMMARY_A), 'allow');
    expect((await first).data).toMatchObject({ body: { done: true } });
    w.book.answer(cardOf(w, SUMMARY_B), 'allow');

    expect(await failureOf(second)).toMatchObject(CHANGED);
    expect(w.posts()).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS }]);
  });

  it('allowed while B is connected, only the call reviewed as B runs, and as B', async () => {
    const w = world(['A']);
    const first = w.call(demo, {});
    await settle(first);
    w.switchTo('B');
    const second = w.call(demo, {});
    await settle(second);

    w.book.answer(cardOf(w, SUMMARY_B), 'allow');
    expect((await second).data).toMatchObject({ body: { done: true } });
    w.book.answer(cardOf(w, SUMMARY_A), 'allow');

    expect(await failureOf(first)).toMatchObject(CHANGED);
    expect(w.posts()).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS_B }]);
  });
});

describe('approvedAccount', () => {
  it('approvedAccount without an allow is INVALID', async () => {
    const h = cloudCtx();
    await askOf(h, 'demo_cloud_write', {});

    const err = await failureOf(demo.run({}, h.ctx));

    expect(err).toMatchObject({ code: 'INVALID', message: 'That changed; call again.' });
    expect(h.client.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('an allow with no review of this call behind it is INVALID too', async () => {
    const h = cloudCtx({ allowedByPerson: () => true });

    const err = await failureOf(demo.run({}, h.ctx));

    expect(err).toMatchObject({ code: 'INVALID', message: 'That changed; call again.' });
  });
});

describe('through the tool harness’s runApproved', () => {
  it('allowed as it is, it posts as the reviewed account', async () => {
    const h = cloudCtx({ routes: { [`POST ${DEMO}`]: envelope({ done: true }) } });

    const { ask, result } = await askAndRun(h, 'demo_cloud_write', {});

    expect(ask.summary).toBe('AASC Cloud: demo as 0b1f6d5e');
    expect(result.data).toEqual({ body: { done: true } });
    expect(h.client.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: DEMO, body: {}, headers: CLOUD_HEADERS }]);
  });

  it('an account switched after the allow is CHANGED and calls nothing', async () => {
    const h = cloudCtx({ routes: { [`POST ${DEMO}`]: envelope({ done: true }) } });

    const err = await failureOf(askAndRun(h, 'demo_cloud_write', {}, () => switchAccount(h, 'B')));

    expect(err).toMatchObject(CHANGED);
    expect(h.client.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
});

describe('the card is deterministic', () => {
  it('the same state gives the same summary and fingerprint twice', async () => {
    const one = cloudCtx();
    const first = await askOf(one, 'demo_cloud_write', {});
    vi.setSystemTime(NOW + 123_456);
    const two = cloudCtx();
    const second = await askOf(two, 'demo_cloud_write', {});

    expect(second).toEqual(first);
  });
});

describe('cloudCall.ts', () => {
  it('cloudCall’s header no longer says a write never names the live binding unreviewed', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'server', 'mcp', 'tools', 'cloudCall.ts'), 'utf8');
    const header = text.slice(0, text.indexOf('\nimport '));

    expect(header).not.toContain('A future write tool (P6)');
    expect(header).not.toContain('That is true of READS only');
    expect(header).toContain('`reviewAccount`');
    expect(header).toContain('(`approvedAccount`), never `boundTo` or `boundGet`');
    expect(header).toContain('`liveAccount`');
  });

  it('boundTo and boundGet say what they are for: a bound read or a card-less write, never a waiting tool’s run', () => {
    const text = readFileSync(join(__dirname, '..', '..', 'server', 'mcp', 'tools', 'cloudCall.ts'), 'utf8');
    const docOf = (fn: string): string => {
      const at = text.indexOf(`export async function ${fn}(`);
      // The docstring, its lines joined.
      return text.slice(text.lastIndexOf('/**', at), at).replace(/\s*\n\s*\*\s*/g, ' ');
    };

    for (const fn of ['boundTo', 'boundGet']) {
      expect(docOf(fn), fn).not.toMatch(/Never (?:use it )?for a write/);
      expect(docOf(fn), fn).toContain('Never in the run of a write that waits for the person');
    }
    expect(docOf('boundTo')).toContain('a write with no card, through `liveAccount`');
  });

  it('the status read and a bound read pass the call’s signal', async () => {
    const h = cloudCtx({ routes: { [`GET ${DEMO}`]: envelope({ ok: true }) } });
    const seen: Array<{ signal?: AbortSignal } | undefined> = [];
    const client = {
      ...h.client,
      get: (path: string, query?: Parameters<typeof h.client.get>[1], options?: Parameters<typeof h.client.get>[2]) => {
        seen.push(options);
        return h.client.get(path, query, options);
      },
    };
    const ctx = { ...h.ctx, client };

    await cloudStatus(ctx);
    await boundGet(ctx, DEMO);

    // The status read, then boundGet's own status read and its route call.
    expect(seen).toHaveLength(3);
    for (const options of seen) expect(options?.signal).toBe(h.ctx.signal);
  });
});

