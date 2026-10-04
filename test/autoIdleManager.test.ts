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

/**
 * Every transition above happens on the server's own clock, with no hook behind it — so nothing
 * tells the browsers. `onChange` is how the session store learns of them: it invalidates the
 * snapshot cache and broadcasts the change. Without it a badge showed "waiting" or "working"
 * until the next hook event, a click, or a reload (which is served from the same stale cache).
 */
describe('onChange', () => {
  const MIN = 60_000;

  it('reports a prompting → waiting decay once, with the session already in its new state', () => {
    const s = makeSession();
    const onChange = vi.fn();
    noteTerminalOutput('term-1', T0);
    startAutoIdle(new Map([['s1', s]]), onChange);
    runFor(45_000, null);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [changed] = onChange.mock.calls[0] as [Session[]];
    expect(changed).toHaveLength(1);
    expect(changed[0]).toBe(s);
    expect(changed[0].status).toBe('waiting');
  });

  it('reports waiting → idle after five minutes, and not a moment before', () => {
    const s = makeSession({ status: 'waiting' } as Partial<Session>);
    const onChange = vi.fn();
    startAutoIdle(new Map([['s1', s]]), onChange);
    runFor(5 * MIN - 20_000, null);
    expect(onChange).not.toHaveBeenCalled();
    expect(s.status).toBe('waiting');
    runFor(40_000, null);
    expect(s.status).toBe('idle');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0] as [Session[]])[0][0].status).toBe('idle');
  });

  /**
   * The safety nets are guesses for a lost hook, and mostly wrong: the user is away with the permission
   * dialog still up, a question unanswered, or a tool running silently. Announcing them would turn a
   * pending approval's badge to "Idle" and hand the queue an `idle` — which it treats as sendable — to
   * type its next prompt into the dialog. They still happen on the server; they are just not announced.
   */
  it.each([
    ['approval', 10],
    ['input', 10],
    ['working', 15],
  ])('%s → idle after %i minutes still happens, but is NOT announced', (from, minutes) => {
    const s = makeSession({ status: from } as Partial<Session>);
    const onChange = vi.fn();
    startAutoIdle(new Map([['s1', s]]), onChange);
    runFor(minutes * MIN + 20_000, null);
    expect(s.status).toBe('idle');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hands over every session announced in the same tick in ONE call', () => {
    const a = makeSession({ sessionId: 'a', status: 'waiting' } as Partial<Session>);
    const b = makeSession({ sessionId: 'b', status: 'waiting' } as Partial<Session>);
    const quiet = makeSession({ sessionId: 'c', status: 'prompting' } as Partial<Session>);
    const silent = makeSession({ sessionId: 'd', status: 'approval' } as Partial<Session>);
    noteTerminalOutput('term-1', T0);
    const onChange = vi.fn();
    startAutoIdle(new Map([['a', a], ['b', b], ['c', quiet], ['d', silent]]), onChange);
    runFor(5 * MIN + 20_000, 'term-1'); // c keeps printing, so it stays prompting
    expect(onChange).toHaveBeenCalledTimes(1);
    const ids = (onChange.mock.calls[0] as [Session[]])[0].map((x) => x.sessionId).sort();
    expect(ids).toEqual(['a', 'b']);
    expect(quiet.status).toBe('prompting');
    expect(silent.status).toBe('approval'); // ten minutes have not passed
  });

  it('stays silent while nothing changes, and never re-reports a session that is already idle', () => {
    const s = makeSession({ status: 'waiting' } as Partial<Session>);
    const onChange = vi.fn();
    startAutoIdle(new Map([['s1', s]]), onChange);
    runFor(5 * MIN + 20_000, null); // → idle, reported once
    runFor(30 * MIN, null);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('an ended session is left alone', () => {
    const s = makeSession({ status: 'ended' } as Partial<Session>);
    const onChange = vi.fn();
    startAutoIdle(new Map([['s1', s]]), onChange);
    runFor(30 * MIN, null);
    expect(onChange).not.toHaveBeenCalled();
    expect(s.status).toBe('ended');
  });

  it('a throwing handler does not stop the interval: later transitions are still made and reported', () => {
    const a = makeSession({ sessionId: 'a', status: 'waiting' } as Partial<Session>);
    const b = makeSession({ sessionId: 'b', status: 'waiting', lastActivityAt: T0 + 3 * MIN } as Partial<Session>);
    const onChange = vi.fn().mockImplementationOnce(() => { throw new Error('broadcast exploded'); });
    startAutoIdle(new Map([['a', a], ['b', b]]), onChange);
    runFor(5 * MIN + 20_000, null);
    expect(a.status).toBe('idle');
    expect(onChange).toHaveBeenCalledTimes(1);
    runFor(3 * MIN, null); // b's five minutes of silence end later
    expect(b.status).toBe('idle');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('still works with no handler at all (the original signature)', () => {
    const s = makeSession({ status: 'waiting' } as Partial<Session>);
    startAutoIdle(new Map([['s1', s]]));
    runFor(5 * MIN + 20_000, null);
    expect(s.status).toBe('idle');
  });
});
