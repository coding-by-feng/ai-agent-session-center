// test/mcp/completion.test.ts — what completion/complete offers for a session id (server/mcp/completion.ts), asked
// of the completer itself: the sessions in scope as the references a tool takes, nothing once the central is gone,
// and a failure that is not that one said in the log instead of swallowed. (Through the endpoint, for a resource's
// URI and a prompt's argument, it is in resourceRefusals.test.ts and prompts.test.ts.)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionCompleter } from '../../server/mcp/completion.js';
import { ToolError } from '../../server/mcp/types.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { book } from './resourceBookWorld.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

beforeEach(() => {
  log.warn.mockClear();
});

/** Makes reading `property` of the world throw `error`: the store or the rooms mirror failing under the completer. */
function breakWith(world: object, property: 'sessions' | 'rooms', error: Error): void {
  Object.defineProperty(world, property, {
    get() {
      throw error;
    },
  });
}

describe('sessionCompleter', () => {
  it('offers the references of the sessions in scope, newest activity first, filtered by what was typed', () => {
    const global = book(globalInput());
    const room = book(roomInput('r1'));
    const asGlobal = sessionCompleter(global.central.centralId, global.deps);
    const asRoom = sessionCompleter(room.central.centralId, room.deps);

    expect(asGlobal('')).toEqual(['s1', 's2']);
    expect(asGlobal('s2')).toEqual(['s2']);
    expect(asGlobal('zz')).toEqual([]);
    expect(asRoom('')).toEqual(['s1']);
  });

  it('offers nothing, and does not warn, once the central is no longer live', () => {
    const { deps, central, registry } = book(globalInput());
    const complete = sessionCompleter(central.centralId, deps);
    expect(complete('')).toEqual(['s1', 's2']);

    registry.revoke(central.centralId);

    expect(complete('')).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('offers nothing and says why in the log when anything else goes wrong, whatever was typed', () => {
    const { deps, central, world } = book(globalInput());
    const complete = sessionCompleter(central.centralId, deps);
    breakWith(world, 'sessions', new Error('the session store broke'));

    expect(complete('')).toEqual([]);
    expect(complete('s1')).toEqual([]);

    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      'mcp',
      expect.stringContaining('the session store broke'),
    );
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining(central.centralId));
  });

  it('says a failure of the rooms mirror too: the sessions in scope are read from both', () => {
    const { deps, central, world } = book(roomInput('r1'));
    const complete = sessionCompleter(central.centralId, deps);
    breakWith(world, 'rooms', new Error('the rooms mirror broke'));

    expect(complete('')).toEqual([]);

    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('the rooms mirror broke'));
  });

  it('takes only UNAVAILABLE for the central being gone: another refusal is a failure, and is said', () => {
    const { deps, central, world } = book(globalInput());
    const complete = sessionCompleter(central.centralId, deps);
    breakWith(world, 'sessions', new ToolError('NOT_FOUND', 'Something else was not found.'));

    expect(complete('')).toEqual([]);

    expect(log.warn).toHaveBeenCalledWith(
      'mcp',
      expect.stringContaining('Something else was not found'),
    );
  });
});
