// test/promptSubmit.test.ts — AASC-42: the Mac types a phone's prompt and makes sure the CLI
// took it. The text, a standalone Enter 1 s later (2.5 s with images), then Enter again at
// 3 / 8 / 15 / 30 / 60 s until the UserPromptSubmit hook for that terminal arrives, the same
// rules as the desktop queue (src/lib/submitConfirm.ts). The PTY writer is a fake and every
// timer is faked: nothing here reaches a real terminal or process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import {
  createPromptSubmitter, createPromptKeyCache, SUBMIT_ENTER_DELAY_MS, IMAGE_SUBMIT_ENTER_DELAY_MS,
  SUBMIT_RETRY_AFTER_MS, SUBMIT_GIVE_UP_GRACE_MS, INTERRUPT_WAIT_MS, PROMPT_KEY_TTL_MS,
  type PromptOutcome, type PromptSessionView,
} from '../server/promptSubmit.js';
import { onTerminalHook, emitTerminalHook, _resetHookSignalsForTests } from '../server/hookSignals.js';

const T = 'term-1';
let t0 = 0;
let writes: Array<{ at: number; data: string }>;
let sessions: Map<string, PromptSessionView>;
let terminalAlive: boolean;
let agentForeground: boolean;

function makeSubmitter() {
  return createPromptSubmitter({
    write: (terminalId, data) => {
      if (terminalId !== T || !terminalAlive) return false;
      writes.push({ at: Date.now() - t0, data });
      return true;
    },
    sessionOfTerminal: (terminalId) => sessions.get(terminalId) ?? null,
    isAgentForeground: () => agentForeground,
    onTerminalHook,
  });
}

function setStatus(status: string, extra: Partial<PromptSessionView> = {}): void {
  const current = sessions.get(T) ?? { sessionId: 's1', status };
  sessions.set(T, { ...current, status, ...extra });
}

/** A hook for the session: the session's state changes, then the pipeline announces it. */
function hook(event: string, status: string, extra: Partial<PromptSessionView> = {}): void {
  setStatus(status, extra);
  const s = sessions.get(T)!;
  emitTerminalHook(event, { sessionId: s.sessionId, terminalId: T, status: s.status, userCancelledAt: s.userCancelledAt ?? null });
}

/** Track a submit's outcome without awaiting it (the timers have to be advanced first). */
function track(p: Promise<PromptOutcome>): { outcome: PromptOutcome | null } {
  const box: { outcome: PromptOutcome | null } = { outcome: null };
  void p.then((o) => { box.outcome = o; });
  return box;
}

const enters = () => writes.filter((w) => w.data === '\r').map((w) => w.at);
const LAST_RETRY = SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  writes = [];
  sessions = new Map([[T, { sessionId: 's1', status: 'waiting', userCancelledAt: null }]]);
  terminalAlive = true;
  agentForeground = true;
  _resetHookSignalsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the timings are the desktop queue’s', () => {
  it('uses the same delays and retry schedule', () => {
    expect(SUBMIT_ENTER_DELAY_MS).toBe(1_000);
    expect(IMAGE_SUBMIT_ENTER_DELAY_MS).toBe(2_500);
    expect([...SUBMIT_RETRY_AFTER_MS]).toEqual([3_000, 8_000, 15_000, 30_000, 60_000]);
    expect(SUBMIT_GIVE_UP_GRACE_MS).toBe(15_000);
    expect(INTERRUPT_WAIT_MS).toBe(10_000);
    expect(PROMPT_KEY_TTL_MS).toBe(5 * 60_000);
  });
});

describe('a prompt sent now', () => {
  it('types the text, presses Enter on its own 1 s later, and stops once the hook acknowledges it', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'fix the build', mode: 'now' }));
    expect(writes).toEqual([{ at: 0, data: 'fix the build' }]);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(writes).toEqual([{ at: 0, data: 'fix the build' }, { at: 1_000, data: '\r' }]);

    await vi.advanceTimersByTimeAsync(500);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');

    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toEqual([1_000]);
  });

  it('waits 2.5 s before Enter when images are attached, and lists their paths under the text', async () => {
    track(makeSubmitter().submit({ terminalId: T, text: 'what is this?', imagePaths: ['/tmp/q/a.png', '/tmp/q/b.jpg'], mode: 'now' }));
    expect(writes[0]).toEqual({ at: 0, data: 'what is this?\n/tmp/q/a.png\n/tmp/q/b.jpg' });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([]);
    await vi.advanceTimersByTimeAsync(IMAGE_SUBMIT_ENTER_DELAY_MS - SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([2_500]);
  });

  it('presses Enter again at 3, 8, 15, 30 and 60 s while nothing acknowledges it, then gives up', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'run the tests', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + LAST_RETRY);
    expect(enters()).toEqual([1_000, ...SUBMIT_RETRY_AFTER_MS.map((ms) => 1_000 + ms)]);
    expect(result.outcome).toBeNull();

    await vi.advanceTimersByTimeAsync(SUBMIT_GIVE_UP_GRACE_MS - 1);
    expect(result.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result.outcome).toBe('gave-up');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toHaveLength(1 + SUBMIT_RETRY_AFTER_MS.length);
  });

  it('stops retrying as soon as a later Enter is acknowledged', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(1_000 + 8_000);
    expect(enters()).toEqual([1_000, 4_000, 9_000]);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toEqual([1_000, 4_000, 9_000]);
  });

  it('takes a busy status as acknowledged (the CLI started work)', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(1_500);
    hook('PreToolUse', 'working');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
  });

  it('does not count an unrelated hook (an idle notification) as the acknowledgement', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(1_500);
    hook('Notification', 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(enters()).toEqual([1_000, 4_000]);
  });

  it('never presses Enter again for a slash command: it may have opened a picker', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: '  /model', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.outcome).toBe('unconfirmed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toEqual([1_000]);
  });

  it('stops without pressing Enter once a dialog opens (approval or a question)', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(1_500);
    setStatus('approval');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when the user cancels after the send', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(2_000);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when another device takes the session over', async () => {
    let mayDrive = true;
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now', mayDrive: () => mayDrive }));
    await vi.advanceTimersByTimeAsync(2_000);
    mayDrive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when the terminal no longer belongs to a session', async () => {
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(2_000);
    sessions.delete(T);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
  });

  it('fails without pressing Enter when the text could not be written', async () => {
    terminalAlive = false;
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'go', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.outcome).toBe('failed');
    expect(writes).toEqual([]);
  });

  it('types nothing once the agent is no longer the terminal’s foreground program', async () => {
    agentForeground = false;
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'rm -rf build', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.outcome).toBe('stopped');
    expect(writes).toEqual([]);
  });

  it('never interleaves two prompts for one terminal: the second waits for the first one’s Enter', async () => {
    const submitter = makeSubmitter();
    const first = track(submitter.submit({ terminalId: T, text: 'one', mode: 'now' }));
    await vi.advanceTimersByTimeAsync(300);
    track(submitter.submit({ terminalId: T, text: 'two', mode: 'now' }));
    expect(writes.map((w) => w.data)).toEqual(['one']);
    await vi.advanceTimersByTimeAsync(700);
    expect(writes).toEqual([
      { at: 0, data: 'one' }, { at: 1_000, data: '\r' }, { at: 1_000, data: 'two' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    // The first stops confirming: an Enter for it would now submit the second's text early.
    expect(first.outcome).toBe('superseded');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(enters()).toEqual([1_000, 2_000]);
  });
});

describe('a prompt that interrupts', () => {
  it('presses Esc, waits for the turn to stop, then sends', async () => {
    setStatus('working');
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'stop, do this instead', mode: 'interrupt' }));
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(writes).toHaveLength(1);
    hook('Stop', 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(writes[1]).toEqual({ at: 2_000, data: 'stop, do this instead' });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([3_000]);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
  });

  it('sends anyway after 10 s when no Stop arrives', async () => {
    setStatus('working');
    track(makeSubmitter().submit({ terminalId: T, text: 'now', mode: 'interrupt' }));
    await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS - 1);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes[1]).toEqual({ at: 10_000, data: 'now' });
  });

  it('presses no Esc when nothing is running', async () => {
    track(makeSubmitter().submit({ terminalId: T, text: 'hello', mode: 'interrupt' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([{ at: 0, data: 'hello' }]);
  });

  it('keeps retrying although the interrupt itself marked the turn as cancelled by the user', async () => {
    setStatus('working');
    track(makeSubmitter().submit({ terminalId: T, text: 'instead', mode: 'interrupt' }));
    await vi.advanceTimersByTimeAsync(500);
    hook('Stop', 'waiting');
    // The transcript check after that Stop (sessionStore) stamps the cancel 150 ms later.
    await vi.advanceTimersByTimeAsync(150);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + 3_000);
    expect(enters()).toEqual([1_500, 4_500]);
  });

  it('types nothing when the session ended while it waited', async () => {
    setStatus('working');
    const result = track(makeSubmitter().submit({ terminalId: T, text: 'instead', mode: 'interrupt' }));
    await vi.advanceTimersByTimeAsync(500);
    agentForeground = false;
    hook('SessionEnd', 'ended');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('stopped');
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
  });
});

describe('createPromptKeyCache', () => {
  it('remembers a key for 5 minutes', () => {
    const cache = createPromptKeyCache<string>();
    cache.set('k1', 'first');
    expect(cache.get('k1')).toBe('first');
    vi.advanceTimersByTime(PROMPT_KEY_TTL_MS - 1);
    expect(cache.get('k1')).toBe('first');
    vi.advanceTimersByTime(1);
    expect(cache.get('k1')).toBeUndefined();
  });

  it('keeps only the newest keys when full', () => {
    const cache = createPromptKeyCache<number>({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });
});
