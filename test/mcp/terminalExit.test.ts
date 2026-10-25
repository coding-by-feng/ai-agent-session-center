// test/mcp/terminalExit.test.ts — the feed of terminals going away (`onTerminalExit` in sshManager) that
// the central lifecycle listens to.
//
// `terminal_closed` goes only to the terminal's own subscribers, and the PTY exit callback is one slot
// that sessionStore holds, so a central's lifecycle needs a feed of its own. It must fire for every way a
// terminal leaves: the PTY exiting by itself, and a terminal closed on purpose (kill, close, delete,
// restart), which disposes the PTY's exit handler first and so never reaches it.
//
// No PTY is real: node-pty is a recording stand-in that can play an exit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { centrals } from '../../server/mcp/centrals.js';
import { watchCentralLifecycle } from '../../server/mcp/lifecycle.js';
import { __resetMcpPortForTest, setMcpPort } from '../../server/mcp/runtime.js';
import {
  closeTerminal,
  closeTerminalAndWait,
  createTerminal,
  getTerminals,
  onTerminalExit,
  registerTerminalExitCallback,
} from '../../server/sshManager.js';
import { fakeBus, globalInput, makeMarker } from './centralFixtures.js';
import { lastPty, resetFakePtys, spawned } from './fakePty.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

// closing a terminal reaps its shell's children by pid; nothing in this file may reach a process.
vi.mock('../../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/processMonitor.js')>(
    '../../server/processMonitor.js',
  );
  return {
    ...actual,
    listChildPids: vi.fn(() => []),
    terminateProcessTree: vi.fn(async () => true),
    reapPtyChildren: vi.fn(),
  };
});

const config = (over: Partial<TerminalConfig> = {}): TerminalConfig => ({
  host: 'localhost',
  port: 22,
  username: 'tester',
  authMethod: 'key',
  workingDir: '/tmp',
  command: '', // no auto-launch: nothing is typed, the terminal only has to exist
  ...over,
});

/** The ids a listener has heard, and the unsubscribe; every listener a test adds is removed after it. */
const subscriptions: Array<() => void> = [];
function listen(): { heard: string[]; off: () => void } {
  const heard: string[] = [];
  const off = onTerminalExit((terminalId) => heard.push(terminalId));
  subscriptions.push(off);
  return { heard, off };
}

beforeEach(() => {
  resetFakePtys();
  log.warn.mockClear();
  setMcpPort(3333);
  registerTerminalExitCallback(() => {});
  // createTerminal starts a few timers (shell-ready fallback, trust prompt); none should outlive the test
  vi.useFakeTimers();
});

afterEach(() => {
  for (const off of subscriptions.splice(0)) off();
  for (const terminal of getTerminals()) closeTerminal(terminal.terminalId);
  for (const record of centrals.list()) centrals.revoke(record.centralId);
  vi.clearAllTimers();
  vi.useRealTimers();
  __resetMcpPortForTest();
});

describe('onTerminalExit', () => {
  it('calls the listener with the terminal id when its PTY exits', async () => {
    const { heard } = listen();
    const id = await createTerminal(config(), null);
    expect(heard).toEqual([]);

    lastPty().exit(0);

    expect(heard).toEqual([id]);
    expect(getTerminals().some((t) => t.terminalId === id)).toBe(false);
  });

  it('names the terminal whose PTY exited, among several', async () => {
    const { heard } = listen();
    await createTerminal(config(), null);
    const second = await createTerminal(config(), null);
    await createTerminal(config(), null);

    spawned[1].exit(1, 15);

    expect(heard).toEqual([second]);
  });

  it('unsubscribe stops it, and a second unsubscribe does nothing', async () => {
    const { heard, off } = listen();
    await createTerminal(config(), null);

    off();
    off();
    lastPty().exit(0);

    expect(heard).toEqual([]);
  });

  it('keeps two subscriptions of one function apart', async () => {
    const heard: string[] = [];
    const listener = (terminalId: string) => heard.push(terminalId);
    const first = onTerminalExit(listener);
    subscriptions.push(first, onTerminalExit(listener));
    const id = await createTerminal(config(), null);

    first();
    lastPty().exit(0);

    expect(heard).toEqual([id]);
  });

  it('tells every listener, in the order they subscribed', async () => {
    const order: string[] = [];
    subscriptions.push(
      onTerminalExit(() => order.push('first')),
      onTerminalExit(() => order.push('second')),
      onTerminalExit(() => order.push('third')),
    );
    await createTerminal(config(), null);

    lastPty().exit(0);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('a throwing listener does not stop the others, the exit path, or the single-slot callback', async () => {
    // subscribed first, so every listener below runs after the one that throws
    subscriptions.push(
      onTerminalExit(() => {
        throw new Error('listener boom');
      }),
    );
    const after = listen();
    const exitCallback = vi.fn();
    registerTerminalExitCallback(exitCallback);
    const id = await createTerminal(config(), null);

    expect(() => lastPty().exit(0)).not.toThrow();

    expect(after.heard).toEqual([id]);
    expect(exitCallback).toHaveBeenCalledWith(id);
    expect(getTerminals().some((t) => t.terminalId === id)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('pty', expect.stringContaining('listener boom'));
  });

  it('a listener removed by an earlier one in the same round is not called', async () => {
    const calls: string[] = [];
    let removeSecond: () => void = () => {};
    subscriptions.push(
      onTerminalExit(() => {
        calls.push('first');
        removeSecond();
      }),
    );
    removeSecond = onTerminalExit(() => calls.push('second'));
    subscriptions.push(removeSecond);
    await createTerminal(config(), null);

    lastPty().exit(0);

    expect(calls).toEqual(['first']);
  });

  describe('a terminal closed on purpose', () => {
    // closeTerminal disposes the PTY's exit handler before the PTY dies, so the exit handler (and the
    // single-slot callback it calls) never runs for a kill, a close, a delete or a restart.
    it('is announced by closeTerminal, once', async () => {
      const { heard } = listen();
      const id = await createTerminal(config(), null);

      closeTerminal(id);
      expect(heard).toEqual([id]);

      // the PTY dying afterwards, and a second close, announce nothing more
      lastPty().exit(0);
      closeTerminal(id);
      expect(heard).toEqual([id]);
    });

    it('is announced by closeTerminalAndWait, once', async () => {
      const { heard } = listen();
      const id = await createTerminal(config(), null);

      await closeTerminalAndWait(id);
      lastPty().exit(0);

      expect(heard).toEqual([id]);
    });

    it('does not call the single-slot callback, as before', async () => {
      const exitCallback = vi.fn();
      registerTerminalExitCallback(exitCallback);
      const id = await createTerminal(config(), null);

      closeTerminal(id);

      expect(exitCallback).not.toHaveBeenCalled();
    });

    it('is announced only once even when the PTY then exits', async () => {
      const { heard } = listen();
      const id = await createTerminal(config(), null);

      lastPty().exit(0);
      closeTerminal(id);

      expect(heard).toEqual([id]);
    });

    it('is not announced for a terminal that does not exist', () => {
      const { heard } = listen();

      closeTerminal('term-never-existed');

      expect(heard).toEqual([]);
    });
  });

  it('leaves the single-slot callback as it was: it is still called, with the id, when a PTY exits', async () => {
    const exitCallback = vi.fn();
    registerTerminalExitCallback(exitCallback);
    const id = await createTerminal(config(), null);

    lastPty().exit(0);

    expect(exitCallback).toHaveBeenCalledTimes(1);
    expect(exitCallback).toHaveBeenCalledWith(id);
  });
});

describe('a central on the feed (watchCentralLifecycle + onTerminalExit)', () => {
  let stop: () => void;

  beforeEach(() => {
    // `onBroadcast` is not what carries exits; the feed is
    stop = watchCentralLifecycle(centrals, fakeBus().subscribe, onTerminalExit);
  });

  afterEach(() => stop());

  const centralConfig = (centralId: string) => config({ central: makeMarker(centralId) });

  it('is revoked when its PTY exits', async () => {
    const record = centrals.mint(globalInput());
    await createTerminal(centralConfig(record.centralId), null);
    expect(centrals.byId(record.centralId)?.terminalId).not.toBeNull();

    lastPty().exit(0);

    expect(centrals.byId(record.centralId)).toBeNull();
    expect(centrals.byToken(record.token)).toBeNull();
  });

  it('is revoked when its terminal is closed on purpose, so a new central can take its place', async () => {
    const record = centrals.mint(globalInput());
    const id = await createTerminal(centralConfig(record.centralId), null);

    closeTerminal(id);

    expect(centrals.byId(record.centralId)).toBeNull();
    expect(() => centrals.mint(globalInput())).not.toThrow();
  });

  it('survives the old terminal of a restart closing, and ends with the replacement', async () => {
    const record = centrals.mint(globalInput());
    const oldId = await createTerminal(centralConfig(record.centralId), null);
    // a restart mints the central again, opens the replacement, and only then stops the old terminal
    centrals.mint(globalInput({ centralId: record.centralId }));
    const newId = await createTerminal(centralConfig(record.centralId), null);

    await closeTerminalAndWait(oldId);
    expect(centrals.byId(record.centralId)?.terminalId).toBe(newId);

    closeTerminal(newId);
    expect(centrals.byId(record.centralId)).toBeNull();
  });

  it('is left alone when an ordinary terminal exits', async () => {
    const record = centrals.mint(globalInput());
    await createTerminal(centralConfig(record.centralId), null);
    await createTerminal(config(), null);

    lastPty().exit(0);

    expect(centrals.byId(record.centralId)).not.toBeNull();
  });
});
