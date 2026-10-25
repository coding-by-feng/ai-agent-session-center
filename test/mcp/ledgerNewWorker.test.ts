// test/mcp/ledgerNewWorker.test.ts — what P4 adds to the task ledger (server/mcp/ledger.ts, ledgerReroute.ts): a new
// worker's first task waits for the worker to start (Ruling P4-6: the prompt route refuses a `connecting` card), a task
// AASC routed itself is re-routed once when its worker's terminal exits before its turn stopped (Ruling P4-7), and
// task_cancel ends a task still waiting on its new worker with nothing typed (Ruling P4-16). Also the view the window
// gets (deliver.ts `toTaskView`). The ledger's other behaviour: ledger.test.ts, ledgerWhoseTurn.test.ts.
// Fake deps and fake timers throughout: nothing reaches a terminal or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { toTaskView } from '../../server/mcp/deliver.js';
import {
  AGENT_GONE_MS,
  createLedger,
  envelopeHead,
  isRetargetable,
  NEW_WORKER_START_MS,
  START_POLL_MS,
  STOP_SETTLE_MS,
  TICK_MS,
  type Ledger,
  type SubmitAnswer,
  type TaskRecord,
} from '../../server/mcp/ledger.js';
import { ToolError } from '../../server/mcp/types.js';
import { deliverCtx } from './deliverToolFixtures.js';
import { fakeLedgerDeps, type FakeLedgerDeps } from './ledgerFixtures.js';
import { makeCentral, makeSession, NOW, run } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const central = makeCentral();
const other = makeCentral('room', 'r1', { centralId: 'central-2', terminalId: 'term-c2' });
const AUTO = { by: 'auto', decision: 'create', reasons: ['no idle session in the project', 'opened claude in /a/proj'] } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function setup(): { f: FakeLedgerDeps; ledger: Ledger } {
  const f = fakeLedgerDeps();
  return { f, ledger: createLedger(f.deps) };
}

/** A worker AASC has just opened: its card still has the terminal's id, and it is connecting. */
const starting = (f: FakeLedgerDeps, id = 'term-1'): Session =>
  f.setSession(makeSession(id, { terminalId: id, status: 'connecting' }));

/** The worker's CLI starts: its card is re-keyed to the CLI's id, then its SessionStart arrives. */
function startUp(f: FakeLedgerDeps, from = 'term-1', to = 'cli-abc'): void {
  f.rekey(from, to);
  f.hook('SessionStart', to, { status: 'idle' });
}

async function toolError(fn: () => unknown): Promise<ToolError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

/** An auto-routed task that worker w1 took, whose terminal then exited before its turn stopped. */
async function exitedTask(f: FakeLedgerDeps, ledger: Ledger, route: TaskRecord['route'] = AUTO): Promise<TaskRecord> {
  const t = ledger.create({ central, session: f.worker('w1'), task: 'fix the flaky queue test', route });
  await flush();
  f.takePrompt('w1');
  f.exit('term-w1');
  return ledger.get(t.taskId)!;
}

// ---------------------------------------------------------------------------

describe('a new worker’s first task (Ruling P4-6)', () => {
  it("a connecting worker's task waits for SessionStart", async () => {
    const { f, ledger } = setup();

    const t = ledger.create({ central, session: starting(f), task: 'fix the flaky queue test', route: AUTO });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'queued', sentAt: null });
    expect(ledger.get(t.taskId)?.history.at(-1)?.note).toMatch(/once the session has reported that it started/);

    startUp(f);
    await flush();

    // Sent through the submit path every task takes: to the id the CLI gave the card, with the task's key and envelope.
    expect(f.submits).toHaveLength(1);
    expect(f.submits[0]).toMatchObject({ sessionId: 'cli-abc', key: t.promptKey, centralId: central.centralId });
    expect(f.submits[0].text.startsWith(envelopeHead(t.taskId))).toBe(true);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'sent', sessionId: 'cli-abc' });
    // Its own turn is told by its envelope, as for any task (Ruling 46).
    f.takePrompt('cli-abc');
    expect(ledger.get(t.taskId)?.state).toBe('running');
  });

  // A card that turns idle with no hook is no start (Ruling P4-22): test/mcp/ledgerStart.test.ts.

  it('a connecting worker that never starts fails after 120 s', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: starting(f), task: 'fix it', route: AUTO });

    await vi.advanceTimersByTimeAsync(NEW_WORKER_START_MS - START_POLL_MS);
    expect(ledger.get(t.taskId)?.state).toBe('queued');
    await vi.advanceTimersByTimeAsync(START_POLL_MS);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/session has not reported in/i) });
    expect(ledger.get(t.taskId)?.history.at(-1)?.note).toMatch(/^the session has not reported in/);
    expect(f.submits).toEqual([]);
    expect(ledger.isLocked('term-1')).toBe(false);
    expect(f.hookListenerCount()).toBe(0);
    // Not a terminal exit: AASC does not re-route it.
    expect(isRetargetable(ledger.get(t.taskId)!)).toBe(false);
    // Once failed, a late start sends nothing.
    startUp(f);
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 3);
    expect(f.submits).toEqual([]);
  });

  it('fails at the next look when the card ends while it starts, without waiting out the 120 s', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: starting(f), task: 'fix it' });
    await flush();

    f.patch('term-1', { status: 'ended' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/session has not reported in/i) });
    expect(f.submits).toEqual([]);
  });

  it('the lock is held while queued', async () => {
    const { f, ledger } = setup();
    const w = starting(f);
    ledger.create({ central, session: w, task: 'fix it' });
    await flush();

    expect(ledger.isLocked('term-1')).toBe(true);
    expect(ledger.isLocked('w9')).toBe(false);
    expect((await toolError(() => ledger.create({ central: other, session: w, task: 'mine' }))).code).toBe('BUSY');
    expect((await toolError(() => ledger.create({ central, session: w, task: 'again' }))).code).toBe('BUSY');
    // Across the re-key too: the lock is the terminal's.
    f.rekey('term-1', 'cli-abc');
    expect(ledger.isLocked('cli-abc')).toBe(true);
    expect(f.submits).toEqual([]);
  });

  it('a queued task on a starting worker is not failed by the agent-gone check', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: starting(f), task: 'fix it' });
    // While the CLI starts, its terminal does not show the agent in front.
    f.agentInFront('term-1', false);

    await vi.advanceTimersByTimeAsync(AGENT_GONE_MS + 4 * TICK_MS);
    expect(ledger.get(t.taskId)?.state).toBe('queued');

    // Once it is sent, the check runs as it does for every task (Ruling 50).
    startUp(f);
    await flush();
    expect(ledger.get(t.taskId)?.state).toBe('sent');
    await vi.advanceTimersByTimeAsync(AGENT_GONE_MS + 2 * TICK_MS);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/agent left/i) });
  });

  it('task_cancel on a queued task ends it cancelled and sends nothing', async () => {
    const h = deliverCtx({ sessions: [makeSession('term-1', { terminalId: 'term-1', status: 'connecting' })] });
    const t = h.ctx.ledger.create({ central: h.ctx.central, session: h.ctx.sessions()[0], task: 'fix it', route: AUTO });
    await flush();

    const result = await run('task_cancel', { id: t.taskId }, h.ctx);

    expect(h.base.get(t.taskId)?.state).toBe('cancelled');
    expect(result.data).toMatchObject({ state: 'cancelled', pressed: false });
    expect(h.base.get(t.taskId)?.history.at(-1)?.note).toMatch(/nothing was typed or pressed/);
    expect(h.f.interrupts).toEqual([]);
    expect(h.f.escNotes).toEqual([]);
    expect(h.base.isLocked('term-1')).toBe(false);
    // The worker that starts afterwards is sent nothing.
    h.f.rekey('term-1', 'cli-abc');
    h.f.hook('SessionStart', 'cli-abc', { status: 'idle' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 3);
    expect(h.f.submits).toEqual([]);
  });

  it('keeps a task whose prompt is on its way INVALID to cancel, queued or sent', async () => {
    const { f, ledger } = setup();
    const pending = vi.fn((): Promise<SubmitAnswer> => new Promise(() => undefined));
    const sending = createLedger({ ...f.deps, submit: pending });
    const queued = sending.create({ central, session: f.worker('w1'), task: 'fix it' });
    const sent = ledger.create({ central, session: f.worker('w2'), task: 'fix it' });
    await flush();

    expect(sending.get(queued.taskId)?.state).toBe('queued');
    expect(ledger.get(sent.taskId)?.state).toBe('sent');
    expect((await toolError(() => sending.cancel(queued.taskId, central.centralId, { mayPress: true }))).code).toBe('INVALID');
    expect((await toolError(() => ledger.cancel(sent.taskId, central.centralId, { mayPress: true }))).code).toBe('INVALID');
  });
});

describe('re-routing a task once (Ruling P4-7)', () => {
  it('retarget moves a terminal-exit failure to the new session once', async () => {
    const { f, ledger } = setup();
    const failed = await exitedTask(f, ledger);
    expect(failed).toMatchObject({ state: 'failed', error: expect.stringMatching(/terminal closed/i) });
    expect(isRetargetable(failed)).toBe(true);

    const moved = ledger.retarget(failed.taskId, central.centralId, f.worker('w2'));
    await flush();

    expect(moved).toMatchObject({
      taskId: failed.taskId,
      state: 'queued',
      sessionId: 'w2',
      terminalId: 'term-w2',
      retargetedFrom: 'w1',
      route: AUTO,
      sentAt: null,
      error: null,
    });
    expect(moved.history.at(-1)).toMatchObject({ state: 'queued', note: 're-routed from w1' });
    expect(ledger.get(failed.taskId)?.state).toBe('sent');
    // The same envelope, to the new session, under a key of its own (the route replays a key's first answer).
    expect(f.submits).toHaveLength(2);
    expect(f.submits[1]).toMatchObject({ sessionId: 'w2', text: f.submits[0].text });
    expect(f.submits[1].key).not.toBe(f.submits[0].key);
    expect(ledger.get(failed.taskId)?.promptKey).toBe(f.submits[1].key);
    expect(ledger.isLocked('w2')).toBe(true);
    expect(isRetargetable(ledger.get(failed.taskId)!)).toBe(false);
    // It runs and ends there like any task.
    f.takePrompt('w2');
    f.answers.set('w2', 'Fixed it: the timer leaked.');
    f.hook('Stop', 'w2', { status: 'waiting', backgroundTaskCount: 0 });
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);
    expect(ledger.get(failed.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('the timer leaked') });
  });

  it('re-routed to a worker that is still starting, it waits for that worker as a new task does', async () => {
    const { f, ledger } = setup();
    const failed = await exitedTask(f, ledger);

    ledger.retarget(failed.taskId, central.centralId, starting(f));
    await flush();
    expect(f.submits).toHaveLength(1);

    startUp(f);
    await flush();
    expect(f.submits).toHaveLength(2);
    expect(ledger.get(failed.taskId)).toMatchObject({ state: 'sent', sessionId: 'cli-abc', retargetedFrom: 'w1' });
  });

  it("retarget refuses a second time, a refusal failure, a cancel, or another central's task", async () => {
    const codeOf = async (ledger: Ledger, id: string, centralId: string, s: Session): Promise<string> =>
      (await toolError(() => ledger.retarget(id, centralId, s))).code;

    // A second time.
    const twice = setup();
    const failed = await exitedTask(twice.f, twice.ledger);
    twice.ledger.retarget(failed.taskId, central.centralId, twice.f.worker('w2'));
    await flush();
    twice.f.takePrompt('w2');
    twice.f.exit('term-w2');
    expect(twice.ledger.get(failed.taskId)?.state).toBe('failed');
    expect(await codeOf(twice.ledger, failed.taskId, central.centralId, twice.f.worker('w3'))).toBe('INVALID');
    expect(twice.f.submits).toHaveLength(2);

    // A task the prompt route refused.
    const refused = setup();
    refused.f.answerSubmitWith({ accepted: false, error: 'The agent can’t take a prompt right now' });
    const r = refused.ledger.create({ central, session: refused.f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    expect(refused.ledger.get(r.taskId)?.state).toBe('failed');
    refused.f.answerSubmitWith({ accepted: true, error: null });
    expect(await codeOf(refused.ledger, r.taskId, central.centralId, refused.f.worker('w2'))).toBe('INVALID');

    // A task that was cancelled.
    const cancelled = setup();
    const c = cancelled.ledger.create({ central, session: cancelled.f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    cancelled.f.takePrompt('w1');
    await cancelled.ledger.cancel(c.taskId, central.centralId, { mayPress: true });
    expect(cancelled.ledger.get(c.taskId)?.state).toBe('cancelled');
    expect(await codeOf(cancelled.ledger, c.taskId, central.centralId, cancelled.f.worker('w2'))).toBe('INVALID');

    // Another central's task, and one that does not exist.
    const theirs = setup();
    const t = await exitedTask(theirs.f, theirs.ledger);
    expect(await codeOf(theirs.ledger, t.taskId, other.centralId, theirs.f.worker('w2'))).toBe('NOT_FOUND');
    expect(await codeOf(theirs.ledger, 'T999', central.centralId, theirs.f.worker('w2'))).toBe('NOT_FOUND');
    expect(theirs.f.submits).toHaveLength(1);
  });

  it('does not re-route a task sent to a session the central named, or one whose turn had stopped', async () => {
    const named = setup();
    const n = await exitedTask(named.f, named.ledger, null);
    expect(n.state).toBe('failed');
    expect(isRetargetable(n)).toBe(false);
    expect((await toolError(() => named.ledger.retarget(n.taskId, central.centralId, named.f.worker('w2')))).code).toBe('INVALID');

    // Its turn stopped with shells still running, then the terminal closed: the work may be done, so it is not redone.
    const stopped = setup();
    const s = stopped.ledger.create({ central, session: stopped.f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    stopped.f.takePrompt('w1');
    stopped.f.hook('Stop', 'w1', { status: 'waiting', backgroundTaskCount: 1 });
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);
    stopped.f.exit('term-w1');
    expect(stopped.ledger.get(s.taskId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/terminal closed after its turn stopped/i) });
    expect(isRetargetable(stopped.ledger.get(s.taskId)!)).toBe(false);
  });

  it('takes the new session’s lock: BUSY when that session holds a task, and nothing changes', async () => {
    const { f, ledger } = setup();
    const failed = await exitedTask(f, ledger);
    const busy = f.worker('w2');
    ledger.create({ central: other, session: busy, task: 'theirs' });
    await flush();

    expect((await toolError(() => ledger.retarget(failed.taskId, central.centralId, busy))).code).toBe('BUSY');
    expect(ledger.get(failed.taskId)).toMatchObject({ state: 'failed', sessionId: 'w1', retargetedFrom: null });
    // Still re-routable elsewhere.
    expect(ledger.retarget(failed.taskId, central.centralId, f.worker('w3')).sessionId).toBe('w3');
  });
});

describe('the task view (deliver.ts toTaskView)', () => {
  it('the view carries route and retargetedFrom', async () => {
    const { f, ledger } = setup();
    const named = ledger.create({ central, session: f.worker('w9'), task: 'named' });
    const failed = await exitedTask(f, ledger);
    const moved = ledger.retarget(failed.taskId, central.centralId, f.worker('w2'));

    expect(toTaskView(named)).toMatchObject({ route: null, retargetedFrom: null });
    expect(toTaskView(failed)).toMatchObject({ route: AUTO, retargetedFrom: null });
    expect(toTaskView(moved)).toMatchObject({ route: AUTO, retargetedFrom: 'w1' });
    // Fields only: no key, no terminal, no answer.
    const view = toTaskView(moved);
    expect(JSON.stringify(view)).not.toContain(moved.promptKey);
    expect(Object.keys(view)).not.toContain('terminalId');
  });

  it('keeps the route as a copy of its own, each reason one bounded line', () => {
    const { f, ledger } = setup();
    const reasons = ['first\nline', 'x'.repeat(1_000)];
    const t = ledger.create({ central, session: f.worker('w1'), task: 'fix it', route: { by: 'auto', decision: 'reuse', reasons } });
    reasons.push('added later');

    const kept = ledger.get(t.taskId)!.route!;
    expect(kept.reasons).toHaveLength(2);
    expect(kept.reasons[0]).toBe('first line');
    expect(kept.reasons[1].length).toBeLessThanOrEqual(200);
  });
});
