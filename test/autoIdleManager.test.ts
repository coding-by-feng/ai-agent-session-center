/**
 * The `prompting` auto-decay, driven through the real `startAutoIdle` tick.
 *
 * `prompting → waiting` after 30 s of hook silence exists to free a prompt that
 * never ran (e.g. a UserPromptSubmit hook blocked it — no Stop ever follows).
 * But hook silence alone cannot tell that apart from a turn that is simply
 * busy without firing hooks: Claude thinking or writing before its first tool
 * call (Medium density), or the WHOLE turn at Low density, which sends no tool
 * events. `waiting` is the queue's "turn finished" signal, so the decay used to
 * make the queue send its next prompt into a running turn. A live turn keeps
 * printing (spinner, timer, streamed text); a prompt that never ran does not —
 * so the decay now also requires the terminal to have gone quiet.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startAutoIdle, stopAutoIdle } from '../server/autoIdleManager.js';
import { noteTerminalOutput, resetTerminalActivity } from '../server/terminalActivity.js';
import type { Session } from '../src/types/session.js';

const T0 = 1_800_000_000_000;

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'prompting',
    lastActivityAt: T0, // the UserPromptSubmit that started the turn
    terminalId: 'term-1',
    animationState: 'Walking',
    emote: null,
    pendingTool: null,
    pendingToolDetail: null,
    waitingDetail: null,
    ...over,
  } as unknown as Session;
}

/** Advance in 1 s steps; `printing` simulates the CLI's spinner/stream output. */
function runFor(ms: number, printing: string | null): void {
  for (let t = 0; t < ms; t += 1000) {
    if (printing) noteTerminalOutput(printing, Date.now());
    vi.advanceTimersByTime(1000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetTerminalActivity();
});

afterEach(() => {
  stopAutoIdle();
  vi.useRealTimers();
});

describe('prompting auto-decay', () => {
  it('a prompt that never ran (terminal quiet too) still decays to waiting after 30 s', () => {
    const s = makeSession();
    noteTerminalOutput('term-1', T0); // the prompt echo, then nothing
    startAutoIdle(new Map([['s1', s]]));
    runFor(45_000, null);
    expect(s.status).toBe('waiting');
  });

  it('a turn that is still printing stays prompting — no fake "finished" mid-turn', () => {
    const s = makeSession();
    startAutoIdle(new Map([['s1', s]]));
    runFor(120_000, 'term-1'); // two minutes of thinking/streaming, zero hooks
    expect(s.status).toBe('prompting');
  });

  it('decays once the terminal goes quiet after the output stops', () => {
    const s = makeSession();
    startAutoIdle(new Map([['s1', s]]));
    runFor(60_000, 'term-1');
    expect(s.status).toBe('prompting');
    runFor(45_000, null);
    expect(s.status).toBe('waiting');
  });

  it('a session with no AASC terminal keeps the old hook-only rule', () => {
    const s = makeSession({ terminalId: null } as Partial<Session>);
    startAutoIdle(new Map([['s1', s]]));
    runFor(45_000, null);
    expect(s.status).toBe('waiting');
  });

  it('a turn that keeps printing is never decayed, however long it runs', () => {
    // A 15-minute flip to idle used to fire here. The turn is live, and idle
    // is sendable to the queue and is the edge the Remote Control relink
    // types into — so both would land in a running turn.
    const s = makeSession();
    startAutoIdle(new Map([['s1', s]]));
    runFor(20 * 60_000, 'term-1');
    expect(s.status).toBe('prompting');
    runFor(45_000, null); // once it goes quiet, the ordinary rules apply again
    expect(s.status).not.toBe('prompting');
  });
});
