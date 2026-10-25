// test/mcp/ledgerStart.test.ts — the P4 fix wave's ledger rules (server/mcp/ledger.ts, ledgerReroute.ts, closedBy.ts):
// a new worker is typed into only after a real hook from its terminal (Ruling P4-22: the card's connecting-timeout
// `idle` is not a start, so an envelope never lands in a trust dialog); a terminal a person closed, or one whose
// worker never started, is not re-routed (P4-24); a re-routed task's clock starts again (P4-28); close() stops
// everything the ledger runs (P4-28). Fake deps and fake timers: nothing reaches a terminal or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { _resetClosedByForTests, noteTerminalCloser } from '../../server/mcp/closedBy.js';
import {
  createLedger,
  isRetargetable,
  NEW_WORKER_START_MS,
  PERSON_CLOSED_ERROR,
  SENT_TIMEOUT_MS,
  START_POLL_MS,
  TERMINAL_EXIT_ERROR,
  TICK_MS,
  type SubmitAnswer,
} from '../../server/mcp/ledger.js';
import { forgetTerminalHeard, noteTerminalHeard } from '../../server/heardTerminals.js';
import { NEW_WORKER_ERROR } from '../../server/mcp/ledgerReroute.js';
import { fakeLedgerDeps, type FakeLedgerDeps } from './ledgerFixtures.js';
import { makeCentral, makeSession, NOW, unheard } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const central = makeCentral();
const AUTO = { by: 'auto', decision: 'create', reasons: ['opened claude in /a/proj'] } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  _resetClosedByForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const starting = (f: FakeLedgerDeps, id = 'term-1'): Session =>
  f.setSession(makeSession(id, { terminalId: id, status: 'connecting' }));

describe('a new worker is typed into only after its terminal hooked (Ruling P4-22)', () => {
  it('a worker whose card went idle by the connecting timeout gets no envelope', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: starting(f), task: 'fix it', route: AUTO });
    await flush();

    // sessionStore's 30 s fallback: connecting → idle with no hook. The trust dialog may be on screen.
    await vi.advanceTimersByTimeAsync(30_000);
    f.patch('term-1', { status: 'idle' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 5);

    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)?.state).toBe('queued');

    // 120 s is the only limit: then it fails, saying the worker never started and why it may not have.
    await vi.advanceTimersByTimeAsync(NEW_WORKER_START_MS);
    expect(f.submits).toEqual([]);
    const failed = ledger.get(t.taskId)!;
    expect(failed).toMatchObject({ state: 'failed', error: NEW_WORKER_ERROR });
    expect(failed.error).toMatch(/has not reported in/);
    expect(failed.error).toMatch(/trust/);
    expect(isRetargetable(failed)).toBe(false);
  });

  it("the envelope goes out after the worker's SessionStart hook", async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: starting(f), task: 'fix it' });
    f.patch('term-1', { status: 'idle' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 3);
    expect(f.submits).toEqual([]);

    f.rekey('term-1', 'cli-abc');
    f.hook('SessionStart', 'cli-abc', { status: 'idle' });
    await flush();

    expect(f.submits).toHaveLength(1);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'sent', sessionId: 'cli-abc' });
  });

  it('any first hook from its terminal counts as its start (a Codex worker, a resumed CLI)', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    ledger.create({ central, session: starting(f), task: 'fix it' });
    await flush();

    f.hook('Notification', 'term-1', { status: 'waiting' });
    await flush();

    expect(f.submits).toHaveLength(1);
  });

  it('a task for a card the connecting timeout already turned idle waits for its first hook (Ruling P4-35)', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    // session_create without a first task, then task_delegate by id after 30 s: idle, never heard.
    const card = f.setSession(makeSession('term-1', { terminalId: 'term-1', status: 'idle', startHeard: false }));
    const t = ledger.create({ central, session: card, task: 'fix it' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 5);

    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'queued' });
    expect(ledger.get(t.taskId)?.history[0].note).toMatch(/once the session has reported that it started/);

    // sessionStore clears the marker in handleEvent, before the hook's listeners hear it.
    f.hook('SessionStart', 'term-1', { status: 'idle', startHeard: undefined });
    await flush();
    expect(f.submits).toHaveLength(1);
  });

  it('a hook that did not hear the terminal does not release a waiting task; a hearing hook does', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const card = f.setSession(unheard(makeSession('term-w', { terminalId: 'term-w', status: 'connecting' })));
    const t = ledger.create({ central, session: card, task: 'fix it' });
    await flush();

    // `claude` in iTerm in the same folder: its SessionStart (a tty, no AASC id) adopts the card but hears nothing.
    f.hook('SessionStart', 'term-w', { status: 'idle' }, false);
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 5);
    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'queued' });

    f.hook('SessionStart', 'term-w', { status: 'idle' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS);
    expect(f.submits).toHaveLength(1);
  });

  it('a delegated task to an idle card whose terminal is unheard waits, not fails at once (Ruling P4-58)', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    // A session that outlived an AASC restart: idle, no marker, and no hook from its terminal since AASC came back.
    const card = f.setSession(unheard(makeSession('term-surv', { terminalId: 'term-surv', status: 'idle' })));
    const t = ledger.create({ central, session: card, task: 'fix it' });
    await vi.advanceTimersByTimeAsync(START_POLL_MS * 5);

    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'queued' });
    expect(ledger.get(t.taskId)?.history[0].note).toMatch(/once the session has reported that it started/);

    f.hook('Notification', 'term-surv', { status: 'waiting' });
    await flush();
    expect(f.submits).toHaveLength(1);
  });

  it('a task to an unheard card that never reports in fails in neutral words', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const card = f.setSession(unheard(makeSession('term-surv', { terminalId: 'term-surv', status: 'idle' })));
    const t = ledger.create({ central, session: card, task: 'fix it' });
    await vi.advanceTimersByTimeAsync(NEW_WORKER_START_MS);

    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: NEW_WORKER_ERROR });
    expect(NEW_WORKER_ERROR).toMatch(/AASC restarted/);
    expect(NEW_WORKER_ERROR).not.toMatch(/new session/);
  });

  it('a trusted Codex worker with a firstTask gets it after the flip (Ruling P4-52)', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: starting(f, 'term-cx1'), task: 'fix it' });
    await flush();
    try {
      // The connecting timeout's trusted-Codex pass: heard by its trust record, idle, no marker. Codex sends no hook
      // before its first prompt, so the start poll is what sends the task.
      noteTerminalHeard('term-cx1');
      f.patch('term-cx1', { status: 'idle' });
      await vi.advanceTimersByTimeAsync(START_POLL_MS * 2);
      expect(f.submits).toHaveLength(1);
      expect(ledger.get(t.taskId)?.state).not.toBe('failed');
    } finally {
      forgetTerminalHeard('term-cx1');
    }
  });

  it('a heard terminal whose card is still connecting is not taken as started', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    ledger.create({ central, session: starting(f, 'term-cx2'), task: 'fix it' });
    await flush();
    try {
      noteTerminalHeard('term-cx2');
      await vi.advanceTimersByTimeAsync(START_POLL_MS * 2);
      expect(f.submits).toEqual([]);
    } finally {
      forgetTerminalHeard('term-cx2');
    }
  });

  it('a card that still says it was not heard is not taken as started by the start poll', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: starting(f), task: 'fix it' });
    await flush();
    f.patch('term-1', { status: 'idle', startHeard: false });
    await vi.advanceTimersByTimeAsync(NEW_WORKER_START_MS);
    expect(f.submits).toEqual([]);
    expect(ledger.get(t.taskId)).toMatchObject({ state: 'failed', error: NEW_WORKER_ERROR });
  });
});

describe('an exit that is not re-routed (Ruling P4-24)', () => {
  it('a waiting task whose worker is closed is not re-routed', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: starting(f), task: 'fix it', route: AUTO });
    await flush();

    f.exit('term-1');

    const failed = ledger.get(t.taskId)!;
    expect(failed).toMatchObject({ state: 'failed', error: NEW_WORKER_ERROR });
    expect(isRetargetable(failed)).toBe(false);
    expect(f.submits).toEqual([]);
  });

  it("a person closing a busy worker's terminal does not re-route its task", async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const t = ledger.create({ central, session: f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    f.takePrompt('w1');

    noteTerminalCloser('term-w1', 'desktop-abc');
    f.exit('term-w1');

    const failed = ledger.get(t.taskId)!;
    expect(failed).toMatchObject({ state: 'failed', error: PERSON_CLOSED_ERROR });
    expect(failed.error).toBe('A person closed its terminal.');
    expect(isRetargetable(failed)).toBe(false);
  });

  it('a central closing it, or a crash, is still re-routed', async () => {
    for (const closer of ['mcp:central-1', '', null] as const) {
      _resetClosedByForTests();
      const f = fakeLedgerDeps();
      const ledger = createLedger(f.deps);
      const t = ledger.create({ central, session: f.worker('w1'), task: 'fix it', route: AUTO });
      await flush();
      f.takePrompt('w1');

      if (closer !== null) noteTerminalCloser('term-w1', closer);
      f.exit('term-w1');

      expect(ledger.get(t.taskId), String(closer)).toMatchObject({ state: 'failed', error: TERMINAL_EXIT_ERROR });
      expect(isRetargetable(ledger.get(t.taskId)!)).toBe(true);
    }
  });

  it("a person's close is forgotten after a minute: a later crash is re-routed", async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    noteTerminalCloser('term-w1', 'desktop-abc');
    await vi.advanceTimersByTimeAsync(61_000);
    const t = ledger.create({ central, session: f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    f.takePrompt('w1');

    f.exit('term-w1');

    expect(ledger.get(t.taskId)?.error).toBe(TERMINAL_EXIT_ERROR);
  });
});

describe('a re-routed task (Ruling P4-28)', () => {
  it('its clock starts again: a tick before the new submit answers does not fail a long task', async () => {
    const f = fakeLedgerDeps();
    let calls = 0;
    const submit = vi.fn(async (...args: Parameters<FakeLedgerDeps['deps']['submit']>): Promise<SubmitAnswer> => {
      calls += 1;
      if (calls === 1) return f.deps.submit(...args);
      return new Promise<SubmitAnswer>(() => undefined);
    });
    const ledger = createLedger({ ...f.deps, submit });
    const t = ledger.create({ central, session: f.worker('w1'), task: 'fix it', route: AUTO });
    await flush();
    f.takePrompt('w1');
    // The first worker works for longer than a sent prompt may wait, then its terminal dies.
    await vi.advanceTimersByTimeAsync(SENT_TIMEOUT_MS + 60_000);
    f.exit('term-w1');
    expect(isRetargetable(ledger.get(t.taskId)!)).toBe(true);

    ledger.retarget(t.taskId, central.centralId, f.worker('w2'));
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);

    expect(ledger.get(t.taskId)).toMatchObject({ state: 'queued', sessionId: 'w2' });
  });
});

describe('close() (Ruling P4-28)', () => {
  it('stops the ticker, the start polls and every listener', async () => {
    const f = fakeLedgerDeps();
    const ledger = createLedger(f.deps);
    const waiting = ledger.create({ central, session: starting(f), task: 'fix it' });
    const sent = ledger.create({ central, session: f.worker('w1'), task: 'fix it too' });
    await flush();
    expect(f.hookListenerCount()).toBe(2);
    expect(f.exitListenerCount()).toBe(1);

    ledger.close();

    expect(f.hookListenerCount()).toBe(0);
    expect(f.exitListenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // Nothing moves afterwards: no timeout, no poll.
    await vi.advanceTimersByTimeAsync(NEW_WORKER_START_MS + SENT_TIMEOUT_MS);
    expect(ledger.get(waiting.taskId)?.state).toBe('queued');
    expect(ledger.get(sent.taskId)?.state).toBe('sent');
  });
});
