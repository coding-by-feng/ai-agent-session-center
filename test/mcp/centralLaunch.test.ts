// test/mcp/centralLaunch.test.ts — what makes a launch a central's (server/mcp/centralLaunch.ts).
//
// What must hold:
//   - a NEW central launch is refused BEFORE anything is minted or spawned when it cannot be a working
//     central: a caller that is not this Mac (403), a remote host, tmux, a command that is not a bare
//     `claude` / `codex`, a room central with no room or a room that does not exist, a project scope that
//     is the root or the home folder (400);
//   - a relaunch of a central that exists is never refused (Ruling 16): when its central cannot be
//     established again, for any reason, it is a plain session, and why is logged (never a token); with
//     central sessions switched off it keeps its marker and nothing is minted; where the caller is does not
//     count for a relaunch (Ruling 18): a phone's Restart keeps a central a central; a central live in a
//     terminal that is not the relaunched card's own is left there, never minted again (two cards, one
//     central);
//   - a central terminal that ends up without a card is closed, and its central revoked;
//   - otherwise it is minted, or re-minted under the id it already has (a relaunch: same id, new token,
//     no terminal yet), with the CLI taken from the command word and a project scope defaulting to the
//     launch's own folder;
//   - a spawn that fails, or a terminal that comes up without the central attached, leaves no record
//     behind: a token nobody holds must not keep its scope;
//   - a refusal reads as the HTTP answer the routes give, and never carries a token.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

import {
  CENTRAL_LOCAL_ONLY,
  CentralLaunchError,
  bareCliCommand,
  centralCliOf,
  centralLaunchRefusal,
  centralRequestSchema,
  discardCentralTerminal,
  prepareCentralLaunch,
  prepareCentralRelaunch,
  relaunchCentralOrPlain,
  spawnCentralTerminal,
  type CentralLaunchContext,
} from '../../server/mcp/centralLaunch.js';
import { CentralScopeTakenError, centrals } from '../../server/mcp/centrals.js';
import { ToolError } from '../../server/mcp/types.js';
import { config } from '../../server/serverConfig.js';
import type { Session } from '../../src/types/session.js';
import { globalInput, makeMarker } from './centralFixtures.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROOM = 'room-ops';

const ctx = (over: Partial<CentralLaunchContext> = {}): CentralLaunchContext => ({
  command: 'claude --dangerously-skip-permissions',
  permissionMode: 'bypassPermissions',
  workingDir: '/tmp/central-proj',
  isLocal: true,
  roomExists: (id) => id === ROOM,
  ...over,
});

/** What a refused launch threw: a CentralLaunchError carrying the HTTP status the routes answer with. */
function refusalOf(run: () => unknown): CentralLaunchError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(CentralLaunchError);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID');
    return err as CentralLaunchError;
  }
  throw new Error('expected the launch to be refused');
}

afterEach(() => {
  for (const record of centrals.list()) centrals.revoke(record.centralId);
  delete config.mcp;
  log.warn.mockClear();
});

describe('centralCliOf: the CLI a launch line starts', () => {
  it.each([
    ['claude', 'claude'],
    ['claude --model opus -n "Notes"', 'claude'],
    ['codex --yolo', 'codex'],
    ["claude --resume 'abc' || claude", 'claude'],
    ['  codex', 'codex'],
  ])('%j starts %s', (line, cli) => {
    expect(centralCliOf(line)).toBe(cli);
  });

  it.each([
    '',
    '   ',
    '/usr/local/bin/claude',
    'npx claude',
    'echo claude',
    "'claude'",
    'FOO=1 claude',
    'claude-code',
    'bash',
    'npm run dev && claude',
  ])('%j starts no bare claude or codex', (line) => {
    expect(centralCliOf(line)).toBeNull();
  });
});

describe('prepareCentralLaunch', () => {
  it('mints a global central under a new id, with no scope', () => {
    const marker = prepareCentralLaunch({ kind: 'global' }, ctx());
    expect(marker).toEqual({
      centralId: expect.stringMatching(UUID_RE),
      kind: 'global',
      scopeRef: null,
    });
    expect(centrals.byId(marker.centralId)).toMatchObject({
      kind: 'global',
      scopeRef: null,
      cli: 'claude',
      permissionMode: 'bypassPermissions',
      terminalId: null,
    });
  });

  it('gives a global central no scope, whatever scopeRef it is sent', () => {
    expect(
      prepareCentralLaunch({ kind: 'global', scopeRef: 'room-ops' }, ctx()).scopeRef,
    ).toBeNull();
  });

  it('takes the CLI from the command word: a codex central gets the core toolsets', () => {
    const marker = prepareCentralLaunch({ kind: 'global' }, ctx({ command: 'codex --yolo' }));
    const record = centrals.byId(marker.centralId);
    expect(record?.cli).toBe('codex');
    expect(record?.toolsets).toEqual([
      'sessions',
      'conversation',
      'prompts',
      'tasks',
      'requests',
      'queue',
      'system',
    ]);
  });

  it('defaults a project central to the launch folder, normalized', () => {
    const marker = prepareCentralLaunch(
      { kind: 'project' },
      ctx({ workingDir: '/tmp/x/../central-proj/' }),
    );
    expect(marker.scopeRef).toBe('/tmp/central-proj');
    centrals.revoke(marker.centralId);
    const fromHome = prepareCentralLaunch(
      { kind: 'project', scopeRef: '' },
      ctx({ workingDir: '~/proj' }),
    );
    expect(fromHome.scopeRef).toBe(join(homedir(), 'proj'));
  });

  it('keeps the folder a project central is given, normalized', () => {
    expect(prepareCentralLaunch({ kind: 'project', scopeRef: '/srv/app/' }, ctx()).scopeRef).toBe(
      '/srv/app',
    );
  });

  it('refuses the root folder and the home folder as a project scope: they would take in every session', () => {
    const root = refusalOf(() => prepareCentralLaunch({ kind: 'project', scopeRef: '/' }, ctx()));
    expect(root.status).toBe(400);
    expect(root.message).toMatch(/not the root folder/);
    for (const named of ['~', '~/', `${homedir()}/`, `${homedir()}/proj/..`]) {
      const home = refusalOf(() =>
        prepareCentralLaunch({ kind: 'project', scopeRef: named }, ctx()),
      );
      expect(home.message).toMatch(/not your home folder/);
    }
    // The launch folder it would default to counts the same.
    expect(
      refusalOf(() => prepareCentralLaunch({ kind: 'project' }, ctx({ workingDir: '~' }))).status,
    ).toBe(400);
    expect(centrals.list()).toEqual([]);
  });

  it('refuses every folder that holds the home folder, such as /Users on macOS', () => {
    const above = dirname(homedir());
    const refused = refusalOf(() =>
      prepareCentralLaunch({ kind: 'project', scopeRef: `${above}/` }, ctx()),
    );

    expect(refused.status).toBe(400);
    expect(refused.message).toBe(
      above === '/'
        ? 'A project central needs a project folder, not the root folder: its scope would take in every session'
        : `A project central needs a project folder, not ${above}, which holds your home folder: its scope would take in every session`,
    );
    expect(centrals.list()).toEqual([]);
  });

  it('allows a sibling of the home folder, even one whose name it starts with, and a folder inside it', () => {
    // Anchored at a separator, as scope.ts matches: `<home>2` and `<home minus a letter>` hold no home.
    for (const folder of [`${homedir()}2`, homedir().slice(0, -1), join(homedir(), 'proj')]) {
      expect(prepareCentralLaunch({ kind: 'project', scopeRef: folder }, ctx()).scopeRef).toBe(
        folder,
      );
    }
    expect(centrals.list()).toHaveLength(3);
  });

  it('starts a room central for a room that exists', () => {
    const marker = prepareCentralLaunch({ kind: 'room', scopeRef: ROOM }, ctx());
    expect(marker).toMatchObject({ kind: 'room', scopeRef: ROOM });
    expect(centrals.findByScope('room', ROOM)?.centralId).toBe(marker.centralId);
  });

  it('refuses a room central with no room, or a room that does not exist, minting nothing', () => {
    expect(refusalOf(() => prepareCentralLaunch({ kind: 'room' }, ctx())).status).toBe(400);
    expect(
      refusalOf(() => prepareCentralLaunch({ kind: 'room', scopeRef: '  ' }, ctx())).status,
    ).toBe(400);
    const missing = refusalOf(() =>
      prepareCentralLaunch({ kind: 'room', scopeRef: 'room-gone' }, ctx()),
    );
    expect(missing.status).toBe(400);
    expect(missing.message).toMatch(/room-gone/);
    expect(centrals.list()).toEqual([]);
  });

  it('refuses a NEW central for a caller that is not this Mac with a 403, before any other check', () => {
    const refused = refusalOf(() =>
      prepareCentralLaunch(
        { kind: 'room', scopeRef: 'room-gone' },
        ctx({ isLocal: false, command: 'bash' }),
      ),
    );
    expect(refused.status).toBe(403);
    expect(refused.message).toBe(CENTRAL_LOCAL_ONLY);
    expect(centrals.list()).toEqual([]);
  });

  it('mints again a central a caller that is not this Mac relaunches by its id (Ruling 18)', () => {
    const record = centrals.mint(globalInput());

    const marker = prepareCentralLaunch(
      { kind: 'global', scopeRef: null, centralId: record.centralId },
      ctx({ isLocal: false }),
    );

    expect(marker).toEqual(makeMarker(record.centralId));
    expect(centrals.byId(record.centralId)?.token).not.toBe(record.token);
  });

  it('refuses a remote host and tmux: the token belongs on this Mac, in one PTY', () => {
    expect(
      refusalOf(() => prepareCentralLaunch({ kind: 'global' }, ctx({ remoteHost: true }))).status,
    ).toBe(400);
    const tmux = refusalOf(() => prepareCentralLaunch({ kind: 'global' }, ctx({ tmux: true })));
    expect(tmux.status).toBe(400);
    expect(tmux.message).toMatch(/tmux/);
    expect(centrals.list()).toEqual([]);
  });

  it.each(['/usr/local/bin/claude', '', 'npm run dev && claude', 'bash'])(
    'refuses a launch of %j: only a bare claude or codex is wired',
    (command) => {
      const refused = refusalOf(() => prepareCentralLaunch({ kind: 'global' }, ctx({ command })));
      expect(refused.status).toBe(400);
      expect(refused.message).toMatch(/claude|codex/);
      expect(centrals.list()).toEqual([]);
    },
  );

  it('re-mints a central it is given the id of: same id and start, a new token, no terminal yet', () => {
    const first = centrals.mint(globalInput());
    centrals.attachTerminal(first.centralId, 'term-old');
    const marker = prepareCentralLaunch({ kind: 'global', centralId: first.centralId }, ctx());
    expect(marker.centralId).toBe(first.centralId);
    const again = centrals.byId(first.centralId);
    expect(again?.token).not.toBe(first.token);
    expect(again?.terminalId).toBeNull();
    expect(again?.createdAt).toBe(first.createdAt);
  });

  it('mints a saved central under its old id when the registry no longer holds it (a restore)', () => {
    const saved = '7d6c4c1e-1b0a-4c3e-9f5a-2b8e1d0c9a77';
    expect(prepareCentralLaunch({ kind: 'global', centralId: saved }, ctx()).centralId).toBe(saved);
    expect(centrals.byId(saved)?.kind).toBe('global');
  });

  it('lets CentralScopeTakenError through when another central holds the scope', () => {
    centrals.mint(globalInput());
    expect(() => prepareCentralLaunch({ kind: 'global' }, ctx())).toThrow(CentralScopeTakenError);
  });

  it('with central sessions switched off: refuses a new central, keeps a known one as a marker without minting', () => {
    config.mcp = { enabled: false };
    expect(refusalOf(() => prepareCentralLaunch({ kind: 'global' }, ctx())).status).toBe(400);
    const saved = '0f1e2d3c-4b5a-4968-8776-655443322110';
    const marker = prepareCentralLaunch(
      { kind: 'project', centralId: saved },
      ctx({ workingDir: '/srv/app/' }),
    );
    expect(marker).toEqual({ centralId: saved, kind: 'project', scopeRef: '/srv/app' });
    expect(centrals.list()).toEqual([]);
  });
});

describe('prepareCentralRelaunch', () => {
  const launch = {
    command: "claude --resume 'x' || claude",
    workingDir: '/tmp/central-proj',
    remoteHost: false,
  };
  const caller = {
    isLocal: true,
    roomExists: (id: string) => id === ROOM,
    isTerminalLive: (id: string) => id === 'term-live',
  };
  const SESSION = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
  const OTHER_ID = '0f1e2d3c-4b5a-4697-8877-665544332211';
  /** Every warning logged so far, as one string: what a log line could leak. */
  const warned = (): string => JSON.stringify(log.warn.mock.calls);

  it('leaves a card that is no central alone', () => {
    const card = { sessionId: SESSION, permissionMode: null };
    expect(prepareCentralRelaunch(card, launch, caller)).toEqual({ central: undefined });
    expect(centrals.list()).toEqual([]);
  });

  it("re-mints the card's central with its own kind and scope", () => {
    const record = centrals.mint({
      kind: 'room',
      scopeRef: ROOM,
      cli: 'claude',
      permissionMode: null,
    });
    const card = {
      sessionId: SESSION,
      central: { centralId: record.centralId, kind: 'room' as const, scopeRef: ROOM },
      permissionMode: 'default',
    };
    const plan = prepareCentralRelaunch(card, launch, caller);
    expect(plan).toEqual({ central: card.central });
    expect(centrals.byId(record.centralId)?.token).not.toBe(record.token);
    expect(centrals.byId(record.centralId)?.permissionMode).toBe('default');
  });

  it('keeps the marker and mints nothing with central sessions switched off, so the card is wired again later', () => {
    config.mcp = { enabled: false };
    const card = { sessionId: SESSION, central: makeMarker(OTHER_ID), permissionMode: null };

    expect(prepareCentralRelaunch(card, launch, caller)).toEqual({ central: card.central });
    expect(centrals.list()).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('relaunches the same central for a caller that is not this Mac (Ruling 18)', () => {
    const record = centrals.mint(globalInput());
    const card = {
      sessionId: SESSION,
      central: makeMarker(record.centralId),
      permissionMode: null,
    };

    const plan = prepareCentralRelaunch(card, launch, { ...caller, isLocal: false });

    expect(plan).toEqual({ central: card.central });
    expect(centrals.byId(record.centralId)?.token).not.toBe(record.token);
    expect(log.warn).not.toHaveBeenCalled();
  });

  describe('a central that cannot be established again: a plain session, never a failure (Ruling 16)', () => {
    it('a room that is gone: the reason is logged under the session id', () => {
      const card = {
        sessionId: SESSION,
        central: { centralId: OTHER_ID, kind: 'room' as const, scopeRef: 'room-gone' },
        permissionMode: null,
      };

      const plan = prepareCentralRelaunch(card, launch, caller);

      expect(plan.central).toBeUndefined();
      expect(plan.dropped).toBe('Room "room-gone" does not exist');
      expect(centrals.list()).toEqual([]);
      expect(warned()).toContain(SESSION);
      expect(warned()).toContain(OTHER_ID);
      expect(warned()).toContain('Room \\"room-gone\\" does not exist');
    });

    it('a scope another central now holds: that central and its token are left alone', () => {
      const holder = centrals.mint(globalInput());
      const card = { sessionId: SESSION, central: makeMarker(OTHER_ID), permissionMode: null };

      const plan = prepareCentralRelaunch(card, launch, caller);

      expect(plan).toEqual({ central: undefined, dropped: 'A global central is already running' });
      expect(centrals.list().map((r) => r.centralId)).toEqual([holder.centralId]);
      expect(centrals.byId(holder.centralId)?.token).toBe(holder.token);
      expect(warned()).not.toContain(holder.token);
    });

    it('a launch that cannot carry it, and any other failure', () => {
      const card = { sessionId: SESSION, central: makeMarker(OTHER_ID), permissionMode: null };
      const room = {
        ...card,
        central: { centralId: OTHER_ID, kind: 'room' as const, scopeRef: ROOM },
      };
      const unreadable = {
        ...caller,
        roomExists: () => {
          throw new Error('rooms unreadable');
        },
      };

      expect(
        prepareCentralRelaunch(card, { ...launch, command: 'npx claude' }, caller).dropped,
      ).toMatch(/bare claude or codex/);
      expect(prepareCentralRelaunch(card, { ...launch, remoteHost: true }, caller).dropped).toMatch(
        /remote host/,
      );
      expect(prepareCentralRelaunch(card, { ...launch, tmux: true }, caller).dropped).toMatch(
        /tmux/,
      );
      expect(prepareCentralRelaunch(room, launch, unreadable)).toEqual({
        central: undefined,
        dropped: 'rooms unreadable',
      });
      expect(centrals.list()).toEqual([]);
    });

    it('a project scope that is the home folder, or holds it', () => {
      const card = {
        sessionId: SESSION,
        central: { centralId: OTHER_ID, kind: 'project' as const, scopeRef: homedir() },
        permissionMode: null,
      };
      const above = {
        ...card,
        central: { ...card.central, scopeRef: dirname(homedir()) },
      };

      expect(prepareCentralRelaunch(card, launch, caller).dropped).toMatch(/not your home folder/);
      expect(prepareCentralRelaunch(above, launch, caller)).toEqual({
        central: undefined,
        dropped: expect.stringMatching(/which holds your home folder|not the root folder/),
      });
      expect(centrals.list()).toEqual([]);
    });

    it('two cards, one central: one live in another terminal stays there, its token untouched', () => {
      const record = centrals.mint(globalInput());
      centrals.attachTerminal(record.centralId, 'term-live');
      const card = {
        sessionId: SESSION,
        terminalId: 'term-dead',
        central: makeMarker(record.centralId),
        permissionMode: null,
      };

      const plan = prepareCentralRelaunch(card, launch, caller);

      expect(plan.central).toBeUndefined();
      expect(plan.dropped).toMatch(/live in another session's terminal \(term-live\)/);
      expect(centrals.byId(record.centralId)).toMatchObject({
        token: record.token,
        terminalId: 'term-live',
      });
    });
  });

  it("a restart's own live terminal is no obstacle: the central is minted again", () => {
    const record = centrals.mint(globalInput());
    centrals.attachTerminal(record.centralId, 'term-live');
    const card = {
      sessionId: SESSION,
      terminalId: 'term-live',
      central: makeMarker(record.centralId),
      permissionMode: null,
    };

    expect(prepareCentralRelaunch(card, launch, caller)).toEqual({ central: card.central });
    expect(centrals.byId(record.centralId)?.token).not.toBe(record.token);
  });
});

describe('relaunchCentralOrPlain: a restore or respawn that names its central', () => {
  const saved = '2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901';
  const newCard = { own: null, isLive: () => false };

  it('mints the same central again when it can', () => {
    const plan = relaunchCentralOrPlain(
      { kind: 'global', centralId: saved },
      ctx(),
      'restore-1',
      newCard,
    );

    expect(plan).toEqual({ central: { centralId: saved, kind: 'global', scopeRef: null } });
    expect(centrals.byId(saved)).toMatchObject({ kind: 'global', terminalId: null });
  });

  it('falls back to a plain session when it cannot, naming the session in the log', () => {
    const plan = relaunchCentralOrPlain(
      { kind: 'room', scopeRef: 'room-gone', centralId: saved },
      ctx(),
      'restore-1',
      newCard,
    );

    expect(plan).toEqual({ central: undefined, dropped: 'Room "room-gone" does not exist' });
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('Session restore-1'));
    expect(centrals.list()).toEqual([]);
  });
});

describe('discardCentralTerminal: a central terminal left without a card', () => {
  it('closes the terminal and revokes the central; a plain launch is left alone', () => {
    const record = centrals.mint(globalInput());
    centrals.attachTerminal(record.centralId, 'term-orphan');
    const close = vi.fn();

    discardCentralTerminal(undefined, 'term-plain', close);
    discardCentralTerminal(makeMarker(record.centralId), 'term-orphan', close);

    expect(close.mock.calls).toEqual([['term-orphan']]);
    expect(centrals.byId(record.centralId)).toBeNull();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(record.token);
  });
});

describe('spawnCentralTerminal', () => {
  it('spawns as usual for a launch that is no central', async () => {
    await expect(spawnCentralTerminal(undefined, async () => 'term-1')).resolves.toBe('term-1');
  });

  it('keeps a central its new terminal attached', async () => {
    const record = centrals.mint(globalInput());
    const id = await spawnCentralTerminal(makeMarker(record.centralId), async () => {
      centrals.attachTerminal(record.centralId, 'term-2');
      return 'term-2';
    });
    expect(id).toBe('term-2');
    expect(centrals.byId(record.centralId)?.terminalId).toBe('term-2');
  });

  it('revokes the central when the spawn fails, and lets the failure through', async () => {
    const record = centrals.mint(globalInput());
    await expect(
      spawnCentralTerminal(makeMarker(record.centralId), async () => {
        throw new Error('spawn failed');
      }),
    ).rejects.toThrow('spawn failed');
    expect(centrals.byId(record.centralId)).toBeNull();
    expect(centrals.findByScope('global', null)).toBeNull();
  });

  it('revokes a central its terminal came up without: nobody holds that token', async () => {
    const record = centrals.mint(globalInput());
    await expect(
      spawnCentralTerminal(makeMarker(record.centralId), async () => 'term-3'),
    ).resolves.toBe('term-3');
    expect(centrals.byId(record.centralId)).toBeNull();
    const warned = log.warn.mock.calls.map((call) => String(call[1])).join('\n');
    expect(warned).toMatch(record.centralId);
    expect(warned).not.toMatch(record.token);
  });
});

describe('centralLaunchRefusal: the answer a route gives', () => {
  const card = (
    sessionId: string,
    centralId: string,
    status: Session['status'] = 'idle',
  ): Session =>
    ({
      sessionId,
      status,
      lastActivityAt: 1,
      central: makeMarker(centralId),
    }) as unknown as Session;

  it("answers 409 naming the card the scope's central runs in, without its token", () => {
    const record = centrals.mint(globalInput());
    centrals.attachTerminal(record.centralId, 'term-9');
    let thrown: unknown;
    try {
      centrals.mint(globalInput());
    } catch (err) {
      thrown = err;
    }
    const refusal = centralLaunchRefusal(thrown, [
      card('other', 'someone-else'),
      card('11111111-2222-4333-8444-555555555555', record.centralId),
    ]);
    expect(refusal?.status).toBe(409);
    expect(refusal?.body.error).toBe(
      'A global central is already running (#11111111-2222-4333-8444-555555555555)',
    );
    expect(refusal?.body.existing).toMatchObject({
      centralId: record.centralId,
      kind: 'global',
      terminalId: 'term-9',
    });
    expect(refusal?.body.existing).not.toHaveProperty('token');
    expect(JSON.stringify(refusal)).not.toContain(record.token);
  });

  it('names the terminal when no card carries the central', () => {
    const record = centrals.mint(globalInput());
    centrals.attachTerminal(record.centralId, 'term-10');
    const refusal = centralLaunchRefusal(
      new CentralScopeTakenError(centrals.byId(record.centralId)!),
      [],
    );
    expect(refusal?.body.error).toBe('A global central is already running (#term-10)');
  });

  it('answers a refused launch with its own status, and a registry INVALID with 400', () => {
    expect(centralLaunchRefusal(new CentralLaunchError(403, 'not here'), [])).toEqual({
      status: 403,
      body: { ok: false, error: 'not here' },
    });
    expect(centralLaunchRefusal(new ToolError('INVALID', 'blank id'), [])?.status).toBe(400);
  });

  it('is null for anything else, so the route answers it as the failure it is', () => {
    expect(centralLaunchRefusal(new Error('boom'), [])).toBeNull();
    expect(centralLaunchRefusal(new ToolError('NOT_FOUND', 'gone'), [])).toBeNull();
  });
});

describe("centralRequestSchema: POST /api/terminals' central field", () => {
  it('takes a marker as a session carries it, global scope null included', () => {
    const marker = {
      centralId: '7d6c4c1e-1b0a-4c3e-9f5a-2b8e1d0c9a77',
      kind: 'global',
      scopeRef: null,
    };
    expect(centralRequestSchema.parse(marker)).toEqual(marker);
    expect(centralRequestSchema.parse({ kind: 'project' })).toEqual({ kind: 'project' });
  });

  it('refuses an unknown kind and an id that is not a UUID', () => {
    expect(centralRequestSchema.safeParse({ kind: 'everything' }).success).toBe(false);
    expect(centralRequestSchema.safeParse({ kind: 'global', centralId: 'mcp:../x' }).success).toBe(
      false,
    );
    expect(
      centralRequestSchema.safeParse({ kind: 'room', scopeRef: 'r'.repeat(2000) }).success,
    ).toBe(false);
  });
});

describe('bareCliCommand: a stored command typed as a central launch', () => {
  it.each([
    ['/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex --yolo', 'codex --yolo'],
    ['/Users/me/.local/bin/claude --model opus -n Notes', 'claude --model opus -n Notes'],
    ['/usr/local/bin/codex', 'codex'],
  ])('%j becomes %j', (line, bare) => {
    expect(bareCliCommand(line)).toBe(bare);
  });

  it.each([
    'claude --model opus',
    'codex',
    '/usr/bin/claude-code --x',
    'npx claude',
    'echo /x/claude',
    'bash',
  ])('leaves %j as it is', (line) => {
    expect(bareCliCommand(line)).toBe(line);
  });
});
