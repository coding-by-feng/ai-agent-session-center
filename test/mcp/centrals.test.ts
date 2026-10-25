// test/mcp/centrals.test.ts — the registry of centrals (server/mcp/centrals.ts): minting, scopes,
// tokens, lookups, and finding a central's session. The headline test of the watcher that revokes
// a central (server/mcp/lifecycle.ts) is here too; its details are in lifecycle.test.ts.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import {
  CentralScopeTakenError,
  centrals,
  createCentralRegistry,
  defaultToolsets,
  resolveCentralSession,
  type MintInput,
} from '../../server/mcp/centrals.js';
import { watchCentralLifecycle } from '../../server/mcp/lifecycle.js';
import { ALL_TOOLSETS, CORE_TOOLSETS, type SessionCentralMarker } from '../../server/mcp/types.js';
import {
  endedUpdate,
  fakeBus,
  fakeTerminalExits,
  globalInput,
  makeMarker,
  projectInput,
  roomInput,
  sessionUpdate,
  terminalClosed,
} from './centralFixtures.js';

// The logger appends to a file on disk. The registry logs a failing change listener and the
// watcher a revocation; both are asserted.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

// timingSafeEqual stays real; the spy only records that a token compare goes through it.
const compare = vi.hoisted(() => ({ spy: vi.fn() }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  compare.spy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: compare.spy };
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a call threw; fails the test when it did not throw. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

beforeEach(() => {
  log.info.mockClear();
  log.warn.mockClear();
  compare.spy.mockClear();
});

describe('defaultToolsets', () => {
  it.each([
    ['claude', 'global'],
    ['claude', 'room'],
    ['claude', 'project'],
  ] as const)('a %s %s central gets every toolset', (cli, kind) => {
    expect(defaultToolsets(kind, cli)).toEqual([...ALL_TOOLSETS]);
  });

  it('a codex global central gets the core toolsets', () => {
    expect(defaultToolsets('global', 'codex')).toEqual([...CORE_TOOLSETS]);
  });

  it('a codex room central adds rooms to the core', () => {
    expect(defaultToolsets('room', 'codex')).toEqual([...CORE_TOOLSETS, 'rooms']);
  });

  it('a codex project central adds resources and history to the core', () => {
    expect(defaultToolsets('project', 'codex')).toEqual([...CORE_TOOLSETS, 'resources', 'history']);
  });

  it('hands out a fresh list every time', () => {
    const first = defaultToolsets('global', 'claude');
    first.pop();
    expect(defaultToolsets('global', 'claude')).toHaveLength(ALL_TOOLSETS.length);
    expect(ALL_TOOLSETS).toHaveLength(15);
  });
});

describe('createCentralRegistry · mint', () => {
  it('mint returns an aasc_mcp_ token of 52 chars', () => {
    const { token } = createCentralRegistry().mint(globalInput());

    expect(token).toMatch(/^aasc_mcp_[A-Za-z0-9_-]{43}$/);
    expect(token).toHaveLength(52);
  });

  it('draws each token from 32 random bytes', () => {
    const random = vi.fn((n: number) => Buffer.alloc(n, 7));
    const { token } = createCentralRegistry({ random }).mint(globalInput());

    expect(random).toHaveBeenCalledWith(32);
    expect(token).toBe(`aasc_mcp_${Buffer.alloc(32, 7).toString('base64url')}`);
  });

  it('gives every central its own token and id', () => {
    const reg = createCentralRegistry();
    const records = Array.from({ length: 12 }, (_, i) => reg.mint(roomInput(`r${i}`)));

    expect(new Set(records.map((r) => r.token)).size).toBe(12);
    expect(new Set(records.map((r) => r.centralId)).size).toBe(12);
    for (const record of records) expect(record.centralId).toMatch(UUID);
  });

  it('refuses a token the random source already handed out', () => {
    const reg = createCentralRegistry({ random: (n) => Buffer.alloc(n, 1) });
    const first = reg.mint(roomInput('r1'));

    expect(() => reg.mint(roomInput('r2'))).toThrow(/already in use/);
    expect(reg.list()).toEqual([first]);
  });

  it('stamps the record from its input and the clock', () => {
    const reg = createCentralRegistry({ now: () => 1_234 });
    const record = reg.mint({ kind: 'room', scopeRef: 'r1', cli: 'codex', permissionMode: 'plan' });

    expect(record).toEqual({
      centralId: expect.stringMatching(UUID),
      kind: 'room',
      scopeRef: 'r1',
      cli: 'codex',
      permissionMode: 'plan',
      toolsets: defaultToolsets('room', 'codex'),
      token: expect.stringMatching(/^aasc_mcp_/),
      terminalId: null,
      createdAt: 1_234,
    });
  });

  it('keeps a toolset list the caller chose, as a copy', () => {
    const reg = createCentralRegistry();
    const chosen: MintInput['toolsets'] = ['sessions', 'system'];
    const record = reg.mint(globalInput({ toolsets: chosen }));
    chosen.push('cloud');

    expect(record.toolsets).toEqual(['sessions', 'system']);
    expect(reg.byId(record.centralId)?.toolsets).toEqual(['sessions', 'system']);
  });

  it('refuses a room or project central that names no scope', () => {
    const reg = createCentralRegistry();

    for (const input of [
      roomInput(null),
      roomInput(''),
      roomInput('   '),
      projectInput(null),
      projectInput(' '),
    ]) {
      expect(caught(() => reg.mint(input))).toMatchObject({ name: 'ToolError', code: 'INVALID' });
    }
    expect(caught(() => reg.mint(globalInput({ centralId: ' ' })))).toMatchObject({
      code: 'INVALID',
    });
    expect(reg.list()).toEqual([]);
  });

  it('ignores a scopeRef on a global central', () => {
    const record = createCentralRegistry().mint(globalInput({ scopeRef: 'whatever' }));

    expect(record.scopeRef).toBeNull();
  });
});

describe('createCentralRegistry · one central per scope', () => {
  it('one global central', () => {
    const reg = createCentralRegistry();
    const first = reg.mint(globalInput());

    const error = caught(() => reg.mint(globalInput({ cli: 'codex' })));

    expect(error).toBeInstanceOf(CentralScopeTakenError);
    expect((error as CentralScopeTakenError).existing.centralId).toBe(first.centralId);
    expect((error as CentralScopeTakenError).message).toMatch(/global/);
    expect(reg.list()).toHaveLength(1);
  });

  it('one central per room and per project folder', () => {
    const reg = createCentralRegistry();
    const roomOne = reg.mint(roomInput('r1'));
    reg.mint(roomInput('r2'));

    const sameRoom = caught(() => reg.mint(roomInput('r1')));
    expect(sameRoom).toBeInstanceOf(CentralScopeTakenError);
    expect((sameRoom as CentralScopeTakenError).existing.centralId).toBe(roomOne.centralId);

    const project = reg.mint(projectInput('/a/proj'));
    for (const spelling of ['/a/proj/', '/a/./proj', '/a/x/../proj/']) {
      const again = caught(() => reg.mint(projectInput(spelling)));
      expect(again).toBeInstanceOf(CentralScopeTakenError);
      expect((again as CentralScopeTakenError).existing.centralId).toBe(project.centralId);
    }
    reg.mint(projectInput('/a/other'));
    expect(reg.list()).toHaveLength(4);
  });

  it('files a project central under its normalized folder, ~ included', () => {
    const reg = createCentralRegistry();
    const record = reg.mint(projectInput('/a/proj/'));
    expect(record.scopeRef).toBe('/a/proj');

    reg.mint(projectInput(join(homedir(), 'work')));
    expect(caught(() => reg.mint(projectInput('~/work')))).toBeInstanceOf(CentralScopeTakenError);
  });

  it('keeps a global, a room and a project scope apart', () => {
    const reg = createCentralRegistry();
    reg.mint(globalInput());
    reg.mint(roomInput('/a/proj'));
    reg.mint(projectInput('/a/proj'));

    expect(reg.list()).toHaveLength(3);
  });

  it("never hands out the existing central's token with the error", () => {
    const reg = createCentralRegistry();
    const first = reg.mint(globalInput());

    const { existing } = caught(() => reg.mint(globalInput())) as CentralScopeTakenError;

    expect(existing.token).toBe('');
    expect(JSON.stringify(existing)).not.toContain(first.token);
    expect(existing).toEqual({ ...first, token: '' });
  });

  it('findByScope finds the holder, normalizes a folder, and finds nothing for a free scope', () => {
    const reg = createCentralRegistry();
    const global = reg.mint(globalInput());
    const room = reg.mint(roomInput('r1'));
    const project = reg.mint(projectInput('/a/proj'));

    expect(reg.findByScope('global', null)?.centralId).toBe(global.centralId);
    expect(reg.findByScope('room', 'r1')?.centralId).toBe(room.centralId);
    expect(reg.findByScope('project', '/a/proj/')?.centralId).toBe(project.centralId);
    expect(reg.findByScope('room', 'r2')).toBeNull();
    expect(reg.findByScope('project', '/a/other')).toBeNull();
    expect(reg.findByScope('room', null)).toBeNull();
  });
});

describe('createCentralRegistry · re-mint', () => {
  it('mint with a known centralId re-mints that record and replaces its token', () => {
    let clock = 1_000;
    const reg = createCentralRegistry({ now: () => clock });
    const first = reg.mint(roomInput('r1', { permissionMode: 'plan' }));
    reg.attachTerminal(first.centralId, 'term-1');
    clock = 2_000;

    const again = reg.mint(
      roomInput('r1', { centralId: first.centralId, cli: 'codex', permissionMode: null }),
    );

    expect(again.centralId).toBe(first.centralId);
    expect(again.token).not.toBe(first.token);
    expect(reg.byToken(first.token)).toBeNull();
    expect(reg.byToken(again.token)).toEqual(again);
    expect(reg.list()).toEqual([again]);
    // Re-minted from the new launch: its cli, mode and default toolsets. It is still the same
    // central, so it keeps the createdAt it was first minted with.
    expect(again).toMatchObject({ cli: 'codex', permissionMode: null, createdAt: 1_000 });
    expect(again.toolsets).toEqual(defaultToolsets('room', 'codex'));
  });

  it('lets go of the old terminal, so its late close cannot touch the new launch', () => {
    const reg = createCentralRegistry();
    const first = reg.mint(globalInput());
    reg.attachTerminal(first.centralId, 'term-old');

    const again = reg.mint(globalInput({ centralId: first.centralId }));

    expect(again.terminalId).toBeNull();
    expect(reg.byTerminal('term-old')).toBeNull();
    reg.attachTerminal(again.centralId, 'term-new');
    expect(reg.byTerminal('term-new')?.centralId).toBe(first.centralId);
  });

  it('creates the record under that id when nothing holds it (restore after a restart)', () => {
    const reg = createCentralRegistry({ now: () => 5_000 });

    const record = reg.mint(projectInput('/a/proj', { centralId: 'c-saved' }));

    expect(record.centralId).toBe('c-saved');
    expect(record.createdAt).toBe(5_000);
    expect(reg.byId('c-saved')).toEqual(record);
  });

  it('may keep its own scope, and may move to a free one, freeing the old', () => {
    const reg = createCentralRegistry();
    const first = reg.mint(roomInput('r1'));

    reg.mint(roomInput('r1', { centralId: first.centralId }));
    expect(reg.mint(roomInput('r3', { centralId: first.centralId })).scopeRef).toBe('r3');

    expect(reg.findByScope('room', 'r1')).toBeNull();
    reg.mint(roomInput('r1'));
    expect(reg.list()).toHaveLength(2);
  });

  it('may not take a scope another central holds, and then changes nothing', () => {
    const reg = createCentralRegistry();
    const one = reg.mint(roomInput('r1'));
    const two = reg.mint(roomInput('r2'));

    const error = caught(() => reg.mint(roomInput('r2', { centralId: one.centralId })));

    expect(error).toBeInstanceOf(CentralScopeTakenError);
    expect((error as CentralScopeTakenError).existing.centralId).toBe(two.centralId);
    expect(reg.byId(one.centralId)).toEqual(one);
    expect(reg.byToken(one.token)).toEqual(one);
  });
});

describe('createCentralRegistry · byToken', () => {
  it('byToken matches only exact tokens', () => {
    const reg = createCentralRegistry();
    const a = reg.mint(roomInput('r1'));
    const b = reg.mint(roomInput('r2'));
    const lastChar = a.token.slice(-1);
    const oneOff = a.token.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');

    expect(reg.byToken(a.token)).toEqual(a);
    expect(reg.byToken(b.token)?.centralId).toBe(b.centralId);
    expect(reg.byToken(oneOff)).toBeNull();
    expect(reg.byToken(`${a.token}x`)).toBeNull();
    expect(reg.byToken(a.token.slice(0, -1))).toBeNull();
    expect(reg.byToken(a.token.toUpperCase())).toBeNull();
    expect(reg.byToken('aasc_mcp_')).toBeNull();
    expect(reg.byToken('')).toBeNull();
    expect(reg.byToken(undefined as unknown as string)).toBeNull();
  });

  it('answers a wrong length without throwing, even when only the bytes differ in length', () => {
    const reg = createCentralRegistry();
    const { token } = reg.mint(globalInput());
    // Same number of characters as the token, twice the bytes: a compare of unequal buffers throws.
    const wide = 'é'.repeat(token.length);

    expect(wide).toHaveLength(token.length);
    expect(() => reg.byToken(wide)).not.toThrow();
    expect(reg.byToken(wide)).toBeNull();
  });

  it('compares a same-length token with timingSafeEqual and never compares another length', () => {
    const reg = createCentralRegistry();
    const { token } = reg.mint(globalInput());
    compare.spy.mockClear();

    reg.byToken(token);
    expect(compare.spy).toHaveBeenCalledTimes(1);

    compare.spy.mockClear();
    reg.byToken(`${token}x`);
    reg.byToken(token.slice(1));
    expect(compare.spy).not.toHaveBeenCalled();
  });

  it('stops matching a token once it is rotated or revoked', () => {
    const reg = createCentralRegistry();
    const a = reg.mint(roomInput('r1'));
    const b = reg.mint(roomInput('r2'));

    const rotated = reg.rotate(a.centralId);
    reg.revoke(b.centralId);

    expect(reg.byToken(a.token)).toBeNull();
    expect(reg.byToken(rotated.token)?.centralId).toBe(a.centralId);
    expect(reg.byToken(b.token)).toBeNull();
  });
});

describe('createCentralRegistry · lookups and copies', () => {
  it('hands out copies: changing one never changes the registry', () => {
    const reg = createCentralRegistry();
    const minted = reg.mint(globalInput({ cli: 'codex' }));
    reg.attachTerminal(minted.centralId, 'term-1');
    const original = reg.byId(minted.centralId);

    const copies = [
      minted,
      reg.byId(minted.centralId),
      reg.byToken(minted.token),
      reg.byTerminal('term-1'),
      reg.findByScope('global', null),
      reg.list()[0],
      reg.rotate(minted.centralId),
    ];
    for (const copy of copies) {
      copy!.toolsets.push('cloud');
      copy!.toolsets.shift();
      copy!.token = 'forged';
      copy!.terminalId = 'term-x';
      copy!.scopeRef = 'x';
      copy!.permissionMode = 'bypassPermissions';
    }

    const now = reg.byId(minted.centralId)!;
    expect(now.toolsets).toEqual(defaultToolsets('global', 'codex'));
    expect(now).toEqual({ ...original, token: now.token });
    expect(now.token).not.toBe('forged');
    expect(now).toMatchObject({ terminalId: 'term-1', scopeRef: null, permissionMode: null });
  });

  it('byId, byTerminal and findByScope answer null for what is not there', () => {
    const reg = createCentralRegistry();
    reg.mint(globalInput());

    expect(reg.byId('nope')).toBeNull();
    expect(reg.byTerminal('term-9')).toBeNull();
    expect(reg.byTerminal('')).toBeNull();
    expect(reg.findByScope('project', '/nowhere')).toBeNull();
  });

  it('list returns the centrals oldest first, and a re-mint keeps its place and its createdAt', () => {
    let clock = 100;
    const reg = createCentralRegistry({ now: () => clock });
    const first = reg.mint(roomInput('r1'));
    clock = 200;
    const second = reg.mint(roomInput('r2'));
    clock = 300;
    const third = reg.mint(roomInput('r3'));
    clock = 400;
    reg.mint(roomInput('r1', { centralId: first.centralId }));

    const listed = reg.list();

    expect(listed.map((r) => r.centralId)).toEqual([
      first.centralId,
      second.centralId,
      third.centralId,
    ]);
    expect(listed.map((r) => r.createdAt)).toEqual([100, 200, 300]);
  });
});

describe('createCentralRegistry · attachTerminal', () => {
  it('binds a terminal to a central, and a new terminal replaces the old binding', () => {
    const reg = createCentralRegistry();
    const record = reg.mint(globalInput());

    reg.attachTerminal(record.centralId, 'term-1');
    expect(reg.byTerminal('term-1')?.centralId).toBe(record.centralId);
    expect(reg.byId(record.centralId)?.terminalId).toBe('term-1');

    reg.attachTerminal(record.centralId, 'term-2');
    expect(reg.byTerminal('term-1')).toBeNull();
    expect(reg.byTerminal('term-2')?.centralId).toBe(record.centralId);
  });

  it('refuses an unknown central, a blank terminal, and a terminal another central holds', () => {
    const reg = createCentralRegistry();
    const one = reg.mint(roomInput('r1'));
    const two = reg.mint(roomInput('r2'));
    reg.attachTerminal(one.centralId, 'term-1');

    expect(caught(() => reg.attachTerminal('nope', 'term-3'))).toMatchObject({ code: 'NOT_FOUND' });
    expect(caught(() => reg.attachTerminal(one.centralId, ' '))).toMatchObject({ code: 'INVALID' });
    expect(caught(() => reg.attachTerminal(two.centralId, 'term-1'))).toMatchObject({
      code: 'INVALID',
    });
    expect(reg.byTerminal('term-1')?.centralId).toBe(one.centralId);
    expect(reg.byId(two.centralId)?.terminalId).toBeNull();
  });
});

describe('createCentralRegistry · rotate, revoke, onChange', () => {
  it('rotate keeps the id, changes the token; revoke removes it; onChange fires', () => {
    const reg = createCentralRegistry();
    const changed = vi.fn();
    reg.onChange(changed);

    const record = reg.mint(roomInput('r1')); // 1
    reg.attachTerminal(record.centralId, 'term-1'); // 2
    const rotated = reg.rotate(record.centralId); // 3

    expect(rotated.centralId).toBe(record.centralId);
    expect(rotated.token).not.toBe(record.token);
    expect(rotated.token).toMatch(/^aasc_mcp_[A-Za-z0-9_-]{43}$/);
    expect(rotated).toEqual({ ...record, token: rotated.token, terminalId: 'term-1' });
    expect(reg.byToken(rotated.token)?.centralId).toBe(record.centralId);

    reg.revoke(record.centralId); // 4

    expect(reg.byId(record.centralId)).toBeNull();
    expect(reg.byToken(rotated.token)).toBeNull();
    expect(reg.byTerminal('term-1')).toBeNull();
    expect(reg.findByScope('room', 'r1')).toBeNull();
    expect(reg.list()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('revoke frees the scope for a new central', () => {
    const reg = createCentralRegistry();
    const first = reg.mint(globalInput());

    reg.revoke(first.centralId);

    expect(reg.mint(globalInput()).centralId).not.toBe(first.centralId);
  });

  it('rotate of a central that is not there throws NOT_FOUND', () => {
    expect(caught(() => createCentralRegistry().rotate('nope'))).toMatchObject({
      name: 'ToolError',
      code: 'NOT_FOUND',
    });
  });

  it('revoke of a central that is not there does nothing and announces nothing', () => {
    const reg = createCentralRegistry();
    const changed = vi.fn();
    reg.onChange(changed);
    const record = reg.mint(globalInput());
    changed.mockClear();

    expect(() => reg.revoke('nope')).not.toThrow();
    reg.revoke(record.centralId);
    reg.revoke(record.centralId);

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('onChange fires once per change, not for a no-op, and stops after its unsubscribe', () => {
    const reg = createCentralRegistry();
    const changed = vi.fn();
    const off = reg.onChange(changed);

    const record = reg.mint(globalInput());
    reg.attachTerminal(record.centralId, 'term-1');
    reg.attachTerminal(record.centralId, 'term-1');
    expect(changed).toHaveBeenCalledTimes(2);

    off();
    off();
    reg.rotate(record.centralId);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps two subscriptions of one function apart', () => {
    const reg = createCentralRegistry();
    const changed = vi.fn();
    const offFirst = reg.onChange(changed);
    reg.onChange(changed);

    offFirst();
    reg.mint(globalInput());

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('tells a listener after the change is made', () => {
    const reg = createCentralRegistry();
    const sizes: number[] = [];
    reg.onChange(() => sizes.push(reg.list().length));

    const record = reg.mint(globalInput());
    reg.revoke(record.centralId);

    expect(sizes).toEqual([1, 0]);
  });

  it('logs a listener that throws, and neither skips the others nor undoes the change', () => {
    const reg = createCentralRegistry();
    const after = vi.fn();
    reg.onChange(() => {
      throw new Error('listener boom');
    });
    reg.onChange(after);

    const record = reg.mint(globalInput());

    expect(after).toHaveBeenCalledTimes(1);
    expect(reg.byId(record.centralId)).toEqual(record);
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('listener boom'));
  });
});

describe('centrals (the shared registry)', () => {
  it('is one registry that works like any other', () => {
    const record = centrals.mint(globalInput());
    try {
      expect(centrals.byToken(record.token)?.centralId).toBe(record.centralId);
      expect(caught(() => centrals.mint(globalInput()))).toBeInstanceOf(CentralScopeTakenError);
    } finally {
      centrals.revoke(record.centralId);
    }
    expect(centrals.byId(record.centralId)).toBeNull();
  });
});

describe('resolveCentralSession', () => {
  const sessionOf = (over: {
    sessionId: string;
    status?: string;
    lastActivityAt?: number;
    central?: SessionCentralMarker;
  }): Session => ({ status: 'idle', lastActivityAt: 0, ...over }) as unknown as Session;

  it('resolveSession follows the marker across re-keys', () => {
    const central = makeMarker('c1');
    const beforeReKey = [sessionOf({ sessionId: 'term-abc', central })];
    const afterReKey = [sessionOf({ sessionId: 'claude-uuid', central })];

    expect(resolveCentralSession('c1', beforeReKey)?.sessionId).toBe('term-abc');
    expect(resolveCentralSession('c1', afterReKey)?.sessionId).toBe('claude-uuid');
  });

  it("skips sessions with no marker or another central's, and answers null when none match", () => {
    const sessions = [
      sessionOf({ sessionId: 'plain' }),
      sessionOf({ sessionId: 'other', central: makeMarker('c2') }),
      sessionOf({ sessionId: 'mine', central: makeMarker('c1') }),
    ];

    expect(resolveCentralSession('c1', sessions)?.sessionId).toBe('mine');
    expect(resolveCentralSession('c3', sessions)).toBeNull();
    expect(resolveCentralSession('c1', [])).toBeNull();
  });

  it('prefers a live card over an ended one, then the most recently active', () => {
    const central = makeMarker('c1');
    const sessions = [
      sessionOf({ sessionId: 'old-ended', status: 'ended', lastActivityAt: 900, central }),
      sessionOf({ sessionId: 'live-old', status: 'idle', lastActivityAt: 100, central }),
      sessionOf({ sessionId: 'live-new', status: 'working', lastActivityAt: 500, central }),
    ];

    expect(resolveCentralSession('c1', sessions)?.sessionId).toBe('live-new');
    expect(resolveCentralSession('c1', sessions.slice(0, 1))?.sessionId).toBe('old-ended');
  });

  it('does not change the sessions it is given', () => {
    const sessions = Object.freeze([sessionOf({ sessionId: 'a', central: makeMarker('c1') })]);

    expect(resolveCentralSession('c1', sessions)?.sessionId).toBe('a');
  });
});

describe('watchCentralLifecycle', () => {
  it('lifecycle revokes on terminal_closed and on terminal exit, never on session end', () => {
    const reg = createCentralRegistry();
    const bus = fakeBus();
    const exits = fakeTerminalExits();
    watchCentralLifecycle(reg, bus.subscribe, exits.subscribe);
    const closed = reg.mint(roomInput('r1'));
    reg.attachTerminal(closed.centralId, 'term-1');
    const exited = reg.mint(roomInput('r2'));
    reg.attachTerminal(exited.centralId, 'term-2');
    const ended = reg.mint(roomInput('r3'));
    reg.attachTerminal(ended.centralId, 'term-3');
    const removed = reg.mint(roomInput('r4'));
    reg.attachTerminal(removed.centralId, 'term-4');
    bus.emit(
      sessionUpdate({
        sessionId: 'claude-uuid-4',
        status: 'idle',
        terminalId: 'term-4',
        central: makeMarker(removed.centralId),
      }),
    );

    bus.emit(terminalClosed('term-1'));
    expect(reg.byId(closed.centralId)).toBeNull();
    expect(reg.list()).toHaveLength(3);

    exits.exit('term-2');
    expect(reg.byId(exited.centralId)).toBeNull();
    expect(reg.list()).toHaveLength(2);
    expect(log.info).toHaveBeenCalledWith('mcp', expect.stringContaining(exited.centralId));

    // The card on the central's terminal ended. A /clear does that while the CLI, and the MCP
    // connection it holds, keep running, so a session ending revokes nothing.
    bus.emit(endedUpdate(ended.centralId, 'term-3'));
    expect(reg.byId(ended.centralId)).not.toBeNull();

    // A removed card is not the end of its central either: its terminal closed (the cases above) or
    // moved to another card, so session_removed revokes nothing.
    bus.emit({ type: 'session_removed', sessionId: 'claude-uuid-4' });
    expect(reg.byId(removed.centralId)).not.toBeNull();
    expect(reg.list()).toHaveLength(2);
  });
});
