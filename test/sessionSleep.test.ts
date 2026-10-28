// test/sessionSleep.test.ts — idle sessions put to sleep (server/sessionSleep.ts).
// Never reaches a real process: closeTerminal and markAsleep are fakes.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSleepSettingForTest,
  getSleepIdleMinutes,
  setSleepIdleMinutes,
  sleepRefusal,
  sweepIdleSessions,
  type SleepContext,
} from '../server/sessionSleep.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const MIN = 60_000;
const NOW = 1_000 * MIN;
const ID = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function idle(over: Record<string, any> = {}): any {
  return {
    sessionId: ID,
    status: 'waiting',
    terminalId: 'term-1',
    lastActivityAt: NOW - 90 * MIN,
    startupCommand: 'claude --model opus',
    ...over,
  };
}

function ctx(over: Partial<SleepContext> = {}): SleepContext {
  return {
    now: NOW,
    idleMinutes: 60,
    terminalSleepable: () => true,
    lastOutputAt: () => undefined,
    hasArmedQueue: () => false,
    ...over,
  };
}

describe('sleepRefusal', () => {
  it('lets a long-idle local claude or codex session sleep', () => {
    expect(sleepRefusal(idle(), ctx())).toBeNull();
    expect(sleepRefusal(idle({ status: 'idle', startupCommand: 'FOO=1 codex' }), ctx())).toBeNull();
  });

  it.each([
    ['off', idle(), { idleMinutes: 0 }],
    ['asleep', idle({ asleepAt: 1 }), {}],
    ['busy', idle({ status: 'working' }), {}],
    ['busy', idle({ status: 'approval' }), {}],
    ['busy', idle({ status: 'input' }), {}],
    ['no-terminal', idle({ terminalId: null }), {}],
    ['no-terminal', idle(), { terminalSleepable: () => false }],
    ['pinned', idle({ pinned: true }), {}],
    ['central', idle({ central: { kind: 'global' } }), {}],
    ['hands-off', idle({ handsOff: true }), {}],
    ['floating', idle({ isFloating: true }), {}],
    ['background-shells', idle({ backgroundTaskCount: 1 }), {}],
    ['asking', idle({ pendingRequest: { kind: 'question' } }), {}],
    ['not-resumable', idle({ sessionId: 'term-abc' }), {}],
    ['not-resumable', idle({ startupCommand: 'zsh' }), {}],
    ['remote', idle({ sshConfig: { host: 'build-box', command: 'claude' } }), {}],
    ['recent', idle({ lastActivityAt: NOW - 30 * MIN }), {}],
    ['recent', idle(), { lastOutputAt: () => NOW - 5 * MIN }],
    ['queue-armed', idle(), { hasArmedQueue: () => true }],
  ])('keeps it awake: %s', (reason, session, over) => {
    expect(sleepRefusal(session, ctx(over as Partial<SleepContext>))).toBe(reason);
  });
});

describe('sweepIdleSessions', () => {
  it('marks a session asleep BEFORE closing its terminal, and only the ones that may sleep', async () => {
    const order: string[] = [];
    const slept = await sweepIdleSessions({
      sessions: () => [idle(), idle({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', terminalId: 'term-2', pinned: true })],
      idleMinutes: () => 60,
      terminalSleepable: () => true,
      lastOutputAt: () => undefined,
      hasArmedQueue: () => false,
      markAsleep: (id, at) => { order.push(`mark ${id.slice(0, 4)} ${at}`); },
      closeTerminal: async (t) => { order.push(`close ${t}`); return true; },
      now: () => NOW,
    });
    expect(slept).toEqual([ID]);
    expect(order).toEqual([`mark 0f8b ${NOW}`, 'close term-1']);
  });

  it('does nothing while the setting is off', async () => {
    const close = vi.fn(async () => true);
    const slept = await sweepIdleSessions({
      sessions: () => [idle()], idleMinutes: () => 0, terminalSleepable: () => true,
      lastOutputAt: () => undefined, hasArmedQueue: () => false, markAsleep: vi.fn(), closeTerminal: close,
    });
    expect(slept).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('keeps going when one close fails', async () => {
    const slept = await sweepIdleSessions({
      sessions: () => [idle(), idle({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', terminalId: 'term-2' })],
      idleMinutes: () => 60, terminalSleepable: () => true, lastOutputAt: () => undefined, hasArmedQueue: () => false,
      markAsleep: vi.fn(),
      closeTerminal: async (t) => { if (t === 'term-1') throw new Error('boom'); return true; },
      now: () => NOW,
    });
    expect(slept).toHaveLength(2);
  });
});

describe('the sleep setting', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aasc-sleep-'));
    process.env.AASC_SESSION_SLEEP_FILE = join(dir, 'session-sleep.json');
    __resetSleepSettingForTest();
  });
  afterEach(() => {
    delete process.env.AASC_SESSION_SLEEP_FILE;
    __resetSleepSettingForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is off by default', () => {
    expect(getSleepIdleMinutes()).toBe(0);
  });

  it('saves a choice and reads it back after a restart', () => {
    setSleepIdleMinutes(60);
    __resetSleepSettingForTest();
    expect(getSleepIdleMinutes()).toBe(60);
  });

  it('refuses a value that is not one of the choices', () => {
    expect(() => setSleepIdleMinutes(7)).toThrow(RangeError);
  });
});
