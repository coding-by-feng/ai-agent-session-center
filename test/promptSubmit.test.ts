// test/promptSubmit.test.ts — AASC-42: the Mac types a phone's prompt and makes sure the CLI
// took it. The text, a standalone Enter 1 s later (with images 2.5 s, +0.3 s each after the first), then Enter again at
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
  INTERRUPT_CANCEL_GRACE_MS, PREVIOUS_PROMPT_WAIT_MS, SLASH_SETTLE_MS, BUSY_PARK_CHECK_MS, BUSY_PARK_MAX_MS,
  type PromptOutcome, type PromptRequest, type PromptResult, type PromptSessionView,
} from '../server/promptSubmit.js';
import { onTerminalHook, emitTerminalHook, _resetHookSignalsForTests } from '../server/hookSignals.js';

const T = 'term-1';
let t0 = 0;
let writes: Array<{ at: number; data: string }>;
let sessions: Map<string, PromptSessionView>;
let terminalAlive: boolean;
let agentForeground: boolean;
let throwOnEnter: boolean;

function makeSubmitter() {
  return createPromptSubmitter({
    write: (terminalId, data) => {
      if (terminalId !== T || !terminalAlive) return false;
      if (data === '\r' && throwOnEnter) throw new Error('pty write threw');
      writes.push({ at: Date.now() - t0, data });
      return true;
    },
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    isAgentForeground: () => agentForeground,
    onTerminalHook,
  });
}

/** A prompt request for session s1's terminal. */
const req = (r: Omit<PromptRequest, 'sessionId' | 'terminalId'> & Partial<PromptRequest>): PromptRequest =>
  ({ sessionId: 's1', terminalId: T, ...r });

function setStatus(status: string, extra: Partial<PromptSessionView> = {}): void {
  const current = sessions.get('s1') ?? { sessionId: 's1', terminalId: T, status };
  sessions.set('s1', { ...current, status, ...extra });
}

/** A hook for the session: the session's state changes, then the pipeline announces it. */
function hook(event: string, status: string, extra: Partial<PromptSessionView> = {}): void {
  setStatus(status, extra);
  const s = sessions.get('s1')!;
  emitTerminalHook(event, { sessionId: s.sessionId, terminalId: T, status: s.status, userCancelledAt: s.userCancelledAt ?? null });
}

/** Track a submit's outcome without awaiting it (the timers have to be advanced first). */
function track(p: Promise<PromptResult>): { outcome: PromptOutcome | null; typed: boolean | null } {
  const box: { outcome: PromptOutcome | null; typed: boolean | null } = { outcome: null, typed: null };
  void p.then((r) => { box.outcome = r.outcome; box.typed = r.typed; });
  return box;
}

const enters = () => writes.filter((w) => w.data === '\r').map((w) => w.at);
const LAST_RETRY = SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
  writes = [];
  sessions = new Map([['s1', { sessionId: 's1', terminalId: T, status: 'waiting', userCancelledAt: null }]]);
  terminalAlive = true;
  agentForeground = true;
  throwOnEnter = false;
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
    // Longer than the previous prompt's slowest path: interrupt wait, image pause, every retry.
    expect(PREVIOUS_PROMPT_WAIT_MS).toBeGreaterThan(INTERRUPT_WAIT_MS + IMAGE_SUBMIT_ENTER_DELAY_MS + LAST_RETRY + SUBMIT_GIVE_UP_GRACE_MS);
    expect(SLASH_SETTLE_MS).toBe(3_000);
  });
});

describe('a prompt sent now', () => {
  it('types the text, presses Enter on its own 1 s later, and stops once the hook acknowledges it', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'fix the build', mode: 'now' })));
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

  it('waits 2.5 s (+0.3 s per further image) before Enter when images are attached, and lists their paths under the text', async () => {
    track(makeSubmitter().submit(req({ text: 'what is this?', imagePaths: ['/tmp/q/a.png', '/tmp/q/b.jpg'], mode: 'now' })));
    expect(writes[0]).toEqual({ at: 0, data: 'what is this?\n/tmp/q/a.png\n/tmp/q/b.jpg' });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([]);
    await vi.advanceTimersByTimeAsync(IMAGE_SUBMIT_ENTER_DELAY_MS - SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(enters()).toEqual([2_800]);
  });

  it('presses Enter again at 3, 8, 15, 30 and 60 s while nothing acknowledges it, then gives up', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'run the tests', mode: 'now' })));
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
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_000 + 8_000);
    expect(enters()).toEqual([1_000, 4_000, 9_000]);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toEqual([1_000, 4_000, 9_000]);
  });

  it('takes a busy status as acknowledged (the CLI started work)', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_500);
    hook('PreToolUse', 'working');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
  });

  it('does not count an unrelated hook (an idle notification) as the acknowledgement', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_500);
    hook('Notification', 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(enters()).toEqual([1_000, 4_000]);
  });

  it('never presses Enter again for a slash command: it may have opened a picker', async () => {
    const result = track(makeSubmitter().submit(req({ text: '  /model', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.outcome).toBe('unconfirmed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(enters()).toEqual([1_000]);
  });

  it('stops without pressing Enter once a dialog opens (approval or a question)', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_500);
    setStatus('approval');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when the user cancels after the send', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when another device takes the session over', async () => {
    let mayDrive = true;
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now', mayDrive: () => mayDrive })));
    await vi.advanceTimersByTimeAsync(2_000);
    mayDrive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when the session is gone, or now runs in another terminal (a restart)', async () => {
    const gone = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    sessions.delete('s1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(gone.outcome).toBe('stopped');

    writes = [];
    t0 = Date.now();
    setStatus('waiting');
    const moved = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    setStatus('waiting', { terminalId: 'term-restarted' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(moved.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('presses no first Enter when a dialog opened during the pause: it would answer the dialog', async () => {
    setStatus('working');
    const result = track(makeSubmitter().submit(req({ text: 'also check the docs', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(500);
    hook('PermissionRequest', 'approval');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.outcome).toBe('stopped');
    expect(writes.map((w) => w.data)).toEqual(['also check the docs']);
  });

  it('presses no first Enter once the agent exited or another device took over during the pause', async () => {
    const exited = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(500);
    agentForeground = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(exited.outcome).toBe('stopped');
    expect(enters()).toEqual([]);

    agentForeground = true;
    let mayDrive = true;
    const takenOver = track(makeSubmitter().submit(req({ text: 'go', mode: 'now', mayDrive: () => mayDrive })));
    await vi.advanceTimersByTimeAsync(500);
    mayDrive = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(takenOver.outcome).toBe('stopped');
    expect(enters()).toEqual([]);
  });

  it('presses no repeated Enter once the agent exited without a SessionEnd (a crash): it would reach the shell', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    agentForeground = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('ends as failed, not as an uncaught error, when a repeated Enter throws', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_000);
    throwOnEnter = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(result.outcome).toBe('failed');
  });

  it('fails without pressing Enter when the text could not be written', async () => {
    terminalAlive = false;
    const result = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.outcome).toBe('failed');
    expect(writes).toEqual([]);
  });

  it('types nothing once the agent is no longer the terminal’s foreground program', async () => {
    agentForeground = false;
    const result = track(makeSubmitter().submit(req({ text: 'rm -rf build', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result.outcome).toBe('stopped');
    expect(writes).toEqual([]);
  });

  it('says whether it typed anything: a send that stopped before typing can be sent again', async () => {
    agentForeground = false;
    const untouched = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(untouched).toEqual({ outcome: 'stopped', typed: false });

    agentForeground = true;
    const typed = track(makeSubmitter().submit(req({ text: 'go', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + LAST_RETRY + SUBMIT_GIVE_UP_GRACE_MS);
    expect(typed).toEqual({ outcome: 'gave-up', typed: true });
  });
});

describe('a prompt that interrupts', () => {
  it('presses Esc, waits for the turn to stop, then sends', async () => {
    setStatus('working');
    const result = track(makeSubmitter().submit(req({ text: 'stop, do this instead', mode: 'interrupt' })));
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
    track(makeSubmitter().submit(req({ text: 'now', mode: 'interrupt' })));
    await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS - 1);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes[1]).toEqual({ at: 10_000, data: 'now' });
  });

  it('presses no Esc when nothing is running', async () => {
    track(makeSubmitter().submit(req({ text: 'hello', mode: 'interrupt' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toEqual([{ at: 0, data: 'hello' }]);
  });

  it('keeps retrying although the interrupt itself marked the turn as cancelled by the user', async () => {
    setStatus('working');
    track(makeSubmitter().submit(req({ text: 'instead', mode: 'interrupt' })));
    await vi.advanceTimersByTimeAsync(500);
    hook('Stop', 'waiting');
    // The transcript check after that Stop (sessionStore) stamps the cancel 150 ms later.
    await vi.advanceTimersByTimeAsync(150);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + 3_000);
    expect(enters()).toEqual([1_500, 4_500]);
  });

  it('types nothing when a dialog is still open after the wait', async () => {
    setStatus('approval');
    const result = track(makeSubmitter().submit(req({ text: 'no, do this', mode: 'interrupt' })));
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
    await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS);
    expect(result.outcome).toBe('stopped');
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
  });

  it('still retries when the interrupted turn’s cancel is stamped late, after this prompt’s Enter', async () => {
    setStatus('working');
    track(makeSubmitter().submit(req({ text: 'instead', mode: 'interrupt' })));
    await vi.advanceTimersByTimeAsync(500);
    hook('Stop', 'waiting');
    // A slow transcript read under load: the stamp lands after the Enter at 1.5 s.
    await vi.advanceTimersByTimeAsync(1_200);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(SUBMIT_RETRY_AFTER_MS[0]);
    expect(enters()).toEqual([1_500, 4_500]);
    expect(INTERRUPT_CANCEL_GRACE_MS).toBeGreaterThan(1_200);
  });

  it('types nothing when the session ended while it waited', async () => {
    setStatus('working');
    const result = track(makeSubmitter().submit(req({ text: 'instead', mode: 'interrupt' })));
    await vi.advanceTimersByTimeAsync(500);
    agentForeground = false;
    hook('SessionEnd', 'ended');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('stopped');
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
  });
});

describe('one prompt at a time per terminal', () => {
  it('types the second only once the first is confirmed, not just entered', async () => {
    const submitter = makeSubmitter();
    const first = track(submitter.submit(req({ text: 'one', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(300);
    const second = track(submitter.submit(req({ text: 'two', mode: 'now' })));
    // The first's Enter was swallowed: it presses Enter again at 4 s, acknowledged at 5 s.
    await vi.advanceTimersByTimeAsync(4_700);
    expect(writes.map((w) => w.data)).toEqual(['one', '\r', '\r']);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.outcome).toBe('submitted');
    expect(writes.at(-1)).toEqual({ at: 5_000, data: 'two' });
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    expect(enters()).toEqual([1_000, 4_000, 6_000]);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(second.outcome).toBe('submitted');
  });

  it('never types onto the first one’s unsent text: when the first gives up, the second stops', async () => {
    const submitter = makeSubmitter();
    const first = track(submitter.submit(req({ text: 'one', imagePaths: ['/tmp/q/a.png'], mode: 'now' })));
    await vi.advanceTimersByTimeAsync(300);
    const second = track(submitter.submit(req({ text: 'two', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(IMAGE_SUBMIT_ENTER_DELAY_MS + LAST_RETRY + SUBMIT_GIVE_UP_GRACE_MS);
    expect(first.outcome).toBe('gave-up');
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual({ outcome: 'stopped', typed: false });
    expect(writes.some((w) => w.data === 'two')).toBe(false);
  });

  it('follows a first one that typed nothing', async () => {
    const submitter = makeSubmitter();
    const first = track(submitter.submit(req({ text: 'one', mode: 'now', mayDrive: () => false })));
    const second = track(submitter.submit(req({ text: 'two', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual({ outcome: 'stopped', typed: false });
    expect(writes.map((w) => w.data)).toEqual(['two']);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(second.outcome).toBe('submitted');
  });

  it('holds the next prompt after a slash command until a hook arrives (it may still be running)', async () => {
    const submitter = makeSubmitter();
    const first = track(submitter.submit(req({ text: '/clear', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(300);
    track(submitter.submit(req({ text: 'two', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(700);
    expect(first.outcome).toBe('unconfirmed');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writes.map((w) => w.data)).toEqual(['/clear', '\r']);
    hook('SessionStart', 'idle');
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.at(-1)).toEqual({ at: 2_000, data: 'two' });
  });

  it('holds it at most 3 s when no hook comes, also for a prompt that arrives after the slash command finished', async () => {
    const submitter = makeSubmitter();
    track(submitter.submit(req({ text: '/compact', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_500);
    track(submitter.submit(req({ text: 'two', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(SLASH_SETTLE_MS - 500 - 1);
    expect(writes.map((w) => w.data)).toEqual(['/compact', '\r']);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.at(-1)).toEqual({ at: 1_000 + SLASH_SETTLE_MS, data: 'two' });
  });

  it('waits at most 90 s for the one before, then stops without typing', async () => {
    setStatus('working');
    const submitter = makeSubmitter();
    // Sent while the agent works: it waits for the turn to end before any retry.
    track(submitter.submit(req({ text: 'one', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(500);
    const second = track(submitter.submit(req({ text: 'two', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(PREVIOUS_PROMPT_WAIT_MS - 1);
    expect(second.outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(second).toEqual({ outcome: 'stopped', typed: false });
    expect(writes.some((w) => w.data === 'two')).toBe(false);
  });

  it('has room for one prompt waiting behind the one typing, and no more', async () => {
    const submitter = makeSubmitter();
    expect(submitter.hasRoom(T)).toBe(true);
    track(submitter.submit(req({ text: 'one', mode: 'now' })));
    expect(submitter.hasRoom(T)).toBe(true);
    track(submitter.submit(req({ text: 'two', mode: 'now' })));
    expect(submitter.hasRoom(T)).toBe(false);
    expect(submitter.hasRoom('term-other')).toBe(true);
    const third = track(submitter.submit(req({ text: 'three', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(third).toEqual({ outcome: 'stopped', typed: false });

    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitter.hasRoom(T)).toBe(true);
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(submitter.hasRoom(T)).toBe(true);
    expect(writes.some((w) => w.data === 'three')).toBe(false);
  });
});

describe('a prompt sent while the agent is working', () => {
  beforeEach(() => setStatus('working'));

  it('counts only its own UserPromptSubmit as confirmation, not the running turn’s hooks', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(1_500);
    hook('PreToolUse', 'working');
    hook('PostToolUse', 'working');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBeNull();
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
  });

  it('presses no Enter while the turn runs, then retries from when the session is waiting again', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(enters()).toEqual([1_000]);
    hook('Stop', 'waiting');
    await vi.advanceTimersByTimeAsync(SUBMIT_RETRY_AFTER_MS[0] - 1);
    expect(enters()).toEqual([1_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(enters()).toEqual([1_000, 9_000 + SUBMIT_RETRY_AFTER_MS[0]]);
    hook('UserPromptSubmit', 'prompting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('submitted');
  });

  it('notices the turn ended without a hook (a silent status change) within a few seconds', async () => {
    track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    setStatus('idle');
    await vi.advanceTimersByTimeAsync(BUSY_PARK_CHECK_MS + SUBMIT_RETRY_AFTER_MS[0]);
    expect(enters()).toHaveLength(2);
  });

  it('stops once the user cancelled the running turn: they took over', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(5_000);
    hook('Stop', 'waiting');
    await vi.advanceTimersByTimeAsync(150);
    setStatus('waiting', { userCancelledAt: Date.now() });
    await vi.advanceTimersByTimeAsync(SUBMIT_RETRY_AFTER_MS[0]);
    expect(result.outcome).toBe('stopped');
    expect(enters()).toEqual([1_000]);
  });

  it('gives up after waiting 15 minutes for the turn to end', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(SUBMIT_ENTER_DELAY_MS + BUSY_PARK_MAX_MS + BUSY_PARK_CHECK_MS);
    expect(result.outcome).toBe('gave-up');
    expect(enters()).toEqual([1_000]);
  });

  it('stops when the session ends meanwhile', async () => {
    const result = track(makeSubmitter().submit(req({ text: 'also this', mode: 'now' })));
    await vi.advanceTimersByTimeAsync(2_000);
    hook('SessionEnd', 'ended');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcome).toBe('stopped');
  });
});

describe('an interrupt alone (a central cancelling its own task)', () => {
  /** Runs `interrupt` without awaiting it: the timers have to be advanced first. */
  function interruptOf(
    target: { sessionId: string; terminalId: string; beforeEsc?: () => void } = { sessionId: 's1', terminalId: T },
  ): { pressed: boolean | null } {
    const box: { pressed: boolean | null } = { pressed: null };
    void makeSubmitter().interrupt(target).then((pressed) => { box.pressed = pressed; });
    return box;
  }

  it('presses Esc on a running turn, resolves once it stops, and types nothing else', async () => {
    setStatus('working');
    const result = interruptOf();
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result.pressed).toBeNull();
    hook('Stop', 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
  });

  it('declines an open dialog with the same Esc', async () => {
    setStatus('approval');
    const result = interruptOf();
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);
    hook('Stop', 'waiting');
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(true);
  });

  it('stops waiting after 10 s when no Stop arrives', async () => {
    setStatus('working');
    const result = interruptOf();
    await vi.advanceTimersByTimeAsync(INTERRUPT_WAIT_MS - 1);
    expect(result.pressed).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result.pressed).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it('presses nothing when no turn runs', async () => {
    const result = interruptOf();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(false);
    expect(writes).toEqual([]);
  });

  it('presses nothing when the session no longer runs in that terminal', async () => {
    setStatus('working', { terminalId: 'term-2' });
    const result = interruptOf();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(false);
    expect(writes).toEqual([]);
  });

  it('presses nothing when the agent is not in front: the shell underneath would get the Esc', async () => {
    setStatus('working');
    agentForeground = false;
    const result = interruptOf();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(false);
    expect(writes).toEqual([]);
  });

  it('answers not pressed when the Esc write fails (the terminal is gone), without waiting', async () => {
    setStatus('working');
    terminalAlive = false;
    const result = interruptOf();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.pressed).toBe(false);
    expect(writes).toEqual([]);
  });

  it('runs beforeEsc just before the Esc is written, and not at all when nothing is pressed', async () => {
    const seen: string[] = [];
    const beforeEsc = (): void => { seen.push(`before:${writes.length}`); };
    setStatus('working');
    interruptOf({ sessionId: 's1', terminalId: T, beforeEsc });
    expect(seen).toEqual(['before:0']);
    expect(writes).toEqual([{ at: 0, data: '\x1b' }]);

    seen.length = 0;
    setStatus('waiting');
    const idle = interruptOf({ sessionId: 's1', terminalId: T, beforeEsc });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.pressed).toBe(false);
    expect(seen).toEqual([]);
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
