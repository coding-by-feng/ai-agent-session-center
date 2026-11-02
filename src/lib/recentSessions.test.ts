import { describe, it, expect } from 'vitest';
import {
  RECENT_LIMIT,
  recencyOf,
  lastPromptAt,
  lastWorkAt,
  lastWorkEventAt,
  pickRecentSessions,
} from './recentSessions';
import type { Session } from '@/types/session';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const ev = (type: string, minutesAgo: number) => ({ type, timestamp: NOW - minutesAgo * MIN, detail: '' });
const prompt = (minutesAgo: number, text = 'do it') => ({ text, timestamp: NOW - minutesAgo * MIN });

function make(over: Partial<Session> = {}): Session {
  return {
    sessionId: over.sessionId ?? 's1',
    title: over.title ?? 'Session',
    projectName: 'agent-manager',
    status: over.status ?? 'idle',
    startedAt: NOW - 120 * MIN,
    lastActivityAt: NOW,
    events: [],
    promptHistory: [],
    ...over,
  } as Session;
}

describe('recencyOf', () => {
  it('is the time of the last work for a session that finished a turn', () => {
    const s = make({
      status: 'idle',
      events: [ev('UserPromptSubmit', 12), ev('PreToolUse', 11), ev('Stop', 5)],
      promptHistory: [prompt(12)],
    });
    expect(recencyOf(s, NOW)).toBe(NOW - 5 * MIN);
  });

  it('keeps an old session ranked by its old work: no time window any more', () => {
    const s = make({ events: [ev('UserPromptSubmit', 50), ev('Stop', 40)], promptHistory: [prompt(50)] });
    expect(recencyOf(s, NOW)).toBe(NOW - 40 * MIN);
  });

  it('ranks a restored session by its real prompts, never by the SessionStart a restore gives it', () => {
    // The trap this module exists for: each SessionStart stamps lastActivityAt = now.
    const restored = make({
      lastActivityAt: NOW,
      events: [ev('SessionStart', 0)],
      promptHistory: [prompt(600, 'from before the restart')],
    });
    expect(recencyOf(restored, NOW)).toBe(NOW - 600 * MIN);
  });

  it('counts a running turn as now, even with no fresh events', () => {
    // At Low hook density a turn emits nothing between its prompt and its Stop.
    for (const status of ['prompting', 'working', 'approval', 'input'] as const) {
      const s = make({ status, events: [ev('UserPromptSubmit', 90)], promptHistory: [prompt(90)] });
      expect(recencyOf(s, NOW), status).toBe(NOW);
    }
  });

  it('is 0 for an ended session', () => {
    expect(recencyOf(make({ status: 'ended', events: [ev('Stop', 1)], promptHistory: [prompt(2)] }), NOW)).toBe(0);
  });

  it('does not count app-internal markers or session start/end as work', () => {
    const markers = ['SessionStart', 'SessionEnd', 'ServerRestart', 'AutoRevived', 'TerminalCreated',
      'ResumeRequested', 'ResumeNewTerminal', 'SessionDiscovered'];
    expect(recencyOf(make({ events: markers.map((m) => ev(m, 1)) }), NOW)).toBe(0);
  });

  it('tolerates thin sessions with no events or prompt history', () => {
    const thin = { ...make(), events: undefined, promptHistory: undefined } as unknown as Session;
    expect(recencyOf(thin, NOW)).toBe(0);
    expect(lastWorkAt(thin)).toBe(0);
    expect(lastPromptAt(thin)).toBe(0);
  });
});

describe('pickRecentSessions', () => {
  it('keeps a session that went quiet long ago, newest prompt first', () => {
    const old = make({ sessionId: 'old', title: 'Old', promptHistory: [prompt(90)], events: [ev('Stop', 80)] });
    const a = make({ sessionId: 'a', title: 'A', promptHistory: [prompt(20)], events: [ev('Stop', 2)] });
    const b = make({ sessionId: 'b', title: 'B', promptHistory: [prompt(4)], events: [ev('Stop', 3)] });
    const never = make({ sessionId: 'never', title: 'Never' });
    expect(pickRecentSessions([old, a, b, never], NOW).map((s) => s.sessionId)).toEqual(['b', 'a', 'old']);
  });

  it(`keeps the ${RECENT_LIMIT} that worked most recently, running turns included`, () => {
    const quiet = Array.from({ length: 12 }, (_, i) =>
      make({ sessionId: `q${i}`, title: `Q${i}`, promptHistory: [prompt(100 + i * 10)] }));
    const running = make({ sessionId: 'run', title: 'Run', status: 'working', promptHistory: [prompt(500)] });
    const picked = pickRecentSessions([...quiet, running], NOW).map((s) => s.sessionId);
    expect(picked).toHaveLength(RECENT_LIMIT);
    expect(picked).toContain('run'); // ranked as now, though its prompt is the oldest
    expect(picked).not.toContain('q9'); // the oldest quiet ones fall off
    expect(picked).not.toContain('q11');
  });

  it('orders by prompt, not by the latest event, so busy cards do not swap places', () => {
    // A was prompted earlier but its tools are firing right now. Ordering by
    // the latest event would flip A and B on every tool call.
    const a = make({ sessionId: 'a', title: 'A', status: 'working', promptHistory: [prompt(6)], events: [ev('PostToolUse', 0)] });
    const b = make({ sessionId: 'b', title: 'B', status: 'working', promptHistory: [prompt(2)], events: [ev('PostToolUse', 1)] });
    expect(pickRecentSessions([a, b], NOW).map((s) => s.sessionId)).toEqual(['b', 'a']);
  });

  it('puts pinned sessions first, like every other session ordering', () => {
    const a = make({ sessionId: 'a', title: 'A', promptHistory: [prompt(1)] });
    const p = make({ sessionId: 'p', title: 'P', pinned: true, promptHistory: [prompt(10)] });
    expect(pickRecentSessions([a, p], NOW).map((s) => s.sessionId)).toEqual(['p', 'a']);
  });

  it('puts never-prompted sessions last, then breaks ties by title and id', () => {
    const running = make({ sessionId: 'r', title: 'Running', status: 'working' });
    const z = make({ sessionId: 'z2', title: 'Same', promptHistory: [prompt(5)] });
    const y = make({ sessionId: 'z1', title: 'Same', promptHistory: [prompt(5)] });
    expect(pickRecentSessions([running, z, y], NOW).map((s) => s.sessionId)).toEqual(['z1', 'z2', 'r']);
  });

  it('does not reorder the array it was given', () => {
    const a = make({ sessionId: 'a', promptHistory: [prompt(9)] });
    const b = make({ sessionId: 'b', promptHistory: [prompt(1)] });
    const input = [a, b];
    pickRecentSessions(input, NOW);
    expect(input.map((s) => s.sessionId)).toEqual(['a', 'b']);
  });
});

describe('lastWorkEventAt — the newest work hook event, never a prompt', () => {
  it('is the time of the newest work event', () => {
    const session = make({ events: [ev('PreToolUse', 30), ev('Stop', 12), ev('Notification', 11)] });
    expect(lastWorkEventAt(session)).toBe(NOW - 11 * MIN);
  });

  it('ignores a prompt, even a newer one: a prompt is not a work event', () => {
    const session = make({ events: [ev('Stop', 40)], promptHistory: [prompt(5)] });
    expect(lastWorkEventAt(session)).toBe(NOW - 40 * MIN);
    expect(lastWorkAt(session)).toBe(NOW - 5 * MIN);
  });

  it('is 0 for a restored session: its prompts came back from the database but its events started over', () => {
    const restored = make({
      events: [ev('TerminalCreated', 1), ev('SessionStart', 1)],
      promptHistory: [prompt(180)],
    });
    expect(lastWorkEventAt(restored)).toBe(0);
    // RECENT still reads the prompt, as it always did
    expect(lastWorkAt(restored)).toBe(NOW - 180 * MIN);
  });

  it('skips app-internal markers and session start/end', () => {
    const session = make({ events: [ev('Stop', 20), ev('ServerRestart', 3), ev('AutoRevived', 2), ev('SessionEnd', 1)] });
    expect(lastWorkEventAt(session)).toBe(NOW - 20 * MIN);
  });

  it('is 0 for a thin session with no events at all', () => {
    expect(lastWorkEventAt({ sessionId: 'x', status: 'idle' })).toBe(0);
    expect(lastWorkEventAt(make({ events: null as never }))).toBe(0);
  });
});
