/**
 * The queue scheduler's send decision, driven through the real hook with a
 * 1 s fake-timer tick. Only the PTY write is mocked.
 *
 * Two things reach `waiting` — the queue's "turn finished" signal — without the
 * turn being finished, and neither may send the next prompt:
 *   - the user stopped the turn with Esc (Claude Code fires a real Stop for it,
 *     so the session lands in `waiting` exactly like a clean finish; the server
 *     marks `userCancelledAt` from the CLI's own "What should Claude do
 *     instead?" line);
 *   - subagents still running after the main agent's Stop (`subagentCount`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('@/lib/terminalSend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminalSend')>()),
  sendPromptToTerminal: vi.fn(async () => true),
  pressEnterInTerminal: vi.fn(async () => true),
}));
const baton = vi.hoisted(() => ({ mine: true }));
vi.mock('@/stores/presenceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/presenceStore')>()),
  canControlSession: () => baton.mine,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/stores/queueSentStore', () => ({ recordQueueSent: vi.fn() }));

import { useGlobalQueueScheduler } from './useGlobalQueueScheduler';
import { sendPromptToTerminal, pressEnterInTerminal, IMAGE_SUBMIT_ENTER_DELAY_MS } from '@/lib/terminalSend';
import { SUBMIT_GIVE_UP_GRACE_MS, SUBMIT_RETRY_AFTER_MS } from '@/lib/submitConfirm';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, DEFAULT_AUTOMATION, type QueueItem } from '@/stores/queueStore';
import { recordQueueSent } from '@/stores/queueSentStore';
import type { Session } from '@/types';

const T0 = 1_800_000_000_000;
const send = vi.mocked(sendPromptToTerminal);
const pressEnter = vi.mocked(pressEnterInTerminal);
const toast = vi.mocked(showToast);

function Harness() {
  useGlobalQueueScheduler();
  return null;
}

function setSession(over: Partial<Session>) {
  const prev = useSessionStore.getState().sessions.get('s1');
  const session = {
    sessionId: 's1',
    title: 'SMS Fixing',
    status: 'waiting',
    terminalId: 'term-1',
    lastActivityAt: T0,
    interruption: null,
    subagentCount: 0,
    userCancelledAt: null,
    ...prev,
    ...over,
  } as unknown as Session;
  useSessionStore.setState({ sessions: new Map([['s1', session]]) } as never);
}

function queueOnce(text: string) {
  const item: QueueItem = { id: 1, sessionId: 's1', text, position: 0, createdAt: T0, type: 'once' };
  useQueueStore.setState({ queues: new Map([['s1', [item]]]), automation: new Map() });
}

/** Advance the fake clock in small steps so async sends settle between ticks. */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => { vi.advanceTimersByTime(100); });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  send.mockReset();
  send.mockImplementation(async () => true);
  pressEnter.mockClear();
  toast.mockClear();
  baton.mine = true;
  useSessionStore.setState({ sessions: new Map() } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useQueueStore.setState({ queues: new Map(), automation: new Map() });
});

describe('useGlobalQueueScheduler — what counts as "turn finished"', () => {
  it('baseline: a normally finished turn sends the next queued prompt', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('next prompt');
  });

  it('records what it sent on the Mac, so every device can badge it as queue-sent', async () => {
    vi.mocked(recordQueueSent).mockClear();
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(3000);
    expect(recordQueueSent).toHaveBeenCalledWith('s1', { text: 'next prompt', sentAt: expect.any(Number) });
  });

  it('records nothing when the send failed', async () => {
    vi.mocked(recordQueueSent).mockClear();
    send.mockImplementation(async () => false);
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(3000);
    expect(recordQueueSent).not.toHaveBeenCalled();
  });

  it('records nothing with Auto-Enter off — the text was only typed, not sent', async () => {
    vi.mocked(recordQueueSent).mockClear();
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordQueueSent).not.toHaveBeenCalled();
  });

  it('after an Esc-cancel (a real Stop), nothing sends', async () => {
    setSession({ status: 'waiting', userCancelledAt: T0 });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('Resume (the cancel mark cleared) lets the queue continue', async () => {
    setSession({ status: 'waiting', userCancelledAt: T0 });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(3000);
    expect(send).not.toHaveBeenCalled();
    act(() => { setSession({ userCancelledAt: null }); });
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('holds while subagents are still running, and sends once they finish', async () => {
    setSession({ status: 'waiting', subagentCount: 2, lastActivityAt: T0 });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(4000);
    expect(send).not.toHaveBeenCalled();
    act(() => { setSession({ subagentCount: 0, lastActivityAt: Date.now() }); });
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('while held, ⚡ NOW sends the item you forced — not the stopped chain\'s next step', async () => {
    setSession({ status: 'waiting', userCancelledAt: T0 });
    const chain: QueueItem = {
      id: 1, sessionId: 's1', text: 'main step', position: 0, createdAt: T0, type: 'once',
      execState: 'main', afterChain: [{ text: 'after step' } as never],
    };
    const forced: QueueItem = { id: 2, sessionId: 's1', text: 'forced prompt', position: 1, createdAt: T0, type: 'once', forceStart: true };
    useQueueStore.setState({ queues: new Map([['s1', [chain, forced]]]), automation: new Map() });
    render(<Harness />);
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toBe('forced prompt');
  });

  it('a whole turn landing between two ticks still waits out the settle', async () => {
    // Held by subagents while `waiting` settles. Then, inside one tick gap,
    // the subagents finish and a new turn ends (same status, newer activity),
    // and the cancel mark follows 600 ms later.
    setSession({ status: 'waiting', subagentCount: 1, lastActivityAt: T0 });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(3900); // ticks at +1 s, +2 s, +3 s; the next is at +4 s
    expect(send).not.toHaveBeenCalled();
    act(() => { setSession({ subagentCount: 0, lastActivityAt: Date.now() }); });
    await advance(600);
    act(() => { setSession({ userCancelledAt: Date.now() }); });
    await advance(4000);
    expect(send).not.toHaveBeenCalled();
  });

  it('the race: Stop lands first and the cancel mark a moment later — still nothing sends', async () => {
    setSession({ status: 'prompting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(1500);
    act(() => { setSession({ status: 'waiting', lastActivityAt: Date.now() }); }); // the Stop from Esc
    await advance(600); // a scheduler tick sees `waiting` in here
    act(() => { setSession({ userCancelledAt: Date.now() }); }); // the cancel line, just after
    await advance(4000);
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * A prompt the CLI never took. Claude Code's fullscreen TUI needs ~1.3 s (more
 * under load) to take in a pasted image path, and an Enter that lands inside
 * that is swallowed: the text sits in the input box ("review and press Enter to
 * send"), no hook ever fires, and the queue — which already removed the item —
 * has nothing left to continue from. The scheduler presses Enter again until a
 * hook or a busy status acknowledges the prompt.
 */
describe('useGlobalQueueScheduler — a sent prompt the CLI never took', () => {
  it('presses Enter again when nothing acknowledges the prompt, and stops once something does', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    const enterAt = Date.now();

    await advance(SUBMIT_RETRY_AFTER_MS[0] + 1000);
    expect(pressEnter).toHaveBeenCalledTimes(1);
    expect(pressEnter).toHaveBeenCalledWith('term-1');
    expect(Date.now() - enterAt).toBeGreaterThanOrEqual(SUBMIT_RETRY_AFTER_MS[0]);

    act(() => { setSession({ status: 'prompting', lastActivityAt: Date.now() }); }); // UserPromptSubmit
    await advance(70_000);
    expect(pressEnter).toHaveBeenCalledTimes(1);
  });

  it('gives up after the scheduled retries — and says so, once', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    const last = SUBMIT_RETRY_AFTER_MS[SUBMIT_RETRY_AFTER_MS.length - 1];
    await advance(2000 + last + 2000);
    expect(pressEnter).toHaveBeenCalledTimes(SUBMIT_RETRY_AFTER_MS.length);
    expect(toast.mock.calls.filter((c) => c[1] === 'error')).toHaveLength(0);

    await advance(SUBMIT_GIVE_UP_GRACE_MS + 120_000);
    expect(pressEnter).toHaveBeenCalledTimes(SUBMIT_RETRY_AFTER_MS.length);
    const errors = toast.mock.calls.filter((c) => c[1] === 'error');
    expect(errors).toHaveLength(1);
    expect(String(errors[0][0])).toMatch(/press Enter/i);
  });

  it('stops pressing Enter once Auto-Enter is switched off after the send', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    act(() => { useQueueStore.getState().setAutoEnter('s1', false); });
    await advance(70_000);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('drops the retry when the queue is paused, and does not resume it on unpause', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(2000);
    act(() => { useQueueStore.getState().setPaused('s1', true); });
    await advance(5000);
    act(() => { useQueueStore.getState().setPaused('s1', false); });
    await advance(70_000);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('drops the retry when another device takes the baton', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(2000);
    baton.mine = false;
    await advance(5000);
    baton.mine = true;
    await advance(70_000);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('never presses Enter into a different terminal', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    render(<Harness />);
    await advance(2000);
    act(() => { setSession({ terminalId: 'term-2' }); });
    await advance(70_000);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('a hook that lands DURING the send acknowledges it (the stamp is taken before the send)', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    send.mockImplementationOnce(async () => {
      // UserPromptSubmit arrives inside the Enter delay; the status update lags.
      setSession({ lastActivityAt: Date.now() + 1 });
      return true;
    });
    render(<Harness />);
    await advance(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('never presses Enter again after a slash command (it may have opened a picker)', async () => {
    setSession({ status: 'waiting' });
    queueOnce('/model');
    render(<Harness />);
    await advance(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('never presses Enter with Auto-Enter off', async () => {
    setSession({ status: 'waiting' });
    queueOnce('next prompt');
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);
    await advance(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pressEnter).not.toHaveBeenCalled();
  });

  it('the /clear incident: the prompt queued after /clear is still submitted when its first Enter is swallowed', async () => {
    const IMG = '/tmp/claude-queue-images/queue-img-1791329416741-u76qcd.png';
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === '/api/queue-images'
        ? new Response(JSON.stringify({ paths: [IMG] }), { status: 200 })
        : new Response('{}', { status: 200 }),
    ));
    const session = (over: Partial<Session>) =>
      ({
        sessionId: 's1', title: 'AASC Q & A', status: 'waiting', terminalId: 'term-1', lastActivityAt: T0,
        interruption: null, subagentCount: 0, userCancelledAt: null, ...over,
      }) as unknown as Session;
    useSessionStore.setState({ sessions: new Map([['s1', session({})]]) } as never);
    const clear: QueueItem = { id: 1, sessionId: 's1', text: '/clear', position: 0, createdAt: T0, type: 'once' };
    const next: QueueItem = {
      id: 2, sessionId: 's1', text: 'if we wanna provide uninstallation for skills /rar', position: 1, createdAt: T0,
      type: 'once', images: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' } as never],
    };
    useQueueStore.setState({ queues: new Map([['s1', [clear, next]]]), automation: new Map() });
    render(<Harness />);
    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/clear']);

    // SessionEnd(clear) — the old id is ended for a few seconds…
    act(() => { useSessionStore.getState().updateSession(session({ status: 'ended', lastActivityAt: Date.now() })); });
    await advance(4700);
    // …then SessionStart(clear) re-keys the card onto the CLI's new id.
    act(() => {
      useQueueStore.getState().migrateSession('s1', 's2');
      useSessionStore.getState().updateSession(
        session({ sessionId: 's2', status: 'idle', lastActivityAt: Date.now(), replacesId: 's1' } as Partial<Session>),
      );
    });
    await advance(3000);
    expect(send).toHaveBeenCalledTimes(2);
    // The exact shape that was lost: the text, a newline, then the image path…
    expect(send.mock.calls[1][1]).toBe(`if we wanna provide uninstallation for skills /rar\n${IMG}`);
    // …now given the longer pause before its Enter.
    expect(send.mock.calls[1][3]).toBe(IMAGE_SUBMIT_ENTER_DELAY_MS);
    expect(send.mock.calls[0][3]).not.toBe(IMAGE_SUBMIT_ENTER_DELAY_MS); // /clear has no image
    expect(pressEnter).not.toHaveBeenCalled(); // /clear itself is never re-entered

    // The CLI swallowed that Enter: no hook, the session just sits idle.
    await advance(SUBMIT_RETRY_AFTER_MS[0] + 1000);
    expect(pressEnter).toHaveBeenCalledWith('term-1');
    const presses = pressEnter.mock.calls.length;

    // The retried Enter landed: UserPromptSubmit arrives and the retries stop.
    act(() => {
      useSessionStore.getState().updateSession(session({ sessionId: 's2', status: 'prompting', lastActivityAt: Date.now() }));
    });
    await advance(70_000);
    expect(pressEnter).toHaveBeenCalledTimes(presses);
  });
});

describe('useGlobalQueueScheduler — the prompt queued after /compact', () => {
  // /compact keeps the session id and ends with SessionStart(source: compact), which
  // the server maps to `idle`. There is no Stop, so the status never reaches `waiting`.
  const ev = (type: string, timestamp: number) => ({ type, timestamp, detail: '' });
  const session = (over: Partial<Session>) =>
    ({
      sessionId: 's1', title: 'AASC Q & A', status: 'waiting', terminalId: 'term-1', lastActivityAt: T0,
      interruption: null, subagentCount: 0, userCancelledAt: null, events: [ev('Stop', T0)], ...over,
    }) as unknown as Session;
  const queueCompactThenPrompt = () => {
    const compact: QueueItem = { id: 1, sessionId: 's1', text: '/compact', position: 0, createdAt: T0, type: 'once' };
    const next: QueueItem = { id: 2, sessionId: 's1', text: 'carry on with the plan', position: 1, createdAt: T0, type: 'once' };
    useQueueStore.setState({ queues: new Map([['s1', [compact, next]]]), automation: new Map() });
  };

  it('sends the next prompt once compaction finishes (SessionStart, status idle)', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({})]]) } as never);
    queueCompactThenPrompt();
    render(<Harness />);
    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/compact']);

    // Compaction runs (~70 s, no hooks), then the CLI reports SessionStart.
    await advance(70_000);
    expect(send).toHaveBeenCalledTimes(1);
    act(() => {
      const now = Date.now();
      useSessionStore.getState().updateSession(
        session({ status: 'idle', lastActivityAt: now, events: [ev('Stop', T0), ev('SessionStart', now)] }),
      );
    });
    await advance(3000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/compact', 'carry on with the plan']);
  });

  it('an automatic mid-turn compaction does not release the gate of an ordinary prompt', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({})]]) } as never);
    const a: QueueItem = { id: 1, sessionId: 's1', text: 'long task', position: 0, createdAt: T0, type: 'once' };
    const b: QueueItem = { id: 2, sessionId: 's1', text: 'next', position: 1, createdAt: T0, type: 'once' };
    useQueueStore.setState({ queues: new Map([['s1', [a, b]]]), automation: new Map() });
    render(<Harness />);
    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['long task']);

    // The long turn fills the context: Claude compacts by itself and carries on.
    act(() => {
      const t = Date.now();
      useSessionStore.getState().updateSession(
        session({ status: 'working', lastActivityAt: t, events: [ev('Stop', T0), ev('UserPromptSubmit', t)] }),
      );
    });
    await advance(2000);
    act(() => {
      const t = Date.now();
      useSessionStore.getState().updateSession(
        session({ status: 'idle', lastActivityAt: t, events: [ev('UserPromptSubmit', T0), ev('PreToolUse', T0), ev('SessionStart', t)] }),
      );
    });
    await advance(10_000); // the model thinks before its next tool call
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a SessionStart from before the send does not release the gate', async () => {
    // Fresh session: idle, last event SessionStart. Auto-Enter off, so /compact sits unsent.
    useSessionStore.setState({ sessions: new Map([['s1', session({ status: 'idle', events: [ev('SessionStart', T0)] })]]) } as never);
    queueCompactThenPrompt();
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);
    await advance(2000);
    expect(send).toHaveBeenCalledTimes(1);

    // The idle-prompt Notification moves activity; the old SessionStart is still the latest start.
    act(() => {
      const t = Date.now();
      useSessionStore.getState().updateSession(
        session({ status: 'idle', lastActivityAt: t, events: [ev('SessionStart', T0), ev('Notification', t)] }),
      );
    });
    await advance(30_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('still holds when the session merely decayed to idle after real work', async () => {
    useSessionStore.setState({ sessions: new Map([['s1', session({})]]) } as never);
    queueCompactThenPrompt();
    render(<Harness />);
    await advance(2000);
    expect(send).toHaveBeenCalledTimes(1);

    // The CLI took the prompt (activity moved) and the status later decayed to idle,
    // with no SessionStart: that is a stuck turn, not a finished one.
    act(() => {
      const now = Date.now();
      useSessionStore.getState().updateSession(
        session({ status: 'idle', lastActivityAt: now, events: [ev('Stop', T0), ev('PreToolUse', now)] }),
      );
    });
    await advance(30_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('useGlobalQueueScheduler — a queued /effort step', () => {
  // `/effort <level>` is answered by the TUI itself and fires no hook (probed on Claude
  // Code 2.1.296: three commands, zero events). The session therefore stays `waiting`
  // with an unmoved lastActivityAt — exactly what a prompt the CLI never took looks like.
  const effortChain = (before: string): QueueItem => ({
    id: 1, sessionId: 's1', text: 'do the work', position: 0, createdAt: T0, type: 'once',
    beforeChain: [{ id: 10, text: before }],
    afterChain: [{ id: 11, text: '/effort high' }],
  });
  const queueChain = (item: QueueItem) =>
    useQueueStore.setState({ queues: new Map([['s1', [item]]]), automation: new Map() });

  it('REGRESSION: the main prompt follows a before-step `/effort` in seconds, not after the 5-minute no-op fallback', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort max'));
    render(<Harness />);

    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max']);

    await advance(60_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max', 'do the work']);
  });

  it('holds the main prompt for a moment first, so the TUI has answered before it is typed', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort max'));
    render(<Harness />);

    await advance(2000);
    expect(send).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs the AFTER-chain `/effort` once the main turn has finished, then the chain is done', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort max'));
    render(<Harness />);
    await advance(8000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max', 'do the work']);

    // The main prompt is a real turn: hooks move activity, it goes busy, then Stop.
    act(() => { setSession({ status: 'working', lastActivityAt: Date.now() }); });
    await advance(1500);
    act(() => { setSession({ status: 'waiting', lastActivityAt: Date.now() }); });
    await advance(3000);

    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max', 'do the work', '/effort high']);
    expect(useQueueStore.getState().queues.get('s1') ?? []).toHaveLength(0);
  });

  it('with Auto-Enter off the long fallback stays: the command was only typed, never submitted', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort max'));
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);

    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max']);
    await advance(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: turning Auto-Enter ON after an `/effort` was only typed does not release the next step onto the unsent line', async () => {
    // Auto-Enter off: `/effort max` sits typed in the input, never submitted. The gate must
    // remember THAT, not just that the text looked like /effort — otherwise flipping
    // Auto-Enter on later finds the 3 s long past and types "do the work" + Enter right
    // after it, submitting `/effort maxdo the work`.
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort max'));
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);

    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort max']);
    await advance(60_000);

    act(() => {
      useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: true }]]) });
    });
    await advance(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not extend the short release to other slash commands — `/context` still waits for its signal', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/context'));
    render(<Harness />);

    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/context']);
    await advance(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not release on a typo: `/effort turbo` is an ordinary step', async () => {
    setSession({ status: 'waiting' });
    queueChain(effortChain('/effort turbo'));
    render(<Harness />);

    await advance(2000);
    await advance(60_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/effort turbo']);
  });
});

describe('useGlobalQueueScheduler — a queued /model step', () => {
  // `/model <name>` is a local command like `/effort <level>`: the TUI answers it and no
  // turn runs, so the chain must not wait out the 5-minute no-op fallback behind it.
  const modelChain = (before: string): QueueItem => ({
    id: 1, sessionId: 's1', text: 'do the work', position: 0, createdAt: T0, type: 'once',
    beforeChain: [{ id: 10, text: before }],
  });
  const queueChain = (item: QueueItem) =>
    useQueueStore.setState({ queues: new Map([['s1', [item]]]), automation: new Map() });

  it('the main prompt follows a before-step `/model <name>` in seconds', async () => {
    setSession({ status: 'waiting' });
    queueChain(modelChain('/model opus'));
    render(<Harness />);

    await advance(2000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/model opus']);
    await advance(60_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/model opus', 'do the work']);
  });

  it('REGRESSION GUARD: a bare `/model` opens the CLI picker, so the next step is never released into it', async () => {
    setSession({ status: 'waiting' });
    queueChain(modelChain('/model'));
    render(<Harness />);

    await advance(2000);
    await advance(60_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/model']);
  });

  it('with Auto-Enter off the long fallback stays: the command was only typed', async () => {
    setSession({ status: 'waiting' });
    queueChain(modelChain('/model haiku'));
    useQueueStore.setState({ automation: new Map([['s1', { ...DEFAULT_AUTOMATION, autoEnter: false }]]) });
    render(<Harness />);

    await advance(2000);
    await advance(10 * 60_000);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['/model haiku']);
  });
});
