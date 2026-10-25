// test/mcp/lifecycle.test.ts — the details of the watcher that revokes a central when the terminal it
// runs in goes away (server/mcp/lifecycle.ts). The headline test, `lifecycle revokes on terminal_closed
// and on terminal exit, never on session end`, sits in centrals.test.ts beside the registry it drives.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCentralRegistry, type CentralRegistry } from '../../server/mcp/centrals.js';
import { watchCentralLifecycle } from '../../server/mcp/lifecycle.js';
import {
  endedUpdate,
  fakeBus,
  fakeTerminalExits,
  globalInput,
  makeMarker,
  roomInput,
  sessionUpdate,
  terminalClosed,
  type BusMessage,
} from './centralFixtures.js';

// The watcher logs each revocation; the logger would append it to a file on disk.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

describe('watchCentralLifecycle', () => {
  let reg: CentralRegistry;
  let bus: ReturnType<typeof fakeBus>;
  let exits: ReturnType<typeof fakeTerminalExits>;
  let stop: () => void;

  beforeEach(() => {
    log.info.mockClear();
    reg = createCentralRegistry();
    bus = fakeBus();
    exits = fakeTerminalExits();
    stop = watchCentralLifecycle(reg, bus.subscribe, exits.subscribe);
  });

  describe('terminal exit feed', () => {
    it('terminal exit of the attached terminal revokes', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');

      exits.exit('term-1');

      expect(reg.byId(record.centralId)).toBeNull();
      expect(log.info).toHaveBeenCalledWith('mcp', expect.stringContaining(record.centralId));
    });

    it('terminal exit of an unrelated terminal does not', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');

      exits.exit('term-9');
      exits.exit('');

      expect(reg.byId(record.centralId)).not.toBeNull();
      expect(log.info).not.toHaveBeenCalled();
    });

    it('revokes only the central whose terminal exited', () => {
      const one = reg.mint(roomInput('r1'));
      const two = reg.mint(roomInput('r2'));
      reg.attachTerminal(one.centralId, 'term-1');
      reg.attachTerminal(two.centralId, 'term-2');

      exits.exit('term-2');

      expect(reg.list().map((r) => r.centralId)).toEqual([one.centralId]);
    });

    it('does not revoke a relaunched central when its old terminal exits after the relaunch', () => {
      // A restart opens the replacement PTY first and stops the old one afterwards.
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-old');
      const again = reg.mint(globalInput({ centralId: record.centralId }));
      reg.attachTerminal(again.centralId, 'term-new');

      exits.exit('term-old');
      expect(reg.byId(again.centralId)).not.toBeNull();

      exits.exit('term-new');
      expect(reg.byId(again.centralId)).toBeNull();
    });
  });

  describe('terminal_closed message', () => {
    it('revokes the central attached to that terminal, as an exit does', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');

      bus.emit(terminalClosed('term-1'));

      expect(reg.byId(record.centralId)).toBeNull();
    });

    it('ignores a closed terminal no central owns', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');

      bus.emit(terminalClosed('term-9'));

      expect(reg.byId(record.centralId)).not.toBeNull();
      expect(log.info).not.toHaveBeenCalled();
    });

    it('does not revoke a relaunched central when its old terminal closes after the relaunch', () => {
      // A restart opens the replacement PTY first and stops the old one afterwards.
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-old');
      const again = reg.mint(globalInput({ centralId: record.centralId }));

      bus.emit(terminalClosed('term-old'));
      expect(reg.byId(again.centralId)).not.toBeNull();

      reg.attachTerminal(again.centralId, 'term-new');
      bus.emit(terminalClosed('term-new'));
      expect(reg.byId(again.centralId)).toBeNull();
    });
  });

  describe('session_update', () => {
    // A session ending is not its central ending: Claude's /clear fires SessionEnd while the CLI, and
    // the MCP connection it holds, keep running. Only the terminal going away revokes.
    it('ended never revokes', () => {
      const attached = reg.mint(roomInput('r1'));
      reg.attachTerminal(attached.centralId, 'term-1');
      const unattached = reg.mint(roomInput('r2'));

      // the card on the terminal the central runs in, a card on another terminal, a card with none
      bus.emit(endedUpdate(attached.centralId, 'term-1'));
      bus.emit(endedUpdate(attached.centralId, 'term-old'));
      bus.emit(endedUpdate(attached.centralId, null));
      // a central with no terminal attached yet
      bus.emit(endedUpdate(unattached.centralId, 'term-anything'));
      bus.emit(endedUpdate(unattached.centralId, null));

      expect(reg.list().map((r) => r.centralId)).toEqual([
        attached.centralId,
        unattached.centralId,
      ]);
      expect(log.info).not.toHaveBeenCalled();
    });

    it('a /clear leaves the central connected: the card ends, the next session shares the terminal', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');
      const marker = makeMarker(record.centralId);

      bus.emit(
        sessionUpdate({
          sessionId: 'claude-1',
          status: 'working',
          terminalId: 'term-1',
          central: marker,
        }),
      );
      bus.emit(
        sessionUpdate({
          sessionId: 'claude-1',
          status: 'ended',
          terminalId: 'term-1',
          central: marker,
        }),
      );
      bus.emit(
        sessionUpdate({
          sessionId: 'claude-2',
          status: 'idle',
          terminalId: 'term-1',
          central: marker,
        }),
      );

      expect(reg.byToken(record.token)?.centralId).toBe(record.centralId);

      exits.exit('term-1');
      expect(reg.byId(record.centralId)).toBeNull();
    });

    it('an old ended card and the relaunch that replaced it change nothing; the relaunch ends with its own terminal', () => {
      const first = reg.mint(globalInput());
      reg.attachTerminal(first.centralId, 'term-old');
      const again = reg.mint(globalInput({ centralId: first.centralId }));
      reg.attachTerminal(again.centralId, 'term-new');

      bus.emit(endedUpdate(again.centralId, 'term-old'));
      bus.emit(endedUpdate(again.centralId, 'term-new'));
      bus.emit(endedUpdate(again.centralId, null));
      expect(reg.byId(again.centralId)).not.toBeNull();

      exits.exit('term-new');
      expect(reg.byId(again.centralId)).toBeNull();
    });

    it('no session status revokes, ended included', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');
      for (const status of [
        'connecting',
        'idle',
        'prompting',
        'working',
        'approval',
        'input',
        'waiting',
        'ended',
      ]) {
        bus.emit(
          sessionUpdate({
            sessionId: 's1',
            status,
            terminalId: 'term-1',
            central: makeMarker(record.centralId),
          }),
        );
      }

      expect(reg.byId(record.centralId)).not.toBeNull();
    });
  });

  describe('session_removed', () => {
    it('session_removed never revokes', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');
      bus.emit(
        sessionUpdate({
          sessionId: 'claude-uuid',
          status: 'working',
          terminalId: 'term-1',
          central: makeMarker(record.centralId),
        }),
      );

      bus.emit({ type: 'session_removed', sessionId: 'claude-uuid' });
      bus.emit({ type: 'session_removed', sessionId: 'never-seen' });

      expect(reg.byId(record.centralId)).not.toBeNull();
      expect(log.info).not.toHaveBeenCalled();
    });

    it('a restore that removes a card while its terminal lives on leaves the central, until that terminal exits', () => {
      // sessionStore absorbs the fresh CONNECTING card into the re-keyed old card, moves the PTY
      // across, deletes a card and broadcasts session_removed. The PTY lives on.
      const record = reg.mint(globalInput({ centralId: 'c-saved' }));
      reg.attachTerminal(record.centralId, 'term-1');
      const marker = makeMarker('c-saved');
      bus.emit(
        sessionUpdate({
          sessionId: 'term-1',
          status: 'connecting',
          terminalId: 'term-1',
          central: marker,
        }),
      );

      bus.emit({ type: 'session_removed', sessionId: 'term-1' });
      bus.emit(
        sessionUpdate({
          sessionId: 'claude-old',
          replacesId: 'term-1',
          status: 'idle',
          terminalId: 'term-1',
          central: marker,
        }),
      );
      expect(reg.byId('c-saved')).not.toBeNull();

      exits.exit('term-1');
      expect(reg.byId('c-saved')).toBeNull();
    });
  });

  describe('the feeds', () => {
    it('unsubscribe detaches both feeds', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');
      expect(bus.listenerCount()).toBe(1);
      expect(exits.listenerCount()).toBe(1);

      stop();

      expect(bus.listenerCount()).toBe(0);
      expect(exits.listenerCount()).toBe(0);
      exits.exit('term-1');
      bus.emit(terminalClosed('term-1'));
      expect(reg.byId(record.centralId)).not.toBeNull();
    });

    it('works without a terminal-exit feed: a terminal_closed message still revokes', () => {
      const lone = createCentralRegistry();
      const loneBus = fakeBus();
      const stopLone = watchCentralLifecycle(lone, loneBus.subscribe);
      const record = lone.mint(globalInput());
      lone.attachTerminal(record.centralId, 'term-1');

      loneBus.emit(terminalClosed('term-1'));
      expect(lone.byId(record.centralId)).toBeNull();

      stopLone();
      expect(loneBus.listenerCount()).toBe(0);
    });

    it('leaves no message listener behind when the exit feed cannot be subscribed', () => {
      const lone = createCentralRegistry();
      const loneBus = fakeBus();

      expect(() =>
        watchCentralLifecycle(lone, loneBus.subscribe, () => {
          throw new Error('no exit feed');
        }),
      ).toThrow('no exit feed');

      expect(loneBus.listenerCount()).toBe(0);
    });

    it('detaches each feed once, however often it is stopped', () => {
      const offMessages = vi.fn();
      const offExits = vi.fn();
      const stopBoth = watchCentralLifecycle(
        reg,
        () => offMessages,
        () => offExits,
      );

      stopBoth();
      stopBoth();

      expect(offMessages).toHaveBeenCalledTimes(1);
      expect(offExits).toHaveBeenCalledTimes(1);
    });

    it('reads a message it does not understand as nothing', () => {
      const record = reg.mint(globalInput());
      reg.attachTerminal(record.centralId, 'term-1');

      const noise: BusMessage[] = [
        { type: 'queue_update', sessionId: 's1' },
        { type: 'terminal_closed' },
        { type: 'terminal_closed', terminalId: 42 },
        { type: 'session_removed' },
        { type: 'session_removed', sessionId: 7 },
        { type: 'session_update' },
        { type: 'session_update', session: 'not an object' },
        { type: 'session_update', session: null },
        { type: 'team_update', team: {} },
      ];
      for (const msg of noise) expect(() => bus.emit(msg)).not.toThrow();

      expect(reg.byId(record.centralId)).not.toBeNull();
    });
  });
});
