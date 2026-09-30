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

vi.mock('@/lib/terminalSend', () => ({ sendPromptToTerminal: vi.fn(async () => true) }));
vi.mock('@/stores/presenceStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/presenceStore')>()),
  canControlSession: () => true,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import { useGlobalQueueScheduler } from './useGlobalQueueScheduler';
import { sendPromptToTerminal } from '@/lib/terminalSend';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import type { Session } from '@/types';

const T0 = 1_800_000_000_000;
const send = vi.mocked(sendPromptToTerminal);

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
  send.mockClear();
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
