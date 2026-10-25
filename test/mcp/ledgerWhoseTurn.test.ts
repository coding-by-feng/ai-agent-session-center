// test/mcp/ledgerWhoseTurn.test.ts — what moves a task besides its own Stop (server/mcp/ledger.ts): how the prompt
// route says its send went, whose prompt a UserPromptSubmit carried (Ruling 46: only the task's own envelope starts its
// turn, and the next prompt ends it), what a chat page's cancel mark means, the ids a new server run counts on from
// (Ruling 49), and an agent that left its terminal (Ruling 50). Fake deps and fake timers: nothing reaches a terminal
// or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEntry } from '../../src/types/chat.js';
import {
  AGENT_GONE_MS,
  buildEnvelope,
  createLedger,
  SENT_TIMEOUT_MS,
  STOP_SETTLE_MS,
  TICK_MS,
  type Ledger,
  type TaskRecord,
} from '../../server/mcp/ledger.js';
import { fakeLedgerDeps, type FakeLedgerDeps } from './ledgerFixtures.js';
import { makeCentral, NOW } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const central = makeCentral();
const other = makeCentral('room', 'r1', { centralId: 'central-2', terminalId: 'term-c2' });
const fault = { interruption: { kind: 'rate_limit' as const, line: 'API Error: 529 overloaded_error', detectedAt: NOW } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  log.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets the promises the ledger started settle, without moving the clock. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function setup(): { f: FakeLedgerDeps; ledger: Ledger } {
  const f = fakeLedgerDeps();
  return { f, ledger: createLedger(f.deps) };
}

/** A task for worker `id` that the worker has taken: its own envelope's UserPromptSubmit (state `running`). */
async function running(f: FakeLedgerDeps, ledger: Ledger, id = 'w1', task = 'fix the flaky queue test'): Promise<TaskRecord> {
  const session = f.sessions.get(id) ?? f.worker(id);
  const t = ledger.create({ central, session, task });
  await flush();
  f.takePrompt(id);
  expect(ledger.get(t.taskId)?.state).toBe('running');
  return ledger.get(t.taskId)!;
}

/** The worker ends its turn and the settle window passes. */
async function stop(f: FakeLedgerDeps, id = 'w1', over: Parameters<FakeLedgerDeps['hook']>[2] = {}): Promise<void> {
  f.hook('Stop', id, { status: 'waiting', backgroundTaskCount: 0, ...over });
  await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);
}

const user = (key: string, text: string, at: number): ChatEntry => ({ kind: 'user', key, timestamp: at, text });
const said = (key: string, text: string, at: number): ChatEntry => ({ kind: 'assistant', key, timestamp: at, text });
const cancelMark = (key: string, at: number): ChatEntry => ({ kind: 'system', key, timestamp: at, system: 'cancelled' });

// ---------------------------------------------------------------------------

describe('the prompt’s own outcome', () => {
  it('submit outcome gave-up means failed', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    await flush();
    expect(ledger.get(t.taskId)?.state).toBe('sent');

    f.outcomes.set(t.promptKey, 'gave-up');
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: expect.stringContaining('gave-up') });
    expect(f.deps.promptOutcome).toHaveBeenCalledWith('w1', t.promptKey, central.centralId);
  });

  it.each(['stopped', 'failed'] as const)('submit outcome %s means failed', async (outcome) => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    await flush();

    f.outcomes.set(t.promptKey, outcome);
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(ledger.get(t.taskId)?.state).toBe('failed');
  });

  it('a submitted outcome whose hook never came means running, and its Stop ends it as usual', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1', { status: 'working' }), task: 'a' });
    await flush();

    f.outcomes.set(t.promptKey, 'submitted');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(ledger.get(t.taskId)?.state).toBe('running');

    f.answers.set('w1', 'done without a prompt hook');
    await stop(f);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('without a prompt hook') });
  });

  it('a submitted outcome seen once the session is between turns gives the verdict: its turn already ran', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    await flush();
    f.answers.set('w1', 'ran while no hook said whose turn it was');

    f.outcomes.set(t.promptKey, { state: 'unconfirmed' });
    await vi.advanceTimersByTimeAsync(TICK_MS + STOP_SETTLE_MS + 10);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('ran while no hook') });
  });

  it('a prompt hook with no text asks the route whose prompt it was', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    await flush();
    f.outcomes.set(t.promptKey, 'submitted');

    f.typePrompt('w1', '');
    await flush();

    expect(ledger.get(t.taskId)?.state).toBe('running');
    expect(f.deps.promptOutcome).toHaveBeenCalledWith('w1', t.promptKey, central.centralId);
  });

  it('a send the route stopped for hands-off or a person fails the task in those words (Ruling 51)', async () => {
    const { f, ledger } = setup();
    const a = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    const b = ledger.create({ central, session: f.worker('w2'), task: 'b' });
    await flush();

    f.outcomes.set(a.promptKey, { state: 'stopped', stoppedBy: 'hands-off' });
    f.outcomes.set(b.promptKey, { state: 'stopped', stoppedBy: 'person' });
    await vi.advanceTimersByTimeAsync(TICK_MS);

    expect(ledger.get(a.taskId)).toMatchObject({ state: 'failed', error: 'Hands-off turned on before AASC finished typing the prompt.' });
    expect(ledger.get(a.taskId)?.history.at(-1)?.note).toBe('hands-off turned on');
    expect(ledger.get(b.taskId)?.error).toMatch(/person took over/);
    expect(ledger.isLocked('w1')).toBe(false);
  });

  it('a prompt parked behind a long turn stays sent, until it is plainly never taken', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1', { status: 'working' }), task: 'a' });
    await flush();

    await vi.advanceTimersByTimeAsync(SENT_TIMEOUT_MS - TICK_MS);
    expect(ledger.get(t.taskId)?.state).toBe('sent');
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: expect.stringContaining('never took') });
  });
});

describe('whose turn (Ruling 46)', () => {
  it('another central’s prompt typed first does not start the task', async () => {
    const { f, ledger } = setup();
    const t = ledger.create({ central, session: f.worker('w1'), task: 'fix the flaky queue test' });
    await flush();

    // Another central's envelope, and then a person's prompt, reach the worker before the task's own.
    f.typePrompt('w1', buildEnvelope('T7', other, 'Backend', 'their task', null));
    expect(ledger.get(t.taskId)?.state).toBe('sent');
    f.answers.set('w1', 'their answer');
    await stop(f);
    f.typePrompt('w1', 'what does the README say?');
    await stop(f);
    expect(ledger.get(t.taskId)?.state).toBe('sent');
    expect(f.deps.readChat).not.toHaveBeenCalled();

    // The task's own prompt starts its turn, and its answer is its own.
    f.takePrompt('w1');
    expect(ledger.get(t.taskId)?.state).toBe('running');
    f.answers.set('w1', 'our answer');
    await stop(f);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('our answer') });
  });

  it('a person’s turn after a background-shell Stop is not absorbed and its answer is not taken', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);
    await stop(f, 'w1', { backgroundTaskCount: 1 });
    expect(ledger.get(t.taskId)?.state).toBe('running');

    // The person's prompt ends the task's turn there; the page read already holds the person's answer too.
    const sent = t.sentAt!;
    f.chats.set('w1', [
      user('1', f.lastEnvelope('w1'), sent),
      said('2', 'The fix is in; the build runs in the background.', sent + 1),
      user('3', 'what does the README say?', sent + 2),
      said('4', 'The README says hello.', sent + 3),
    ]);
    f.typePrompt('w1', 'what does the README say?', { backgroundTaskCount: 1 });
    await flush();

    const done = ledger.get(t.taskId)!;
    expect(done.state).toBe('done');
    expect(done.answer).toBe('<untrusted source="session:w1" kind="answer">The fix is in; the build runs in the background.</untrusted>');
    expect(done.history.at(-1)?.note).toMatch(/background shells were still running/);
    expect(ledger.isLocked('w1')).toBe(false);

    // The person's turn ends: the task stays as it was.
    await stop(f, 'w1', { backgroundTaskCount: 0 });
    expect(ledger.get(t.taskId)).toEqual(done);
  });

  it('another prompt in the middle of the task’s turn fails it; a prompt hook with no text does not', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);
    f.hook('PreToolUse', 'w1', { status: 'working' });

    f.typePrompt('w1', '', { status: 'working' });
    expect(ledger.get(t.taskId)?.state).toBe('running');
    f.typePrompt('w1', 'also check the lint', { status: 'working' });

    expect(ledger.get(t.taskId)).toMatchObject({
      state: 'failed',
      error: 'Another prompt reached the session before the task’s turn ended.',
    });
    expect(ledger.isLocked('w1')).toBe(false);
  });

  it('a system cancelled entry ends the task cancelled', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);
    const sent = t.sentAt!;
    // No cancel stamp on the session (Codex has none): the chat page's mark is the only sign.
    f.chats.set('w1', [user('1', f.lastEnvelope('w1'), sent), said('2', 'Half way through the', sent + 1), cancelMark('3', sent + 2)]);

    await stop(f);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'cancelled', answer: null });
    expect(ledger.get(t.taskId)?.history.at(-1)?.note).toBe('the person stopped the turn');
    expect(ledger.isLocked('w1')).toBe(false);
  });

  it('a cancel mark of an earlier turn is not the task’s', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);
    const sent = t.sentAt!;
    f.chats.set('w1', [cancelMark('0', sent - 10), user('1', f.lastEnvelope('w1'), sent), said('2', 'All green.', sent + 1)]);

    await stop(f);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('All green.') });
  });

  it('stalled resumes only on a resume prompt; another prompt fails it', async () => {
    const { f, ledger } = setup();

    // A short "continue" resumes it, and the answer is the one after it.
    const a = await running(f, ledger, 'w1');
    await stop(f, 'w1', fault);
    expect(ledger.get(a.taskId)?.state).toBe('stalled');
    f.typePrompt('w1', 'continue', { interruption: null });
    expect(ledger.get(a.taskId)?.state).toBe('running');
    const sent = a.sentAt!;
    f.chats.set('w1', [
      user('1', f.lastEnvelope('w1'), sent),
      said('2', 'Working on it', sent + 1),
      user('3', 'continue', sent + 2),
      said('4', 'Fixed after the retry.', sent + 3),
    ]);
    await stop(f, 'w1');
    expect(ledger.get(a.taskId)).toMatchObject({ state: 'done', answer: expect.stringContaining('Fixed after the retry.') });

    // The session queue's own resume prompt resumes it too.
    const b = await running(f, ledger, 'w2');
    f.resumePrompts.set('w2', 'Pick up where the API error stopped you.');
    await stop(f, 'w2', fault);
    f.typePrompt('w2', 'Pick up where the API error stopped you.', { interruption: null });
    expect(ledger.get(b.taskId)?.state).toBe('running');

    // Any other prompt fails it: the session moved on.
    const c = await running(f, ledger, 'w3');
    await stop(f, 'w3', fault);
    f.typePrompt('w3', 'forget that, write the release notes', { interruption: null });
    expect(ledger.get(c.taskId)).toMatchObject({
      state: 'failed',
      error: 'The session moved on to another prompt while the task was stalled.',
    });
    expect(ledger.isLocked('w3')).toBe(false);
  });

  it('cancel after the task’s turn ended presses no Esc', async () => {
    const { f, ledger } = setup();
    // One turn stopped with background shells still running; another stopped and its verdict is still settling.
    const shells = await running(f, ledger, 'w1');
    await stop(f, 'w1', { backgroundTaskCount: 1 });
    const settling = await running(f, ledger, 'w2');
    f.hook('Stop', 'w2', { status: 'waiting', backgroundTaskCount: 0 });

    const outcomes = [
      await ledger.cancel(shells.taskId, central.centralId, { mayPress: true }),
      await ledger.cancel(settling.taskId, central.centralId, { mayPress: true }),
    ];

    for (const c of outcomes) {
      expect(c).toMatchObject({ how: 'turn-over', task: { state: 'cancelled' } });
      expect(c.task.history.at(-1)?.note).toMatch(/turn had already ended, nothing was pressed/);
    }
    expect(f.interrupts).toEqual([]);
    expect(f.escNotes).toEqual([]);
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);
    expect(ledger.get(settling.taskId)?.state).toBe('cancelled');
    expect(f.deps.readChat).not.toHaveBeenCalled();
  });

  it('a turn that went on after its Stop (a tool hook) is current again: its cancel presses Esc', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);
    await stop(f, 'w1', { backgroundTaskCount: 1 });
    f.hook('PreToolUse', 'w1', { status: 'working' });

    expect((await ledger.cancel(t.taskId, central.centralId, { mayPress: true })).how).toBe('pressed');
    expect(f.interrupts).toHaveLength(1);
  });
});

describe('task ids (Ruling 49)', () => {
  it('ids continue after the highest logged task id', () => {
    const { f, ledger } = setup();
    const lastTaskNumber = vi.fn(() => 41);
    f.deps.lastTaskNumber = lastTaskNumber;

    const a = ledger.create({ central, session: f.worker('w1'), task: 'a' });
    const b = ledger.create({ central, session: f.worker('w2'), task: 'b' });

    expect([a.taskId, b.taskId]).toEqual(['T42', 'T43']);
    expect(f.submits[0].text.startsWith('[AASC · task T42 from ')).toBe(true);
    expect(lastTaskNumber).toHaveBeenCalledTimes(1);
  });

  it('knows an id of an earlier run as from before the restart, and only those', () => {
    const { f, ledger } = setup();
    f.lastTaskNumberIs(41);

    // Asked before any task: the log is read for it.
    expect(ledger.isFromBeforeRestart('T41')).toBe(true);
    ledger.create({ central, session: f.worker('w1'), task: 'a' });

    expect(ledger.isFromBeforeRestart('T1')).toBe(true);
    expect(ledger.isFromBeforeRestart('T42')).toBe(false);
    expect(ledger.isFromBeforeRestart('T99')).toBe(false);
    expect(ledger.isFromBeforeRestart('not-a-task')).toBe(false);
  });

  it('starts at T1 when the log holds none, or cannot be read', () => {
    const empty = setup();
    const broken = setup();
    broken.f.deps.lastTaskNumber = () => {
      throw new Error('SQLITE_BUSY /Users/x/data/sessions.db');
    };

    expect(empty.ledger.create({ central, session: empty.f.worker('w1'), task: 'a' }).taskId).toBe('T1');
    expect(broken.ledger.create({ central, session: broken.f.worker('w1'), task: 'a' }).taskId).toBe('T1');
    expect(broken.ledger.isFromBeforeRestart('T1')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('SQLITE_BUSY'));
  });
});

describe('the agent (Ruling 50)', () => {
  it('a task whose agent left the terminal for 10 s fails', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);

    f.agentInFront('term-w1', false);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(ledger.get(t.taskId)?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(AGENT_GONE_MS);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: 'The agent left its terminal before the task was done.' });
    expect(ledger.get(t.taskId)?.history.at(-1)?.note).toBe('the agent left the terminal');
    expect(ledger.isLocked('w1')).toBe(false);
  });

  it('an agent back in front within 10 s keeps its task', async () => {
    const { f, ledger } = setup();
    const t = await running(f, ledger);

    f.agentInFront('term-w1', false);
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    f.agentInFront('term-w1', true);
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);

    expect(ledger.get(t.taskId)?.state).toBe('running');
  });
});
