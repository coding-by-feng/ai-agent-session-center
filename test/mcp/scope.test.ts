// test/mcp/scope.test.ts — which sessions a central may see (server/mcp/scope.ts), and the compact
// card a read tool returns for one.
import { describe, expect, it } from 'vitest';
import { groupSessionsByProject } from '../../src/lib/projectGroups.js';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { isInScope, isWithin, sessionsInScope, shortIdOf, toSessionCard } from '../../server/mcp/scope.js';
import type { SessionCentralMarker } from '../../server/mcp/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GLOBAL: SessionCentralMarker = { centralId: 'central-global', kind: 'global', scopeRef: null };

const roomCentral = (roomId: string | null): SessionCentralMarker => ({
  centralId: 'central-room',
  kind: 'room',
  scopeRef: roomId,
});

const projectCentral = (folder: string | null): SessionCentralMarker => ({
  centralId: 'central-project',
  kind: 'project',
  scopeRef: folder,
});

/** The central's own workers (server/mcp/workers.ts keeps them by terminal; here, by the sessions named). */
const ownWorkers =
  (...sessionIds: string[]) =>
  (s: Session): boolean =>
    sessionIds.includes(s.sessionId);

const room = (id: string, sessionIds: string[]): Room => ({
  id,
  name: `Room ${id}`,
  sessionIds,
  collapsed: false,
  createdAt: 0,
});

/** A whole Session with only the fields a test names changed: a local one, idle, in /a/proj. */
function makeSession(sessionId: string, over: Partial<Session> = {}): Session {
  return {
    sessionId,
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'proj',
    projectPath: '/a/proj',
    title: '',
    source: 'ssh',
    model: '',
    startedAt: 1,
    lastActivityAt: 1000,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...over,
  };
}

const ids = (list: readonly Session[]): string[] => list.map((s) => s.sessionId);

/** Freezes a value and everything inside it, so a write to an input throws in strict mode. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

describe('global scope', () => {
  it('global sees every session', () => {
    const sessions = [
      makeSession('local'),
      makeSession('remote', { sshHost: 'build-box' }),
      makeSession('ended', { status: 'ended', endedAt: 5 }),
      makeSession('no-folder', { projectPath: '' }),
      makeSession('in-room'),
      makeSession('a-central', { central: roomCentral('r1') }),
    ];
    const rooms = [room('r1', ['in-room'])];

    for (const s of sessions) expect(isInScope(GLOBAL, s, rooms)).toBe(true);
    expect(ids(sessionsInScope(GLOBAL, sessions, rooms))).toEqual(ids(sessions));
  });
});

describe('room scope', () => {
  const rooms = [room('r1', ['a', 'b']), room('r2', ['c'])];
  const sessions = ['a', 'b', 'c', 'd'].map((id) => makeSession(id));

  it('room sees only its members, plus its own workers', () => {
    const central = roomCentral('r1');

    expect(ids(sessionsInScope(central, sessions, rooms))).toEqual(['a', 'b']);
    expect(ids(sessionsInScope(central, sessions, rooms, ownWorkers('d')))).toEqual(['a', 'b', 'd']);
    // An own worker adds itself and nothing else: 'c' is another room's.
    expect(isInScope(central, sessions[2], rooms, ownWorkers('d'))).toBe(false);
  });

  it('reads membership from the rooms it is given, by session id', () => {
    const moved = [room('r1', ['b']), room('r2', ['a', 'c'])];

    expect(isInScope(roomCentral('r1'), makeSession('a'), moved)).toBe(false);
    expect(isInScope(roomCentral('r2'), makeSession('a'), moved)).toBe(true);
  });

  it('an own worker is in scope before the writer files it, and with no room list', () => {
    const central = roomCentral('r1');

    expect(isInScope(central, makeSession('fresh'), rooms)).toBe(false);
    expect(isInScope(central, makeSession('fresh'), rooms, ownWorkers('fresh'))).toBe(true);
    expect(isInScope(central, makeSession('fresh'), [], ownWorkers('fresh'))).toBe(true);
  });

  it('a room that is not in the list has only its own workers', () => {
    const central = roomCentral('gone');

    expect(sessionsInScope(central, sessions, rooms)).toEqual([]);
    expect(ids(sessionsInScope(central, sessions, rooms, ownWorkers('b')))).toEqual(['b']);
  });

  it('a room central with no room id sees nothing, its own workers included', () => {
    const own = ownWorkers('a', 'd');

    for (const roomId of [null, '', '   ']) {
      expect(sessionsInScope(roomCentral(roomId), sessions, rooms), JSON.stringify(roomId)).toEqual([]);
      expect(sessionsInScope(roomCentral(roomId), sessions, rooms, own), JSON.stringify(roomId)).toEqual([]);
    }
  });

  it('no own workers changes nothing', () => {
    expect(ids(sessionsInScope(roomCentral('r1'), sessions, rooms, ownWorkers()))).toEqual(['a', 'b']);
  });
});

describe('project scope', () => {
  it('project scope is folder-and-below, local only', () => {
    const central = projectCentral('/a/proj');
    const inScope = [
      makeSession('same', { projectPath: '/a/proj' }),
      makeSession('child', { projectPath: '/a/proj/server' }),
      makeSession('deep', { projectPath: '/a/proj/server/lib/deep' }),
    ];
    const outOfScope = [
      makeSession('sibling-prefix', { projectPath: '/a/project2' }),
      makeSession('parent', { projectPath: '/a' }),
      makeSession('shorter', { projectPath: '/a/pro' }),
      makeSession('elsewhere', { projectPath: '/b/a/proj' }),
      makeSession('ssh', { projectPath: '/a/proj', sshHost: 'build-box' }),
      makeSession('ssh-below', { projectPath: '/a/proj/server', sshHost: 'build-box' }),
    ];

    for (const s of inScope) expect(isInScope(central, s, []), s.sessionId).toBe(true);
    for (const s of outOfScope) expect(isInScope(central, s, []), s.sessionId).toBe(false);
    expect(ids(sessionsInScope(central, [...outOfScope, ...inScope], []))).toEqual(ids(inScope));
  });

  it('never matches a name that only starts like the folder', () => {
    const central = projectCentral('/a/proj');

    expect(isInScope(central, makeSession('s', { projectPath: '/a/proj-old' }), [])).toBe(false);
    expect(isInScope(central, makeSession('s', { projectPath: '/a/proj.bak/x' }), [])).toBe(false);
    // A folder called "..hidden" is below /a/proj, not a way out of it.
    expect(isInScope(central, makeSession('s', { projectPath: '/a/proj/..hidden' }), [])).toBe(true);
  });

  it('takes any spelling of the folder, on either side', () => {
    const spelled = [
      makeSession('slash', { projectPath: '/a/proj/' }),
      makeSession('doubled', { projectPath: '/a//proj/server' }),
      makeSession('dotted', { projectPath: '/a/./x/../proj' }),
    ];

    for (const scopeRef of ['/a/proj', '/a/proj/', '/a//proj', '/a/x/../proj/']) {
      for (const s of spelled) expect(isInScope(projectCentral(scopeRef), s, []), `${scopeRef} ${s.sessionId}`).toBe(true);
    }
  });

  it('the filesystem root holds every local folder', () => {
    const central = projectCentral('/');

    expect(isInScope(central, makeSession('s', { projectPath: '/a/proj' }), [])).toBe(true);
    expect(isInScope(central, makeSession('s', { projectPath: '/' }), [])).toBe(true);
    expect(isInScope(central, makeSession('s', { projectPath: '/a/proj', sshHost: 'build-box' }), [])).toBe(false);
  });

  it('a session with no folder is never below a folder, not even the one the server runs in', () => {
    // normalizeFolder('') is the server's own working folder: a blank must not be read as that.
    const central = projectCentral(process.cwd());

    for (const projectPath of ['', '   ']) {
      expect(isInScope(central, makeSession('s', { projectPath }), []), JSON.stringify(projectPath)).toBe(false);
    }
    expect(isInScope(central, makeSession('s', { projectPath: process.cwd() }), [])).toBe(true);
  });

  it('a project central with no folder sees nothing, not the folder the server runs in', () => {
    const here = makeSession('here', { projectPath: process.cwd() });

    for (const scopeRef of [null, '', '   ']) {
      expect(isInScope(projectCentral(scopeRef), here, []), JSON.stringify(scopeRef)).toBe(false);
    }
  });

  it('own workers do not widen a project scope', () => {
    const outside = makeSession('outside', { projectPath: '/b/other' });

    expect(isInScope(projectCentral('/a/proj'), outside, [], ownWorkers('outside'))).toBe(false);
  });

  it('rooms do not decide a project scope', () => {
    const central = projectCentral('/a/proj');
    const rooms = [room('r1', ['in-room', 'elsewhere'])];

    expect(isInScope(central, makeSession('in-room', { projectPath: '/a/proj' }), rooms)).toBe(true);
    expect(isInScope(central, makeSession('elsewhere', { projectPath: '/b/other' }), rooms)).toBe(false);
  });

  it('a record with its token also scopes, and a marker of an unknown kind sees nothing', () => {
    const record = { ...projectCentral('/a/proj'), cli: 'claude' as const, token: 'aasc_mcp_x' };
    const unknown = { centralId: 'c', kind: 'galaxy', scopeRef: '/a/proj' } as unknown as SessionCentralMarker;
    const s = makeSession('s');

    expect(isInScope(record, s, [])).toBe(true);
    expect(isInScope(unknown, s, [])).toBe(false);
  });
});

describe('which sessions are local', () => {
  const central = projectCentral('/a/proj');
  const at = (over: Partial<Session>) => makeSession('s', over);

  it('treats an unset host, localhost and the loopback addresses as this Mac, in any case', () => {
    for (const sshHost of [undefined, '', 'localhost', 'LocalHost', '  localhost  ', '127.0.0.1', '::1']) {
      expect(isInScope(central, at({ sshHost }), []), JSON.stringify(sshHost)).toBe(true);
    }
  });

  it('treats any other host as another machine', () => {
    for (const sshHost of ['build-box', 'Build-Box', '10.0.0.5', '192.168.1.20', 'example.com']) {
      expect(isInScope(central, at({ sshHost }), []), sshHost).toBe(false);
    }
  });

  it('does not guess at a host that is not text: unknown is not local', () => {
    expect(isInScope(central, at({ sshHost: 5 as unknown as string }), [])).toBe(false);
    expect(isInScope(central, at({ sshConfig: { host: {} as unknown as string, port: 22 } }), [])).toBe(false);
  });

  it('reads the host from sshConfig when the card has no sshHost', () => {
    expect(isInScope(central, at({ sshConfig: { host: 'build-box', port: 22 } }), [])).toBe(false);
    expect(isInScope(central, at({ sshConfig: { host: 'localhost', port: 22 } }), [])).toBe(true);
  });

  it('fails closed when sshHost and sshConfig name different machines', () => {
    const local = { host: 'localhost', port: 22 };
    const remote = { host: 'build-box', port: 22 };

    expect(isInScope(central, at({ sshHost: 'localhost', sshConfig: remote }), [])).toBe(false);
    expect(isInScope(central, at({ sshHost: 'build-box', sshConfig: local }), [])).toBe(false);
    expect(isInScope(central, at({ sshHost: '', sshConfig: remote }), [])).toBe(false);
  });
});

describe('the local-host rule stays in step with the session strip', () => {
  // The server cannot import src/lib/projectGroups.ts (it reaches the client's types through the
  // `@/` alias, which tsconfig.server.json has no path for), so scope.ts keeps its own copy of the
  // rule. This table is what stops the two drifting: every row goes through BOTH and must agree on
  // whether the session is on this machine.
  const rows: Array<[string, Partial<Session>]> = [
    ['no host at all', {}],
    ['an empty host', { sshHost: '' }],
    ['localhost', { sshHost: 'localhost' }],
    ['LocalHost, mixed case', { sshHost: 'LocalHost' }],
    ['localhost with spaces around it', { sshHost: '  localhost ' }],
    ['127.0.0.1', { sshHost: '127.0.0.1' }],
    ['::1', { sshHost: '::1' }],
    ['another host', { sshHost: 'build-box' }],
    ['another host, upper case', { sshHost: 'BUILD-BOX' }],
    ['a LAN address', { sshHost: '192.168.1.20' }],
    ['a card with only sshConfig, local', { sshConfig: { host: 'localhost', port: 22 } }],
    ['a card with only sshConfig, remote', { sshConfig: { host: 'build-box', port: 22 } }],
    ['sshHost and sshConfig both local', { sshHost: 'localhost', sshConfig: { host: '127.0.0.1', port: 22 } }],
    ['sshHost and sshConfig both remote', { sshHost: 'build-box', sshConfig: { host: 'build-box', port: 22 } }],
  ];

  it('has enough rows to mean something', () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  for (const [name, over] of rows) {
    it(name, () => {
      const s = makeSession('s', { projectPath: '/a/proj', ...over });
      const stripSaysLocal = groupSessionsByProject([s]).groups[0].local;

      expect(isInScope(projectCentral('/a/proj'), s, [])).toBe(stripSaysLocal);
    });
  }
});

describe('sessionsInScope', () => {
  it('returns the sessions in scope in the order given, as a new array', () => {
    const sessions = [
      makeSession('c', { projectPath: '/a/proj/c' }),
      makeSession('x', { projectPath: '/z' }),
      makeSession('a', { projectPath: '/a/proj/a' }),
      makeSession('b', { projectPath: '/a/proj' }),
    ];

    const found = sessionsInScope(projectCentral('/a/proj'), sessions, []);

    expect(ids(found)).toEqual(['c', 'a', 'b']);
    expect(found).not.toBe(sessions);
    expect(found[0]).toBe(sessions[0]);
  });

  it('hands back a new array even when every session is in scope', () => {
    const sessions = [makeSession('a'), makeSession('b')];

    const found = sessionsInScope(GLOBAL, sessions, []);

    expect(found).toEqual(sessions);
    expect(found).not.toBe(sessions);
  });

  it('is empty for no sessions', () => {
    expect(sessionsInScope(GLOBAL, [], [])).toEqual([]);
    expect(sessionsInScope(roomCentral('r1'), [], [room('r1', ['a'])])).toEqual([]);
  });

  it('changes none of what it is given', () => {
    const sessions = deepFreeze([makeSession('a'), makeSession('b', { projectPath: '/z' })]);
    const rooms = deepFreeze([room('r1', ['a'])]);
    const marker = deepFreeze(roomCentral('r1'));

    expect(() => sessionsInScope(marker, sessions, rooms, ownWorkers('b'))).not.toThrow();
    expect(() => sessionsInScope(deepFreeze(projectCentral('/a/proj')), sessions, rooms)).not.toThrow();
    expect(() => sessionsInScope(GLOBAL, sessions, rooms)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

describe('toSessionCard', () => {
  it('toSessionCard maps status, CLI, context %, needsYou from pendingRequest, isCentral from central', () => {
    const s = makeSession('s1', {
      status: 'approval',
      title: 'Fix login',
      cliSource: 'codex',
      projectPath: '/a/proj',
      model: 'gpt-5.5',
      effortLevel: 'medium',
      queueCount: 3,
      lastActivityAt: 1_700_000_000_000,
      pendingRequest: {
        id: 'req-1',
        kind: 'permission',
        cli: 'codex',
        tool: 'Bash',
        raisedAt: 1_700_000_000_000,
        source: 'permission_request',
      },
      central: { centralId: 'c1', kind: 'project', scopeRef: '/a/proj' },
      runtime: { model: 'gpt-5.5-codex', effort: 'high', context: { pct: 42, size: 200_000, tokens: 84_000 } },
    });
    const rooms = [room('r0', ['other']), room('r1', ['x', 's1'])];

    expect(toSessionCard(s, rooms)).toEqual({
      id: 's1',
      shortId: 's1',
      title: 'Fix login',
      status: 'approval',
      started: true,
      cli: 'codex',
      project: '/a/proj',
      roomId: 'r1',
      model: 'gpt-5.5-codex',
      effort: 'high',
      contextPct: 42,
      needsYou: true,
      queueCount: 3,
      isCentral: true,
      lastActivityAt: 1_700_000_000_000,
    });
  });

  it('a plain idle session is not waiting on you and is not a central', () => {
    const card = toSessionCard(makeSession('s2', { pendingRequest: null }), []);

    expect(card.needsYou).toBe(false);
    expect(card.isCentral).toBe(false);
    expect(card.status).toBe('idle');
    expect(card.queueCount).toBe(0);
    expect(card.roomId).toBeNull();
  });

  it('needsYou follows pendingRequest alone: absent, null and set', () => {
    const request = { id: 'r', kind: 'question', cli: 'claude', tool: 'AskUserQuestion', raisedAt: 1, source: 'pre_tool_use' } as const;

    expect(toSessionCard(makeSession('s'), []).needsYou).toBe(false);
    expect(toSessionCard(makeSession('s', { pendingRequest: null }), []).needsYou).toBe(false);
    expect(toSessionCard(makeSession('s', { pendingRequest: request }), []).needsYou).toBe(true);
    // A status that waits on a person says nothing here without the structured request.
    expect(toSessionCard(makeSession('s', { status: 'input' }), []).needsYou).toBe(false);
  });

  it('isCentral follows the session’s own central marker', () => {
    const marker = { centralId: 'c', kind: 'global', scopeRef: null } as const;

    expect(toSessionCard(makeSession('s', { central: marker }), []).isCentral).toBe(true);
    expect(toSessionCard(makeSession('s'), []).isCentral).toBe(false);
  });

  describe('handsOff', () => {
    it('is true on the card of a hands-off session', () => {
      expect(toSessionCard(makeSession('s', { handsOff: true }), []).handsOff).toBe(true);
    });

    it('is absent, not false, on every other card (absent means steerable, as on the session)', () => {
      const plain = toSessionCard(makeSession('s'), []);
      const off = toSessionCard(makeSession('s', { handsOff: false }), []);

      expect(plain).not.toHaveProperty('handsOff');
      expect(off).not.toHaveProperty('handsOff');
    });

    it('only the value true counts: a value that is not a boolean is no mark', () => {
      const odd = { ...makeSession('s'), handsOff: 'yes' } as unknown as Session;

      expect(toSessionCard(odd, [])).not.toHaveProperty('handsOff');
    });

    it('adds that one field to the documented ones and takes nothing else from the session', () => {
      const card = toSessionCard(makeSession('s', { handsOff: true, currentPrompt: 'secret prompt' }), []);

      expect(Object.keys(card).sort()).toEqual(
        [
          'id', 'shortId', 'title', 'status', 'started', 'cli', 'project', 'roomId', 'model', 'effort',
          'contextPct', 'needsYou', 'queueCount', 'isCentral', 'lastActivityAt', 'handsOff',
        ].sort(),
      );
      expect(JSON.stringify(card)).not.toContain('secret prompt');
    });

    it('is independent of being a central', () => {
      const marker = { centralId: 'c', kind: 'global', scopeRef: null } as const;
      const card = toSessionCard(makeSession('s', { central: marker, handsOff: true }), []);

      expect(card).toMatchObject({ isCentral: true, handsOff: true });
    });
  });

  describe('title', () => {
    it('is the session title, else its project name, else Unnamed', () => {
      expect(toSessionCard(makeSession('s', { title: ' Fix login ' }), []).title).toBe('Fix login');
      expect(toSessionCard(makeSession('s', { title: '', projectName: 'agent-manager' }), []).title).toBe('agent-manager');
      expect(toSessionCard(makeSession('s', { title: '  ', projectName: '' }), []).title).toBe('Unnamed');
    });
  });

  describe('cli', () => {
    const cliOf = (cliSource: string | undefined) => toSessionCard(makeSession('s', { cliSource }), []).cli;

    it('is claude or codex, whatever the case or spacing of cliSource', () => {
      expect(cliOf('claude')).toBe('claude');
      expect(cliOf('codex')).toBe('codex');
      expect(cliOf('Claude')).toBe('claude');
      expect(cliOf('  CODEX ')).toBe('codex');
    });

    it('is null for another CLI, an empty value, or none', () => {
      expect(cliOf('gemini')).toBeNull();
      expect(cliOf('')).toBeNull();
      expect(cliOf(undefined)).toBeNull();
    });

    it('is null for a value that is not text', () => {
      const odd = makeSession('s', { cliSource: 7 as unknown as string });

      expect(toSessionCard(odd, []).cli).toBeNull();
    });

    describe('without a cliSource, it is read the way the plan limits read it (planCliOf)', () => {
      const claudeEvents = [{ type: 'PreToolUse', timestamp: 1, detail: '' }];

      it('names the CLI of a hook-only card from its events', () => {
        const card = toSessionCard(makeSession('s', { events: claudeEvents }), []);

        expect(card.cli).toBe('claude');
      });

      it('names it from the launch command, then the model', () => {
        expect(toSessionCard(makeSession('s', { startupCommand: 'codex --full-auto' }), []).cli).toBe('codex');
        expect(toSessionCard(makeSession('s', { model: 'claude-opus-4' }), []).cli).toBe('claude');
        expect(toSessionCard(makeSession('s', { model: 'gpt-5.5' }), []).cli).toBe('codex');
      });

      it('applies to a blank or non-text cliSource too', () => {
        expect(toSessionCard(makeSession('s', { cliSource: '  ', events: claudeEvents }), []).cli).toBe('claude');
        const odd = makeSession('s', { cliSource: 7 as unknown as string, events: claudeEvents });

        expect(toSessionCard(odd, []).cli).toBe('claude');
      });

      it('is still null when nothing says which CLI it is', () => {
        expect(toSessionCard(makeSession('s'), []).cli).toBeNull();
      });

      it('leaves an explicit other CLI alone: gemini is gemini however its events read', () => {
        const card = toSessionCard(makeSession('s', { cliSource: 'gemini', events: claudeEvents }), []);

        expect(card.cli).toBeNull();
      });

      it('lets an explicit claude or codex win over what the launch command says', () => {
        const s = makeSession('s', { cliSource: 'claude', startupCommand: 'codex' });

        expect(toSessionCard(s, []).cli).toBe('claude');
      });
    });
  });

  describe('shortId', () => {
    it('is the first 8 characters of the id, the form the Queue view shows', () => {
      expect(toSessionCard(makeSession('0123456789abcdef'), []).shortId).toBe('01234567');
      expect(toSessionCard(makeSession('0123456789abcdef'), []).id).toBe('0123456789abcdef');
    });

    it('is the whole id when it is shorter than 8', () => {
      expect(toSessionCard(makeSession('abc'), []).shortId).toBe('abc');
      expect(toSessionCard(makeSession('12345678'), []).shortId).toBe('12345678');
    });

    it('is plain: an id is whatever a hook said (up to 256 characters of anything), and a short id is shown in text', () => {
      const hostile = 'a\n<b>"x"\u0000ZZZZZZZZZZ';

      expect(toSessionCard(makeSession(hostile), []).shortId).toBe('a__b__x_');
      expect(shortIdOf('ok-id_1.2:3')).toBe('ok-id_1.');
      expect(shortIdOf('\n'.repeat(300))).toBe('________');
    });
  });

  describe('contextPct', () => {
    const pctOf = (runtime: Session['runtime']) => toSessionCard(makeSession('s', { runtime }), []).contextPct;

    it('is the context window’s used share, as a whole number', () => {
      expect(pctOf({ context: { pct: 42 } })).toBe(42);
      expect(pctOf({ context: { pct: 37.6, size: 1000, tokens: 376 } })).toBe(38);
      expect(pctOf({ context: { pct: 100 } })).toBe(100);
    });

    it('is 0 for a window that is really empty, not null', () => {
      expect(pctOf({ context: { pct: 0 } })).toBe(0);
    });

    it('is null when nothing was reported', () => {
      expect(pctOf(undefined)).toBeNull();
      expect(pctOf({})).toBeNull();
      expect(pctOf({ model: 'opus', context: undefined })).toBeNull();
      expect(pctOf({ context: null as unknown as undefined })).toBeNull();
    });

    it('is null for a reading that is not a number', () => {
      expect(pctOf({ context: { pct: Number.NaN } })).toBeNull();
      expect(pctOf({ context: { pct: '42' as unknown as number } })).toBeNull();
    });
  });

  describe('roomId', () => {
    it('is the room that lists the session, else null', () => {
      const rooms = [room('r1', ['a']), room('r2', ['b', 's']), room('r3', ['c'])];

      expect(toSessionCard(makeSession('s'), rooms).roomId).toBe('r2');
      expect(toSessionCard(makeSession('nobody'), rooms).roomId).toBeNull();
      expect(toSessionCard(makeSession('s'), []).roomId).toBeNull();
    });

    it('is the first room when a stale list names the session twice', () => {
      expect(toSessionCard(makeSession('s'), [room('r1', ['s']), room('r2', ['s'])]).roomId).toBe('r1');
    });
  });

  describe('project', () => {
    it('is the session’s folder, in the one spelling a project central files it under', () => {
      expect(toSessionCard(makeSession('s', { projectPath: '/a/proj' }), []).project).toBe('/a/proj');
      expect(toSessionCard(makeSession('s', { projectPath: '/a/proj/' }), []).project).toBe('/a/proj');
      expect(toSessionCard(makeSession('s', { projectPath: '/a//x/../proj' }), []).project).toBe('/a/proj');
    });

    it('is the path as written for a session on another machine', () => {
      const remote = makeSession('s', { projectPath: '/srv/app/', sshHost: 'build-box' });

      expect(toSessionCard(remote, []).project).toBe('/srv/app/');
    });

    it('is null when the session has no folder, not the server’s own', () => {
      expect(toSessionCard(makeSession('s', { projectPath: '' }), []).project).toBeNull();
      expect(toSessionCard(makeSession('s', { projectPath: '   ' }), []).project).toBeNull();
    });
  });

  describe('model and effort', () => {
    it('are what the CLI reports now, else what it was launched with', () => {
      const live = makeSession('s', {
        model: 'opus',
        effortLevel: 'high',
        runtime: { model: 'Opus 5.5', effort: 'xhigh' },
      });
      const launched = makeSession('s', { model: 'opus', effortLevel: 'high' });

      expect(toSessionCard(live, [])).toMatchObject({ model: 'Opus 5.5', effort: 'xhigh' });
      expect(toSessionCard(launched, [])).toMatchObject({ model: 'opus', effort: 'high' });
    });

    it('fall back one at a time', () => {
      const s = makeSession('s', { model: 'opus', effortLevel: 'high', runtime: { effort: 'low' } });

      expect(toSessionCard(s, [])).toMatchObject({ model: 'opus', effort: 'low' });
    });

    it('are null when neither is known, empty text included', () => {
      const s = makeSession('s', { model: '', effortLevel: undefined, runtime: { model: '', effort: '' } });

      expect(toSessionCard(s, [])).toMatchObject({ model: null, effort: null });
      expect(toSessionCard(makeSession('s'), [])).toMatchObject({ model: null, effort: null });
    });
  });

  it('queueCount is the session’s queue length, 0 when it has none recorded', () => {
    const noCount = { ...makeSession('s'), queueCount: undefined } as unknown as Session;

    expect(toSessionCard(makeSession('s', { queueCount: 4 }), []).queueCount).toBe(4);
    expect(toSessionCard(noCount, []).queueCount).toBe(0);
  });

  it('lastActivityAt is passed through', () => {
    expect(toSessionCard(makeSession('s', { lastActivityAt: 1_234_567 }), []).lastActivityAt).toBe(1_234_567);
  });

  it('has exactly the documented fields and nothing else of the session', () => {
    const card = toSessionCard(
      makeSession('s', {
        currentPrompt: 'secret prompt',
        central: { centralId: 'c', kind: 'global', scopeRef: null },
      }),
      [],
    );

    expect(Object.keys(card).sort()).toEqual(
      [
        'id', 'shortId', 'title', 'status', 'started', 'cli', 'project', 'roomId', 'model', 'effort',
        'contextPct', 'needsYou', 'queueCount', 'isCentral', 'lastActivityAt',
      ].sort(),
    );
    expect(JSON.stringify(card)).not.toContain('secret prompt');
  });

  it('changes none of what it is given, and shares nothing with it', () => {
    const s = deepFreeze(makeSession('s', { runtime: { context: { pct: 10 } }, central: { centralId: 'c', kind: 'global', scopeRef: null } }));
    const rooms = deepFreeze([room('r1', ['s'])]);

    const card = toSessionCard(s, rooms);

    expect(card).toMatchObject({ id: 's', roomId: 'r1', contextPct: 10, isCentral: true });
    expect(Object.values(card).every((v) => v === null || typeof v !== 'object')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isWithin (shared with the tools that take a folder)
// ---------------------------------------------------------------------------

describe('isWithin', () => {
  it('is true for the folder itself and anything below it', () => {
    expect(isWithin('/a/proj', '/a/proj')).toBe(true);
    expect(isWithin('/a/proj/src/x', '/a/proj')).toBe(true);
  });

  it('is false for a sibling that only shares a prefix, and for a parent', () => {
    expect(isWithin('/a/project2', '/a/proj')).toBe(false);
    expect(isWithin('/a', '/a/proj')).toBe(false);
  });

  it('is case-sensitive, like the folder rule of a project central', () => {
    expect(isWithin('/A/Proj', '/a/proj')).toBe(false);
  });
});
