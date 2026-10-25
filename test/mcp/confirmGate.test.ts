// test/mcp/confirmGate.test.ts — the confirmation gate in runTool (server/mcp/runTool.ts) and `confirm_wait`
// (server/mcp/tools/systemWrite.ts): an `ask` tool waits for the person on the Mac; an approved call runs once, with
// the arguments the person saw; a denied, expired or used one never runs. The 45 s and 5 min waits run on fake timers.
// Nothing reaches a route or a process: /api is a fake client, the activity log an in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { ASK_WAIT_MS, CONFIRM_TTL_MS, createConfirmBook, needsConfirmation, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, confirmRuleViolations, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { systemWriteTools } from '../../server/mcp/tools/systemWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput, roomInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { runCleanups } from './endpointHarness.js';
import { connectAs, freshWorld, startWorld } from './resourceWorld.js';
import { fakeClient, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const SECRET_ARG = 'the-central-wrote-this-9f2c';
const SECRET_DETAIL = 'detail-the-person-reads-71aa';

const macOpen = (): Answer =>
  ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });
const macClosed = (): Answer =>
  ok({ ok: true, data: { devices: [{ clientId: 'phone-1', isLocal: false, connections: 1 }], workspaceWriter: 'phone-1' } });

const confirmWait = systemWriteTools.find((t) => t.name === 'confirm_wait') as ToolDef;

interface AskStub {
  def: ToolDef;
  runs: Array<Record<string, unknown>>;
}

/** An ask tool of the test's own: `confirm` says what the person is asked (null: nothing), `run` records its args. */
function askTool(confirm: ToolDef['confirm'] = (args) => ({ summary: 'rename a snippet', detail: SECRET_DETAIL, targetSessionId: (args.id as string) ?? null })): AskStub {
  const runs: Array<Record<string, unknown>> = [];
  return {
    runs,
    def: {
      name: 'demo_ask',
      toolset: 'snippets',
      title: 'Demo ask',
      description: 'A stand-in.',
      risk: 'ask',
      phase: 3,
      input: { id: z.string(), text: z.string().optional() },
      confirm,
      async run(args) {
        runs.push({ ...args });
        return { data: { done: true, id: args.id }, summary: 'done', activity: [{ summary: 'renamed a snippet', targetSessionId: 'w1' }] };
      },
    },
  };
}

function world(o: { presence?: Answer; ask?: AskStub; book?: ConfirmBook } = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const other = registry.mint(roomInput('r1'));
  const sessions: Session[] = [
    makeSession('card-1', { terminalId: 'term-card', central: { centralId: central.centralId, kind: 'global', scopeRef: null } }),
    makeSession('w1', { terminalId: 'term-w1', status: 'waiting' }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  const book = o.book ?? createConfirmBook();
  const ask = o.ask ?? askTool();
  const client = fakeClient({ 'GET /presence': o.presence ?? macOpen() });
  const deps: McpDeps = {
    registry,
    client: () => client,
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
    confirms: book,
    tools: () => [ask.def, ...systemWriteTools],
  };
  const call = (def: ToolDef, args: Record<string, unknown>, centralId = central.centralId, signal = neverAborted) =>
    runTool(def, args, { centralId, deps, signal, via: 'call' });
  const rows = () => t.activity.listActivity().reverse();
  return { call, rows, book, ask, client, central, other, t, deps };
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

/**
 * Lets a call that was started reach its wait (the presence read and the book's open are a few microtasks in). Its
 * refusal is still read later through `failureOf`; marking it handled here keeps it from being reported unhandled.
 */
async function settle(p: Promise<unknown>): Promise<void> {
  p.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await runCleanups();
});

describe('the registry rule', () => {
  it('an ask tool without confirm fails the registry check', () => {
    const missing = { ...askTool().def, confirm: undefined };
    const stray: ToolDef = { ...askTool().def, name: 'demo_write', risk: 'write' };

    expect(confirmRuleViolations([missing, stray, askTool().def])).toEqual(['demo_ask', 'demo_write']);
    expect(confirmRuleViolations(allTools())).toEqual([]);
  });

  it('an ask tool without confirm is refused at the gate, and never runs', async () => {
    const ask = askTool();
    const w = world({ ask: { ...ask, def: { ...ask.def, confirm: undefined } } });
    expect((await failureOf(w.call(w.ask.def, { id: 'w1' }))).code).toBe('UNAVAILABLE');
    expect(ask.runs).toEqual([]);
  });
});

describe('the gate', () => {
  it('confirm returning null runs at once and opens nothing', async () => {
    const w = world({ ask: askTool(() => null) });
    const result = await w.call(w.ask.def, { id: 'w1' });

    expect(result.data).toEqual({ done: true, id: 'w1' });
    expect(w.book.pending()).toEqual([]);
    expect(w.client.calls).toEqual([]);
  });

  it('no Mac window is NO_WINDOW and opens nothing', async () => {
    const w = world({ presence: macClosed() });
    const err = await failureOf(w.call(w.ask.def, { id: 'w1' }));

    expect(err).toMatchObject({ code: 'NO_WINDOW', message: 'Nobody can answer on the Mac now: its AASC window is closed.' });
    expect(w.book.pending()).toEqual([]);
    expect(w.ask.runs).toEqual([]);
    // A presence read that fails is no window either.
    const broken = world({ presence: { ok: false, status: 500, data: null, error: 'boom' } });
    expect((await failureOf(broken.call(broken.ask.def, { id: 'w1' }))).code).toBe('NO_WINDOW');
  });

  it('allowed within the wait runs the tool once', async () => {
    const w = world();
    const call = w.call(w.ask.def, { id: 'w1', text: 'new name' });
    await settle(call);
    expect(w.book.pending()).toHaveLength(1);

    w.book.answer(w.book.pending()[0].cardId, 'allow');
    const result = await call;

    expect(result.data).toEqual({ done: true, id: 'w1', allowedByPerson: { answeredOn: 'mac' } });
    expect(w.ask.runs).toEqual([{ id: 'w1', text: 'new name' }]);
    // The record is used: confirm_wait cannot carry it out again.
    const err = await failureOf(w.call(confirmWait, {}));
    expect(err.code).toBe('INVALID');
    expect(w.ask.runs).toHaveLength(1);
  });

  it('pending after 45 s is NEEDS_CONFIRMATION with confirmId and expiresAt in structuredContent.data', async () => {
    const w = world();
    const call = w.call(w.ask.def, { id: 'w1' });
    await settle(call);
    const record = w.book.pending()[0];

    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const err = await failureOf(call);

    expect(err).toMatchObject({
      code: 'NEEDS_CONFIRMATION',
      message: 'Waiting for the person to allow it on the Mac.',
      hint: 'Tell the person, then call confirm_wait with this confirmId.',
      data: { confirmId: record.confirmId, expiresAt: NOW + CONFIRM_TTL_MS },
    });
    // The Mac's card id never reaches the central.
    expect(JSON.stringify(err.data)).not.toContain(record.cardId);
    expect(w.ask.runs).toEqual([]);
  });

  it('a refusal’s data reaches the central in structuredContent.data and in the text (Ruling 66)', async () => {
    vi.useRealTimers();
    const stub: ToolDef = {
      name: 'session_list',
      toolset: 'sessions',
      title: 'Stub',
      description: 'A stand-in.',
      risk: 'read',
      phase: 1,
      input: {},
      run: async () => {
        throw needsConfirmation({ confirmId: 'c0ffee-id', expiresAt: 1_234 });
      },
    };
    const started = await startWorld(freshWorld(), { tools: () => [stub] });
    const { client } = await connectAs(started, globalInput());

    const answer = await client.callTool({ name: 'session_list', arguments: {} });

    expect(answer.isError).toBe(true);
    expect(answer.structuredContent).toEqual({
      ok: false,
      code: 'NEEDS_CONFIRMATION',
      message: 'Waiting for the person to allow it on the Mac.',
      hint: 'Tell the person, then call confirm_wait with this confirmId.',
      data: { confirmId: 'c0ffee-id', expiresAt: 1_234 },
    });
    const text = (answer.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('\nconfirmId: c0ffee-id');
    expect(text).toContain('\nexpiresAt: 1234');
  });

  it('confirm_wait runs the stored arguments once', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1', text: 'what the person saw' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };

    const waiting = w.call(confirmWait, { confirmId, timeoutSec: 30 });
    await settle(waiting);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    const result = await waiting;

    expect(w.ask.runs).toEqual([{ id: 'w1', text: 'what the person saw' }]);
    expect(result.data).toEqual({ done: true, id: 'w1', confirmId, allowedByPerson: { answeredOn: 'mac' } });
  });

  it('a second confirm_wait on a used id is INVALID', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    await w.call(confirmWait, { confirmId });
    const again = await failureOf(w.call(confirmWait, { confirmId }));

    expect(again).toMatchObject({ code: 'INVALID', message: 'That confirmation was already used, or was not allowed.' });
    expect(w.ask.runs).toHaveLength(1);
  });

  it('a denied or expired confirmation never runs the tool', async () => {
    // Denied within the wait.
    const a = world();
    const denied = a.call(a.ask.def, { id: 'w1' });
    await settle(denied);
    a.book.answer(a.book.pending()[0].cardId, 'deny');
    expect(await failureOf(denied)).toMatchObject({
      code: 'DENIED',
      message: 'The person said no.',
      hint: 'Do not ask again unless the person asks you to.',
    });

    // Expired, then waited on.
    const b = world();
    const first = b.call(b.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };
    await vi.advanceTimersByTimeAsync(CONFIRM_TTL_MS);
    expect(await failureOf(b.call(confirmWait, { confirmId }))).toMatchObject({
      code: 'DENIED',
      message: 'The person did not answer within 5 minutes.',
    });

    // Denied later, then waited on.
    const c = world();
    const late = c.call(c.ask.def, { id: 'w1' });
    await settle(late);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const later = (await failureOf(late)).data as { confirmId: string };
    c.book.answer(c.book.pending()[0].cardId, 'deny');
    expect((await failureOf(c.call(confirmWait, { confirmId: later.confirmId }))).code).toBe('DENIED');

    expect([...a.ask.runs, ...b.ask.runs, ...c.ask.runs]).toEqual([]);
  });

  it('confirm_wait without an id takes the central’s newest', async () => {
    const w = world();
    const one = w.call(w.ask.def, { id: 'first' });
    await settle(one);
    await vi.advanceTimersByTimeAsync(10);
    const two = w.call(w.ask.def, { id: 'second' });
    await settle(two);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    await failureOf(one);
    const newest = (await failureOf(two)).data as { confirmId: string };

    const waiting = w.call(confirmWait, {});
    await settle(waiting);
    const card = w.book.pending().find((p) => p.confirmId === newest.confirmId);
    w.book.answer(card?.cardId ?? '', 'allow');
    const result = await waiting;

    expect(w.ask.runs).toEqual([{ id: 'second' }]);
    expect(result.data).toMatchObject({ confirmId: newest.confirmId });
  });

  it('confirm_wait at its timeout is NEEDS_CONFIRMATION with the same data', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const data = (await failureOf(first)).data;

    const waiting = w.call(confirmWait, { timeoutSec: 5 });
    await settle(waiting);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await failureOf(waiting)).toMatchObject({ code: 'NEEDS_CONFIRMATION', data });
  });

  it('another central’s confirmId is NOT_FOUND', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    const err = await failureOf(w.call(confirmWait, { confirmId }, w.other.centralId));

    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).not.toContain(confirmId);
    expect(w.ask.runs).toEqual([]);
    // Nor can it carry one out by naming nothing.
    expect((await failureOf(w.call(confirmWait, {}, w.other.centralId))).code).toBe('NOT_FOUND');
  });

  it('confirm’s own refusal (out of scope) opens no card', async () => {
    const w = world({
      ask: askTool(() => {
        throw new ToolError('NOT_IN_SCOPE', 'That session is outside your scope.', 'Call session_list.');
      }),
    });

    expect((await failureOf(w.call(w.ask.def, { id: 'w1' }))).code).toBe('NOT_IN_SCOPE');
    expect(w.book.pending()).toEqual([]);
    expect(w.client.calls).toEqual([]);
  });

  it('activity rows: asked, then the tool’s own row; denied is a refused row; no row holds args or detail', async () => {
    const w = world();
    const allowed = w.call(w.ask.def, { id: 'w1', text: SECRET_ARG });
    await settle(allowed);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    await allowed;

    const denied = w.call(w.ask.def, { id: 'w1', text: SECRET_ARG });
    await settle(denied);
    w.book.answer(w.book.pending()[0].cardId, 'deny');
    await failureOf(denied);

    // Timed out (no row), then expired later (a refused row).
    const late = w.call(w.ask.def, { id: 'w1', text: SECRET_ARG });
    await settle(late);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    await failureOf(late);
    await vi.advanceTimersByTimeAsync(CONFIRM_TTL_MS);

    const rows = w.rows().map((r) => [r.tool, r.outcome, r.summary, r.targetSessionId]);
    expect(rows).toEqual([
      ['demo_ask', 'ok', 'asked the person: rename a snippet', 'w1'],
      ['demo_ask', 'ok', 'allowed by the person: rename a snippet', 'w1'],
      ['demo_ask', 'ok', 'renamed a snippet', 'w1'],
      ['demo_ask', 'ok', 'asked the person: rename a snippet', 'w1'],
      ['demo_ask', 'refused', 'Refused (DENIED): The person said no.', 'w1'],
      ['demo_ask', 'ok', 'asked the person: rename a snippet', 'w1'],
      ['demo_ask', 'refused', 'Refused (DENIED): The person did not answer within 5 minutes.', 'w1'],
    ]);
    const dump = JSON.stringify(w.t.rawRows());
    expect(dump).not.toContain(SECRET_ARG);
    expect(dump).not.toContain(SECRET_DETAIL);
    for (const r of w.book.pending()) expect(dump).not.toContain(r.cardId);
  });

  it('a card allowed after the call answered NEEDS_CONFIRMATION writes its allowed row even if the central never returns (A-M2)', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    await failureOf(first);

    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect(w.rows().map((r) => [r.outcome, r.summary])).toEqual([
      ['ok', 'asked the person: rename a snippet'],
      ['ok', 'allowed by the person: rename a snippet'],
    ]);
    expect(w.ask.runs).toEqual([]);
  });

  it('a central revoked while its card waits is a withdrawn row, not "The person said no." (A-M2)', async () => {
    // Inside the call's own wait.
    const a = world();
    const inline = a.call(a.ask.def, { id: 'w1' });
    await settle(inline);
    a.book.forgetCentral(a.central.centralId);
    const refusal = await failureOf(inline);
    expect(refusal.code).toBe('UNAVAILABLE');
    expect(refusal.message).toContain('withdrawn');
    expect(a.rows().map((r) => [r.outcome, r.summary])).toEqual([
      ['ok', 'asked the person: rename a snippet'],
      ['refused', `Refused (UNAVAILABLE): ${refusal.message}`],
    ]);

    // After the call answered NEEDS_CONFIRMATION.
    const b = world();
    const first = b.call(b.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };
    b.book.forgetCentral(b.central.centralId);
    const rows = b.rows().map((r) => r.summary);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('withdrawn');
    expect(rows.join('\n')).not.toContain('said no');
    // The windows still saw it denied; confirm_wait tells the central it was withdrawn.
    expect(b.book.forCentral(confirmId, b.central.centralId)).toMatchObject({ state: 'denied', withdrawn: true });
    expect((await failureOf(b.call(confirmWait, { confirmId }))).code).toBe('UNAVAILABLE');
  });

  it('an approved run is only the record’s own tool, for its own central', async () => {
    const w = world();
    const first = w.call(w.ask.def, { id: 'w1' });
    await settle(first);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
    const { confirmId } = (await failureOf(first)).data as { confirmId: string };
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    w.book.consume(confirmId, w.central.centralId);

    // Naming a used id as `approved` for another tool does not skip that tool's gate.
    const other = askTool();
    const asked = runTool({ ...other.def, name: 'demo_other' }, { id: 'w1' }, {
      centralId: w.central.centralId,
      deps: w.deps,
      signal: neverAborted,
      via: 'call',
      approved: confirmId,
    });
    await settle(asked);
    expect(w.book.pending()).toHaveLength(1);
    expect(w.book.pending()[0].tool).toBe('demo_other');
    w.book.answer(w.book.pending()[0].cardId, 'deny');
    expect((await failureOf(asked)).code).toBe('DENIED');
    expect(other.runs).toEqual([]);
  });
});

