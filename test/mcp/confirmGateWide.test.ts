// test/mcp/confirmGateWide.test.ts — P5's gate in runTool (server/mcp/runTool.ts): every risk that waits for the person
// (`ask`, `destructive`, `outward`; types.ts WAITS_FOR_PERSON) passes it, and an allowed card runs only while what it
// asked about is still what the person saw (Ruling P5-3: the AASC-made `fingerprint` and the target, asked again after
// the allow, on both paths). `ctx.allowedByPerson()` is true only inside a run the person allowed. The fingerprint never
// leaves the book: not in a row, a refusal or a tool answer. The 45 s wait runs on fake timers. Nothing reaches a route
// or a process: /api is a fake client, the activity log an in-memory database, and wsManager (which paired phone is
// connected) a stand-in.
//
// The recheck also compares the card's summary as the book stored it (Ruling P5-34), and a recheck that needs no card
// runs as a call nobody allowed. With the Mac window closed a card still opens when a paired phone can answer it and
// be told (Ruling P5-36); NEEDS_CONFIRMATION names the phone exactly then (P5-25).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { ASK_WAIT_MS, CONFIRM_TTL_MS, createConfirmBook, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, confirmRuleViolations, MCP_MAX_PHASE, type ConfirmAsk, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { systemWriteTools } from '../../server/mcp/tools/systemWrite.js';
import { ToolError, WAITS_FOR_PERSON, type Risk } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { fakeClient, makeCtx, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const phones = vi.hoisted(() => ({ paired: new Set<string>(), asked: 0 }));
vi.mock('../../server/wsManager.js', () => ({
  isPairedPhoneClient: (clientId: string) => {
    phones.asked += 1;
    return phones.paired.has(clientId);
  },
}));

const FINGERPRINT = 'term-w1|pid-4242|fp-secret-c3d9';
const CHANGED = {
  code: 'INVALID',
  message: 'What you asked about changed after the person was asked, so nothing was done.',
  hint: 'Call the tool again: the person is asked about it as it is now.',
};

const macOpen = (): Answer =>
  ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });
/** The Mac's window closed; a remote device (a phone when the test pairs it) connected and saving the workspace. */
const macClosed = (remote: { clientId: string; connections: number }[] = [{ clientId: 'phone-1', connections: 1 }]): Answer =>
  ok({ ok: true, data: { devices: remote.map((d) => ({ ...d, isLocal: false })), workspaceWriter: remote[0]?.clientId ?? null } });

const ON_THE_MAC = 'Waiting for the person to allow it on the Mac.';
const ON_THE_MAC_OR_PHONE = 'Waiting for the person to allow it on the Mac or the paired phone.';
const USED = { code: 'INVALID', message: 'That confirmation was already used, or was not allowed.' };

const confirmWait = systemWriteTools.find((t) => t.name === 'confirm_wait') as ToolDef;

interface Stub {
  def: ToolDef;
  /** What the next `confirm` call answers: the test changes it between the ask and the run. */
  asks: { now: ConfirmAsk | null };
  confirmCalls: number;
  /** `ctx.allowedByPerson()` as each run saw it. */
  runs: boolean[];
}

/**
 * A tool of the test's own with this risk; `confirm` answers `asks.now`, `run` records `allowedByPerson`. Named
 * `demo_end` (Mac-only) unless the test names a phone-answerable tool.
 */
function stubTool(risk: Risk, withConfirm = true, name = 'demo_end'): Stub {
  const stub: Stub = {
    asks: { now: { summary: 'end a session', targetSessionId: 'w1', fingerprint: FINGERPRINT } },
    confirmCalls: 0,
    runs: [],
    def: {
      name,
      toolset: 'sessions',
      title: 'Demo end',
      description: 'A stand-in.',
      risk,
      phase: 5,
      input: { id: z.string() },
      async run(_args, ctx) {
        stub.runs.push(ctx.allowedByPerson());
        return { data: { done: true }, summary: 'done', activity: [{ summary: 'ended a session', targetSessionId: 'w1' }] };
      },
    },
  };
  if (withConfirm) {
    stub.def.confirm = () => {
      stub.confirmCalls += 1;
      return stub.asks.now === null ? null : { ...stub.asks.now };
    };
  }
  return stub;
}

interface WorldOptions {
  /** GET /presence's answer; the Mac's window open by default. */
  presence?: Answer;
  /** The central's card and w1 are shared with remote devices. */
  shared?: boolean;
}

function world(stub: Stub, book: ConfirmBook = createConfirmBook(), opts: WorldOptions = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const remoteVisible = opts.shared === true;
  const sessions: Session[] = [
    makeSession('card-1', {
      terminalId: 'term-card',
      remoteVisible,
      central: { centralId: central.centralId, kind: 'global', scopeRef: null },
    }),
    makeSession('w1', { terminalId: 'term-w1', status: 'waiting', remoteVisible }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  const client = fakeClient({ 'GET /presence': opts.presence ?? macOpen() });
  const deps: McpDeps = {
    registry,
    client: () => client,
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
    confirms: book,
    tools: () => [stub.def, ...systemWriteTools],
  };
  const call = (def: ToolDef, args: Record<string, unknown>) =>
    runTool(def, args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
  const rows = () => t.activity.listActivity().reverse();
  return { call, rows, book, central, t };
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
async function askedAndWaited(w: ReturnType<typeof world>, def: ToolDef): Promise<string> {
  const first = w.call(def, { id: 'w1' });
  await settle(first);
  await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
  return ((await failureOf(first)).data as { confirmId: string }).confirmId;
}

/** Every key anywhere in a value. */
function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  phones.paired = new Set();
  phones.asked = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the phase and the registry rule', () => {
  it('MCP_MAX_PHASE is 6', () => {
    expect(MCP_MAX_PHASE).toBe(6);
    expect([...WAITS_FOR_PERSON].sort()).toEqual(['ask', 'destructive', 'outward']);
  });

  it('a destructive tool without confirm fails the registry check', () => {
    const destructive = stubTool('destructive', false).def;
    const outward = { ...stubTool('outward', false).def, name: 'demo_out' };
    const ask = { ...stubTool('ask', false).def, name: 'demo_ask' };
    const fine = { ...stubTool('destructive').def, name: 'demo_fine' };
    const stray = { ...stubTool('write').def, name: 'demo_write' };

    expect(confirmRuleViolations([destructive, outward, ask, fine, stray])).toEqual([
      'demo_end',
      'demo_out',
      'demo_ask',
      'demo_write',
    ]);
  });
});

describe('the gate for every risk that waits', () => {
  it('a destructive tool waits for the person like an ask tool', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const first = w.call(stub.def, { id: 'w1' });
    await settle(first);
    expect(w.book.pending()).toHaveLength(1);
    expect(w.book.pending()[0]).toMatchObject({ tool: 'demo_end', risk: 'destructive', targetSessionId: 'w1' });

    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);

    expect((await failureOf(first)).code).toBe('NEEDS_CONFIRMATION');
    expect(stub.runs).toEqual([]);
  });

  it('an outward tool without confirm is UNAVAILABLE and never runs', async () => {
    const stub = stubTool('outward', false);
    const w = world(stub);

    expect((await failureOf(w.call(stub.def, { id: 'w1' }))).code).toBe('UNAVAILABLE');
    expect(stub.runs).toEqual([]);
    expect(w.book.pending()).toEqual([]);
  });

  it('an allowed destructive card runs once, after asking confirm again', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect((await call).data).toEqual({ done: true, allowedByPerson: { answeredOn: 'mac' } });
    expect(stub.confirmCalls).toBe(2);
    expect(stub.runs).toEqual([true]);
  });
});

describe('what runs is what the person approved (P5-3)', () => {
  it('a fingerprint that changed after the allow runs nothing (within the wait)', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: 'term-w1|pid-9999' };
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect(await failureOf(call)).toMatchObject(CHANGED);
    expect(stub.runs).toEqual([]);
  });

  it('a fingerprint that changed after the allow runs nothing (through confirm_wait)', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: `${FINGERPRINT}|grew` };

    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject(CHANGED);
    expect(stub.runs).toEqual([]);
  });

  it('a fingerprint that appears or goes away is a change too', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1' };

    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject(CHANGED);
    expect(stub.runs).toEqual([]);
  });

  it('a changed targetSessionId runs nothing', async () => {
    const stub = stubTool('ask');
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w2', fingerprint: FINGERPRINT };
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect(await failureOf(call)).toMatchObject(CHANGED);

    // Through confirm_wait, a target that went away.
    const later = stubTool('ask');
    const l = world(later);
    const confirmId = await askedAndWaited(l, later.def);
    l.book.answer(l.book.pending()[0].cardId, 'allow');
    later.asks.now = { summary: 'end a session', targetSessionId: null, fingerprint: FINGERPRINT };
    expect(await failureOf(l.call(confirmWait, { confirmId }))).toMatchObject(CHANGED);

    expect([...stub.runs, ...later.runs]).toEqual([]);
  });

  it('a fingerprint past 200 characters is kept and compared as a digest of the whole of it', async () => {
    const stub = stubTool('destructive');
    const long = 'x'.repeat(250);
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: long };
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    expect(w.book.pending()[0].fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    expect((await call).data).toEqual({ done: true, allowedByPerson: { answeredOn: 'mac' } });

    // Only the tail past 200 changed: still a change.
    const tail = stubTool('destructive');
    tail.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: long };
    const t = world(tail);
    const later = t.call(tail.def, { id: 'w1' });
    await settle(later);
    tail.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: `${long}|late-item` };
    t.book.answer(t.book.pending()[0].cardId, 'allow');
    expect(await failureOf(later)).toMatchObject(CHANGED);
    expect(tail.runs).toEqual([]);
  });

  it('a recheck that answers null runs, as a call nobody allowed', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = null;

    expect((await w.call(confirmWait, { confirmId })).data).toEqual({ done: true, confirmId });
    expect(stub.runs).toEqual([false]);

    // Within the wait too.
    const inline = stubTool('destructive');
    const i = world(inline);
    const call = i.call(inline.def, { id: 'w1' });
    await settle(call);
    inline.asks.now = null;
    i.book.answer(i.book.pending()[0].cardId, 'allow');
    expect((await call).data).toEqual({ done: true });
    expect(inline.runs).toEqual([false]);
  });

  it('a summary that changed after the allow runs nothing (within the wait)', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    stub.asks.now = { summary: 'end a session (it is pinned: a kill unpins it)', targetSessionId: 'w1', fingerprint: FINGERPRINT };
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect(await failureOf(call)).toMatchObject(CHANGED);
    expect(stub.runs).toEqual([]);
  });

  it('a summary that changed after the allow runs nothing (through confirm_wait)', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = { summary: 'end a session (it is pinned: a kill unpins it)', targetSessionId: 'w1', fingerprint: FINGERPRINT };

    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject(CHANGED);
    expect(stub.runs).toEqual([]);
    const refused = w.rows().filter((r) => r.tool === 'demo_end' && r.outcome === 'refused');
    expect(refused.map((r) => r.summary)).toEqual([`Refused (INVALID): ${CHANGED.message}`]);
  });

  it('the summary is compared as the book stored it (cut and scrubbed the same way)', async () => {
    const stub = stubTool('destructive');
    const long = `end   a\nsession ${'y'.repeat(400)}`;
    stub.asks.now = { summary: long, targetSessionId: 'w1', fingerprint: FINGERPRINT };
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    expect(w.book.forCentral(confirmId, w.central.centralId)?.summary.length).toBeLessThanOrEqual(300);
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect((await w.call(confirmWait, { confirmId })).data).toEqual({ done: true, confirmId, allowedByPerson: { answeredOn: 'mac' } });
    expect(stub.runs).toEqual([true]);
  });

  it('a CHANGED refusal writes a refused row and consumes the record', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: 'other' };

    await failureOf(w.call(confirmWait, { confirmId }));
    // Asking again with the same id does not run it either: the record was used.
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: FINGERPRINT };
    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject({
      code: 'INVALID',
      message: 'That confirmation was already used, or was not allowed.',
    });

    expect(stub.runs).toEqual([]);
    const ends = w.rows().filter((r) => r.tool === 'demo_end').map((r) => [r.outcome, r.summary, r.targetSessionId]);
    expect(ends).toEqual([
      ['ok', 'asked the person: end a session', 'w1'],
      ['ok', 'allowed by the person: end a session', 'w1'],
      ['refused', `Refused (INVALID): ${CHANGED.message}`, 'w1'],
    ]);
  });
});

describe('allowedByPerson', () => {
  it('allowedByPerson is true only inside an allowed run', async () => {
    // A confirm that needs no card.
    const free = stubTool('destructive');
    free.asks.now = null;
    await world(free).call(free.def, { id: 'w1' });
    // A plain write (no gate).
    const write = stubTool('write', false);
    await world(write).call(write.def, { id: 'w1' });
    // Allowed within the wait, and through confirm_wait.
    const inline = stubTool('ask');
    const a = world(inline);
    const call = a.call(inline.def, { id: 'w1' });
    await settle(call);
    a.book.answer(a.book.pending()[0].cardId, 'allow');
    await call;
    const later = stubTool('outward');
    const b = world(later);
    const confirmId = await askedAndWaited(b, later.def);
    b.book.answer(b.book.pending()[0].cardId, 'allow');
    await b.call(confirmWait, { confirmId });

    expect(free.runs).toEqual([false]);
    expect(write.runs).toEqual([false]);
    expect(inline.runs).toEqual([true]);
    expect(later.runs).toEqual([true]);
  });

  it('two interleaved calls of one central each see their own box', async () => {
    const stub = stubTool('destructive');
    // Each run waits until the test lets it go, so both calls are inside `run` at once.
    const release: Array<() => void> = [];
    stub.def.run = async (args, ctx) => {
      await new Promise<void>((done) => release.push(done));
      stub.runs.push(ctx.allowedByPerson());
      return { data: { id: args.id }, summary: 'done', activity: [{ summary: 'ended a session', targetSessionId: 'w1' }] };
    };
    stub.def.confirm = (args) => (args.id === 'free' ? null : { summary: 'end a session', targetSessionId: 'w1', fingerprint: FINGERPRINT });
    const w = world(stub);
    const allowed = w.call(stub.def, { id: 'w1' });
    await settle(allowed);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    await vi.advanceTimersByTimeAsync(0);
    const unasked = w.call(stub.def, { id: 'free' });
    await settle(unasked);
    expect(release).toHaveLength(2);
    // The call nobody allowed finishes first, while the allowed one is still running; then the allowed one.
    release[1]();
    await vi.advanceTimersByTimeAsync(0);
    release[0]();

    expect((await unasked).data).toEqual({ id: 'free' });
    expect((await allowed).data).toEqual({ id: 'w1', allowedByPerson: { answeredOn: 'mac' } });
    expect(stub.runs).toEqual([false, true]);
  });
});

describe('what goes wrong inside the recheck', () => {
  it('a CHANGED call within the wait used the record: a bare confirm_wait after it is INVALID and runs nothing', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: 'term-w1|pid-9999' };
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    expect(await failureOf(call)).toMatchObject(CHANGED);

    // Back as it was: still nothing runs, the record is used.
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: FINGERPRINT };
    expect(await failureOf(w.call(confirmWait, {}))).toMatchObject(USED);
    expect(stub.runs).toEqual([]);
  });

  it('a confirm that refuses during the recheck runs nothing, writes one refused row, and uses the record', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    const handsOff = new ToolError('DENIED', 'The person keeps that session to themselves.', 'Leave it alone.');
    stub.def.confirm = () => {
      throw handsOff;
    };

    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject({ code: 'DENIED', message: handsOff.message });
    expect(stub.runs).toEqual([]);
    const refused = w.rows().filter((r) => r.tool === 'demo_end' && r.outcome === 'refused');
    expect(refused.map((r) => r.summary)).toEqual([`Refused (DENIED): ${handsOff.message}`]);

    stub.def.confirm = () => ({ summary: 'end a session', targetSessionId: 'w1', fingerprint: FINGERPRINT });
    expect(await failureOf(w.call(confirmWait, { confirmId }))).toMatchObject(USED);
    expect(stub.runs).toEqual([]);
  });
});

describe('where the person answered (D-5)', () => {
  const answerRows = (w: ReturnType<typeof world>) =>
    w
      .rows()
      .filter((r) => r.tool === 'session_kill' && (r.summary.startsWith('allowed by the person') || r.outcome === 'refused'))
      .map((r) => [r.outcome, r.detail]);

  it('an allow within the wait says the phone or the Mac', async () => {
    const onPhone = stubTool('destructive', true, 'session_kill');
    const p = world(onPhone, createConfirmBook(), { shared: true });
    const call = p.call(onPhone.def, { id: 'w1' });
    await settle(call);
    p.book.answer(p.book.pending()[0].cardId, 'allow', 'phone');
    await call;
    const onMac = stubTool('destructive', true, 'session_kill');
    const m = world(onMac);
    const macCall = m.call(onMac.def, { id: 'w1' });
    await settle(macCall);
    m.book.answer(m.book.pending()[0].cardId, 'allow');
    await macCall;

    expect(answerRows(p)).toEqual([['ok', { answeredOn: 'phone' }]]);
    expect(answerRows(m)).toEqual([['ok', { answeredOn: 'mac' }]]);
  });

  it('a later answer says where; a card nobody answered says nothing of it', async () => {
    const denied = stubTool('destructive', true, 'session_kill');
    const d = world(denied, createConfirmBook(), { shared: true });
    await askedAndWaited(d, denied.def);
    d.book.answer(d.book.pending()[0].cardId, 'deny', 'phone');
    const allowed = stubTool('destructive', true, 'session_kill');
    const a = world(allowed, createConfirmBook(), { shared: true });
    await askedAndWaited(a, allowed.def);
    a.book.answer(a.book.pending()[0].cardId, 'allow', 'phone');
    const expired = stubTool('destructive', true, 'session_kill');
    const e = world(expired);
    await askedAndWaited(e, expired.def);
    await vi.advanceTimersByTimeAsync(CONFIRM_TTL_MS);

    expect(answerRows(d)).toEqual([['refused', { code: 'DENIED', answeredOn: 'phone' }]]);
    expect(answerRows(a)).toEqual([['ok', { answeredOn: 'phone' }]]);
    expect(answerRows(e)).toEqual([['refused', { code: 'DENIED' }]]);
  });

  // P5-40 (live check): an allow inside the wait used to look, to the model, like a call that never asked.
  it("an allowed call's data says the person allowed it, and where; an unasked call's data does not", async () => {
    const onPhone = stubTool('destructive', true, 'session_kill');
    const p = world(onPhone, createConfirmBook(), { shared: true });
    const call = p.call(onPhone.def, { id: 'w1' });
    await settle(call);
    p.book.answer(p.book.pending()[0].cardId, 'allow', 'phone');
    const unasked = stubTool('destructive', true, 'session_kill');
    unasked.asks.now = null;
    const u = world(unasked);

    expect((await call).data).toEqual({ done: true, allowedByPerson: { answeredOn: 'phone' } });
    expect((await u.call(unasked.def, { id: 'w1' })).data).toEqual({ done: true });
  });

  it('a call carried out by confirm_wait says so too', async () => {
    const stub = stubTool('destructive', true, 'session_kill');
    const w = world(stub);
    const confirmId = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    const out = await w.call(confirmWait, { confirmId });
    expect(JSON.stringify(out.data)).toContain('"allowedByPerson":{"answeredOn":"mac"}');
  });
});

describe('the tool harness carries out an approved call as the gate does (A-4)', () => {
  const ASKED = { summary: 'rename a saved prompt', targetSessionId: null };

  /** An allowed, unused record of the registered `snippet_rename` for the harness's central, its confirm and run spied. */
  function approvedRename(next: ConfirmAsk | null) {
    const tool = allTools().find((t) => t.name === 'snippet_rename') as ToolDef;
    const seen: boolean[] = [];
    // The context each step was handed: the recheck and the run get the same one, as in runTool.
    const contexts: { confirm: unknown[]; run: unknown[] } = { confirm: [], run: [] };
    const confirm = vi.spyOn(tool, 'confirm').mockImplementation((_args, ctx) => {
      contexts.confirm.push(ctx);
      return next;
    });
    const runSpy = vi.spyOn(tool, 'run').mockImplementation(async (_args, ctx) => {
      contexts.run.push(ctx);
      seen.push(ctx.allowedByPerson());
      return { data: { renamed: true }, summary: 'renamed' };
    });
    const h = makeCtx();
    const record = h.confirmBook.open({ centralId: h.ctx.central.centralId, tool: 'snippet_rename', risk: 'ask', args: { id: 7, label: 'x' }, ...ASKED });
    h.confirmBook.answer(record.cardId, 'allow');
    return { h, record, seen, contexts, restore: () => (confirm.mockRestore(), runSpy.mockRestore()) };
  }

  it('a card that changed after the allow is CHANGED and runs nothing', async () => {
    const a = approvedRename({ ...ASKED, summary: 'rename a saved prompt (and another)' });
    try {
      expect(await failureOf(a.h.ctx.confirms.runApproved(a.record.confirmId))).toMatchObject(CHANGED);
      expect(a.seen).toEqual([]);
      expect(await failureOf(a.h.ctx.confirms.runApproved(a.record.confirmId))).toMatchObject(USED);
    } finally {
      a.restore();
    }
  });

  it('the same card runs with allowedByPerson true; one that needs no card now runs with it false', async () => {
    const same = approvedRename({ ...ASKED });
    try {
      expect((await same.h.ctx.confirms.runApproved(same.record.confirmId)).data).toEqual({ renamed: true });
      expect(same.seen).toEqual([true]);
      expect(same.contexts.confirm).toHaveLength(1);
      expect(same.contexts.run[0]).toBe(same.contexts.confirm[0]);
    } finally {
      same.restore();
    }
    const none = approvedRename(null);
    try {
      await none.h.ctx.confirms.runApproved(none.record.confirmId);
      expect(none.seen).toEqual([false]);
    } finally {
      none.restore();
    }
  });
});

describe('a card a paired phone can answer (P5-25, P5-36)', () => {
  /** A phone-answerable tool (its name is in PHONE_ANSWERABLE) about w1. */
  const phoneTool = (): Stub => stubTool('destructive', true, 'session_kill');

  it('the window closed, the card phone-answerable and shared, a paired phone connected: the card opens', async () => {
    phones.paired = new Set(['phone-1']);
    const stub = phoneTool();
    const w = world(stub, createConfirmBook(), { presence: macClosed(), shared: true });
    const call = w.call(stub.def, { id: 'w1' });
    await settle(call);
    // Asking wsManager loads it first: a few turns, not one.
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    expect(phones.asked).toBe(1);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);

    expect(await failureOf(call)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC_OR_PHONE });
    expect(stub.runs).toEqual([]);
  });

  it('the window closed and a Mac-only card: NO_WINDOW, no card, even with a paired phone connected', async () => {
    phones.paired = new Set(['phone-1']);
    const stub = stubTool('destructive');
    const w = world(stub, createConfirmBook(), { presence: macClosed(), shared: true });

    expect((await failureOf(w.call(stub.def, { id: 'w1' }))).code).toBe('NO_WINDOW');
    expect(w.book.pending()).toEqual([]);
    expect(phones.asked).toBe(0);
  });

  it('the window closed and no paired phone to tell: NO_WINDOW (fails closed)', async () => {
    const stub = phoneTool();
    // A remote device that is no paired phone (a password sign-in).
    const browser = world(stub, createConfirmBook(), { presence: macClosed(), shared: true });
    expect((await failureOf(browser.call(stub.def, { id: 'w1' }))).code).toBe('NO_WINDOW');
    // A paired phone with no connection open.
    phones.paired = new Set(['phone-1']);
    const gone = world(stub, createConfirmBook(), { presence: macClosed([{ clientId: 'phone-1', connections: 0 }]), shared: true });
    expect((await failureOf(gone.call(stub.def, { id: 'w1' }))).code).toBe('NO_WINDOW');
    // No device at all.
    const none = world(stub, createConfirmBook(), { presence: macClosed([]), shared: true });
    expect((await failureOf(none.call(stub.def, { id: 'w1' }))).code).toBe('NO_WINDOW');

    expect([...browser.book.pending(), ...gone.book.pending(), ...none.book.pending()]).toEqual([]);
    expect(stub.runs).toEqual([]);
  });

  it('the window closed, a phone connected, but the sessions not shared: NO_WINDOW', async () => {
    phones.paired = new Set(['phone-1']);
    const stub = phoneTool();
    const w = world(stub, createConfirmBook(), { presence: macClosed(), shared: false });

    expect((await failureOf(w.call(stub.def, { id: 'w1' }))).code).toBe('NO_WINDOW');
    expect(w.book.pending()).toEqual([]);
  });

  it('the window open: NEEDS_CONFIRMATION names the phone exactly when the card is phone-answerable', async () => {
    const mac = stubTool('destructive');
    const m = world(mac, createConfirmBook(), { shared: true });
    const macOnly = m.call(mac.def, { id: 'w1' });
    await settle(macOnly);
    const phone = phoneTool();
    const p = world(phone, createConfirmBook(), { shared: true });
    const either = p.call(phone.def, { id: 'w1' });
    await settle(either);
    const unshared = phoneTool();
    const u = world(unshared, createConfirmBook(), { shared: false });
    const hidden = u.call(unshared.def, { id: 'w1' });
    await settle(hidden);
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);

    expect(await failureOf(macOnly)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC });
    expect(await failureOf(either)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC_OR_PHONE });
    expect(await failureOf(hidden)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC });
  });

  it('confirm_wait still waiting names the phone the same way', async () => {
    const phone = phoneTool();
    const p = world(phone, createConfirmBook(), { shared: true });
    const phoneId = await askedAndWaited(p, phone.def);
    const mac = stubTool('destructive');
    const m = world(mac, createConfirmBook(), { shared: true });
    const macId = await askedAndWaited(m, mac.def);

    const phoneWait = p.call(confirmWait, { confirmId: phoneId, timeoutSec: 1 });
    const macWait = m.call(confirmWait, { confirmId: macId, timeoutSec: 1 });
    await settle(phoneWait);
    await settle(macWait);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await failureOf(phoneWait)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC_OR_PHONE });
    expect(await failureOf(macWait)).toMatchObject({ code: 'NEEDS_CONFIRMATION', message: ON_THE_MAC });
  });
});

describe('the fingerprint stays in the book', () => {
  it('the fingerprint is in no row, refusal data or tool answer', async () => {
    const stub = stubTool('destructive');
    const w = world(stub);
    const needs = await failureOf(
      (async () => {
        const first = w.call(stub.def, { id: 'w1' });
        await settle(first);
        await vi.advanceTimersByTimeAsync(ASK_WAIT_MS);
        return first;
      })(),
    );
    const confirmId = (needs.data as { confirmId: string }).confirmId;
    expect(w.book.forCentral(confirmId, w.central.centralId)?.fingerprint).toBe(FINGERPRINT);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    const answer = await w.call(confirmWait, { confirmId });
    // A changed one: its refusal says nothing of either fingerprint.
    const again = await askedAndWaited(w, stub.def);
    w.book.answer(w.book.pending()[0].cardId, 'allow');
    stub.asks.now = { summary: 'end a session', targetSessionId: 'w1', fingerprint: 'fp-new-a81c' };
    const changed = await failureOf(w.call(confirmWait, { confirmId: again }));

    const everything = [needs.data, { ...needs }, answer, { ...changed, message: changed.message, hint: changed.hint }, w.t.rawRows(), w.rows()];
    const dump = JSON.stringify(everything);
    expect(keysOf(everything).has('fingerprint')).toBe(false);
    expect(dump).not.toContain(FINGERPRINT);
    expect(dump).not.toContain('fp-new-a81c');
  });
});
