// test/mcp/centralCreate.test.ts — a central requested through POST /api/terminals (`central` in the body)
// becomes a property of its session card, and the relaunches built from that card keep it.
//
// What must hold:
//   - the route mints the central (or re-mints a restored one under its saved id) only when it is about
//     to spawn, and passes the marker to createTerminal and onto the card;
//   - a NEW central (no id) that cannot be a working one is answered 403 / 400 / 409 up front, before
//     anything is minted or spawned; a restore or respawn (it names its central's id) is never refused over
//     its central (Ruling 16): it launches a plain session, the card is kept, and why is logged;
//   - a remote browser (X-Forwarded-For here; a paired phone's profile refuses `central` outright) may bring
//     back only the central of the card it restores, when it can see that card and the card has no live
//     terminal, under that card's kind and scope (Ruling 18); any other id launches a plain session, never a
//     403 (a restore after clear-all finds no card at all, and must not lose its cards);
//   - a deduplicated request mints nothing (it would invalidate a live central's token), a central is
//     never deduplicated onto a plain session, and the ops shell never carries the central;
//   - a terminal that fails to start, or that is left without its card (the ops shell failed), leaves no
//     central behind; a Codex central's startup command is typed with a bare `codex`;
//   - a restart carries the marker to its new PTY; a fork of a central is not a central.
//
// No process or PTY is real: createTerminal and the other PTY calls are stand-ins (createTerminal attaches
// the central as the real one does when it wires a launch), node-pty is the recording fake, process lookups
// are stubbed and process.kill is guarded.
import { homedir } from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { centrals } from '../../server/mcp/centrals.js';
import { phoneLaunchDecision } from '../../server/mobile/phoneProfile.js';
import { config } from '../../server/serverConfig.js';
import { makeMarker } from './centralFixtures.js';
import {
  REMOTE,
  ROOM_ID,
  makeDataDir,
  startApi,
  uuidFor,
  type ApiServer,
} from './centralRouteFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

// db.ts opens better-sqlite3 at module scope; stub it so this suite runs under any Node ABI.
vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const mocks = vi.hoisted(() => ({
  findClaudeProcess: vi.fn(),
  terminateProcessTree: vi.fn(),
  createTerminal: vi.fn(),
  writeWhenReady: vi.fn(),
  writeToTerminal: vi.fn(),
  getTerminals: vi.fn(),
  closeTerminal: vi.fn(),
  closeTerminalAndWait: vi.fn(),
  consumePendingLink: vi.fn(),
  maybeInjectUltracode: vi.fn(),
  getTerminalRelaunchSettings: vi.fn(),
  isTmuxBackedTerminal: vi.fn(),
  injectClaudeCommandsWhenReady: vi.fn(),
  broadcast: vi.fn(),
}));

// NEVER let this file reach a real process: a restart below goes near the kill path.
vi.mock('../../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sessionStore.js')>(
    '../../server/sessionStore.js',
  );
  return { ...actual, findClaudeProcess: mocks.findClaudeProcess };
});
vi.mock('../../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/processMonitor.js')>(
    '../../server/processMonitor.js',
  );
  return { ...actual, terminateProcessTree: mocks.terminateProcessTree };
});
vi.mock('../../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sshManager.js')>(
    '../../server/sshManager.js',
  );
  return {
    ...actual,
    createTerminal: mocks.createTerminal,
    writeWhenReady: mocks.writeWhenReady,
    writeToTerminal: mocks.writeToTerminal,
    getTerminals: mocks.getTerminals,
    closeTerminal: mocks.closeTerminal,
    closeTerminalAndWait: mocks.closeTerminalAndWait,
    consumePendingLink: mocks.consumePendingLink,
    maybeInjectUltracode: mocks.maybeInjectUltracode,
    getTerminalRelaunchSettings: mocks.getTerminalRelaunchSettings,
    isTmuxBackedTerminal: mocks.isTmuxBackedTerminal,
    injectClaudeCommandsWhenReady: mocks.injectClaudeCommandsWhenReady,
  };
});
vi.mock('../../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/wsManager.js')>(
    '../../server/wsManager.js',
  );
  return { ...actual, broadcast: mocks.broadcast };
});

// Second line of defence: any real signal other than the liveness probe fails the test loudly.
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((
  pid: number,
  signal?: string | number,
) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(
    `centralCreate.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`,
  );
}) as typeof process.kill);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let api: ApiServer;
let store: typeof import('../../server/sessionStore.js');
let data: ReturnType<typeof makeDataDir>;
let previousDataDir: string | undefined;

/** Terminals the stand-in getTerminals reports as alive. */
const live = new Set<string>();
let n = 0;
let DIR = '';

beforeAll(async () => {
  data = makeDataDir();
  previousDataDir = process.env.APP_USER_DATA;
  process.env.APP_USER_DATA = data.dir;
  api = await startApi();
  store = await import('../../server/sessionStore.js');
});

afterAll(async () => {
  killGuard.mockRestore();
  await api.close();
  if (previousDataDir === undefined) delete process.env.APP_USER_DATA;
  else process.env.APP_USER_DATA = previousDataDir;
  data.remove();
});

beforeEach(() => {
  n += 1;
  DIR = `/tmp/central-create-${n}`;
  for (const mock of Object.values(mocks)) mock.mockReset();
  let seq = 0;
  // What the real createTerminal does for a wired central: attach it to the new terminal right after spawn.
  mocks.createTerminal.mockImplementation(async (cfg: TerminalConfig) => {
    const terminalId = `term-central-${n}-${++seq}`;
    if (cfg.central && centrals.byId(cfg.central.centralId))
      centrals.attachTerminal(cfg.central.centralId, terminalId);
    return terminalId;
  });
  mocks.getTerminals.mockImplementation(() =>
    [...live].map((terminalId) => ({ terminalId, isOps: false })),
  );
  mocks.writeWhenReady.mockResolvedValue(true);
  mocks.closeTerminalAndWait.mockResolvedValue(true);
  mocks.isTmuxBackedTerminal.mockReturnValue(false);
  mocks.getTerminalRelaunchSettings.mockReturnValue({});
  mocks.findClaudeProcess.mockReturnValue(null);
  mocks.terminateProcessTree.mockResolvedValue(true);
});

afterEach(() => {
  for (const record of centrals.list()) centrals.revoke(record.centralId);
  live.clear();
  delete config.mcp;
});

/** A local launch request; forceNew unless the test is about deduplication. */
const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  api.call(
    'POST',
    '/terminals',
    {
      host: 'localhost',
      workingDir: DIR,
      command: 'claude',
      sessionTitle: `Central ${n}`,
      forceNew: true,
      ...body,
    },
    headers,
  );

const createConfigs = (): TerminalConfig[] =>
  mocks.createTerminal.mock.calls.map(([cfg]) => cfg as TerminalConfig);

describe('POST /api/terminals with a central', () => {
  it('POST /terminals with central mints and passes the marker', async () => {
    const { status, json } = await create({ central: { kind: 'global' } });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const [cfg] = createConfigs();
    expect(cfg.central).toEqual({
      centralId: expect.stringMatching(UUID_RE),
      kind: 'global',
      scopeRef: null,
    });
    expect(centrals.byId(cfg.central!.centralId)).toMatchObject({
      kind: 'global',
      scopeRef: null,
      cli: 'claude',
      terminalId: json.terminalId,
    });
  });

  it('project central defaults scopeRef to the working folder', async () => {
    const { status } = await create({ central: { kind: 'project' }, workingDir: `${DIR}/` });

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toMatchObject({ kind: 'project', scopeRef: DIR });
  });

  it('a new central request for a missing room still answers 400', async () => {
    const missing = await create({ central: { kind: 'room', scopeRef: 'no-such-room' } });
    expect(missing.status).toBe(400);
    expect(missing.json.ok).toBe(false);
    expect(String(missing.json.error)).toMatch(/no-such-room/);
    expect((await create({ central: { kind: 'room' } })).status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('a room central starts for a room that exists', async () => {
    const ok = await create({ central: { kind: 'room', scopeRef: ROOM_ID } });
    expect(ok.status).toBe(200);
    expect(createConfigs()[0].central).toMatchObject({ kind: 'room', scopeRef: ROOM_ID });
  });

  it('a new central request for a taken scope still answers 409', async () => {
    const first = await create({ central: { kind: 'global' } });
    const firstId = createConfigs()[0].central!.centralId;
    const tokenBefore = centrals.byId(firstId)?.token;

    const second = await create({ central: { kind: 'global' }, workingDir: `${DIR}-b` });

    expect(second.status).toBe(409);
    expect(second.json).toEqual({
      ok: false,
      error: `A global central is already running (#${String(first.json.terminalId)})`,
      existing: expect.objectContaining({ centralId: firstId, kind: 'global', scopeRef: null }),
    });
    expect(second.json.existing).not.toHaveProperty('token');
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(centrals.byId(firstId)).toMatchObject({
      token: tokenBefore,
      terminalId: first.json.terminalId,
    });
  });

  it("a remote browser's new central request is still 403", async () => {
    const { status, json } = await create({ central: { kind: 'global' } }, REMOTE);

    expect(status).toBe(403);
    expect(json).toEqual({
      ok: false,
      error: 'A central session can only be started from this Mac',
    });
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('a paired phone cannot ask for a central at all: its launch profile refuses the field', () => {
    const launch = { workingDir: '~/proj', command: 'claude', central: { kind: 'global' } };

    expect(phoneLaunchDecision(launch, [], homedir())).toEqual({
      ok: false,
      reason: 'A phone can’t set central when starting a session',
    });
  });

  it('createTerminalSession copies central onto the session', async () => {
    const { json } = await create({ central: { kind: 'global' } });
    expect(store.getSession(String(json.terminalId))?.central).toEqual(createConfigs()[0].central);

    const marker = makeMarker('5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d');
    const card = await store.createTerminalSession(`term-direct-${n}`, {
      host: 'localhost',
      workingDir: `${DIR}-direct`,
      command: 'claude',
      central: marker,
    });
    expect(card.central).toEqual(marker);
    expect(store.getSession(`term-direct-${n}`)?.central).toEqual(marker);
    expect(store.getSession(`term-direct-${n}`)?.central).not.toBe(marker);
  });

  it('relaunch configs carry the central marker', async () => {
    const { json } = await create({ central: { kind: 'global' } });
    const terminal = String(json.terminalId);
    const marker = createConfigs()[0].central!;
    expect(marker).toMatchObject({ kind: 'global', centralId: expect.stringMatching(UUID_RE) });
    const uuid = uuidFor(n);
    store.handleEvent({
      session_id: uuid,
      hook_event_name: 'SessionStart',
      agent_terminal_id: terminal,
      cwd: DIR,
      tty_path: '/dev/ttys009',
      startup_command: 'claude -n Central',
    } as never);
    expect(store.getSession(uuid)?.central).toEqual(marker);
    live.add(terminal);

    const restart = await api.call('POST', `/sessions/${uuid}/restart-terminal`, { confirm: true });
    expect(restart.status).toBe(200);
    expect(createConfigs()[1].central).toEqual(marker);

    const fork = await api.call('POST', `/sessions/${uuid}/fork`, {});
    expect(fork.status).toBe(200);
    expect(createConfigs()[2].central).toBeUndefined();
    expect(store.getSession(String(fork.json.terminalId))?.central).toBeUndefined();
  });

  it('refuses a launch that is not a bare claude or codex, before anything is spawned', async () => {
    expect(
      (await create({ central: { kind: 'global' }, command: '/usr/local/bin/claude' })).status,
    ).toBe(400);
    const raw = await create({
      central: { kind: 'global' },
      command: '',
      startupCommand: 'npm run dev && claude',
    });
    expect(raw.status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('records codex as the CLI of a codex central', async () => {
    await create({ central: { kind: 'global' }, command: 'codex --yolo' });
    expect(centrals.byId(createConfigs()[0].central!.centralId)?.cli).toBe('codex');
  });

  it('refuses tmux and a remote host, before anything is spawned', async () => {
    expect((await create({ central: { kind: 'global' }, useTmux: true })).status).toBe(400);
    expect((await create({ central: { kind: 'global' }, tmuxSession: 'work' })).status).toBe(400);
    expect(
      (await create({ central: { kind: 'global' }, host: 'build.example.com', username: 'dev' }))
        .status,
    ).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('revokes the central when its terminal fails to start', async () => {
    let mintedAtSpawn: string | undefined;
    mocks.createTerminal.mockImplementationOnce(async (cfg: TerminalConfig) => {
      mintedAtSpawn =
        cfg.central && centrals.byId(cfg.central.centralId) ? cfg.central.centralId : undefined;
      throw new Error('spawn failed');
    });

    const { status } = await create({ central: { kind: 'global' } });

    expect(status).toBe(500);
    expect(mintedAtSpawn).toMatch(UUID_RE);
    expect(centrals.list()).toEqual([]);
  });

  it('never gives the central to the ops shell', async () => {
    const { status } = await create({ central: { kind: 'global' }, enableOpsTerminal: true });
    expect(status).toBe(200);
    const [agent, ops] = createConfigs();
    expect(agent.central).toBeDefined();
    expect(ops.isOps).toBe(true);
    expect(ops.central).toBeUndefined();
  });

  it('never deduplicates a central request onto a plain session in the same folder', async () => {
    const plain = await create({ forceNew: false });
    const central = await create({ forceNew: false, central: { kind: 'global' } });
    expect(central.status).toBe(200);
    expect(central.json.deduplicated).toBeUndefined();
    expect(central.json.terminalId).not.toBe(plain.json.terminalId);
    expect(createConfigs()).toHaveLength(2);
  });

  it('a restore re-mints the central under its saved id and types the resume line', async () => {
    const saved = '3c2b1a09-8f7e-4d6c-9b5a-493827161504';
    const uuid = uuidFor(n);
    const { status, json } = await create({
      forceNew: false,
      originalSessionId: uuid,
      resumeSessionId: uuid,
      central: { centralId: saved, kind: 'global', scopeRef: null },
    });

    expect(status).toBe(200);
    const [cfg] = createConfigs();
    expect(cfg).toMatchObject({
      command: '',
      deferredLaunch: true,
      central: { centralId: saved, kind: 'global', scopeRef: null },
    });
    expect(centrals.byId(saved)?.terminalId).toBe(json.terminalId);
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(
      json.terminalId,
      expect.stringContaining(`--resume '${uuid}'`),
    );
  });

  describe('a restore or respawn whose central cannot be established again (Ruling 16)', () => {
    /** What was logged under this restore's session id: the reason, never a token. */
    const warnedAbout = (id: string): string =>
      log.warn.mock.calls
        .map((call) => call.join(' '))
        .filter((line) => line.includes(id))
        .join('\n');

    /** A workspace restore of the card `uuid`, carrying the central its snapshot saved. */
    const restore = (
      uuid: string,
      central: Record<string, unknown>,
      over: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) =>
      create(
        { forceNew: false, originalSessionId: uuid, resumeSessionId: uuid, central, ...over },
        headers,
      );

    it('restore with a missing room launches a plain session and keeps the card', async () => {
      const uuid = uuidFor(n);
      const saved = '6e5d4c3b-2a19-4087-a6b5-c4d3e2f1a0b9';

      const { status, json } = await restore(uuid, {
        centralId: saved,
        kind: 'room',
        scopeRef: 'room-gone',
      });

      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(createConfigs()).toHaveLength(1);
      expect(createConfigs()[0].central).toBeUndefined();
      const card = store.getSession(String(json.terminalId));
      expect(card).not.toBeNull();
      expect(card?.central).toBeUndefined();
      expect(centrals.list()).toEqual([]);
      expect(mocks.writeWhenReady).toHaveBeenCalledWith(
        json.terminalId,
        expect.stringContaining(`--resume '${uuid}'`),
      );
      expect(warnedAbout(uuid)).toContain('Room "room-gone" does not exist');
      expect(warnedAbout(uuid)).toContain(saved);
    });

    it('restore when another central holds the scope launches plain', async () => {
      const first = await create({ central: { kind: 'global' } });
      const holder = createConfigs()[0].central!;
      const tokenBefore = centrals.byId(holder.centralId)?.token;
      const uuid = uuidFor(n);
      const saved = '7f6e5d4c-3b2a-4198-b7c6-d5e4f3a2b1c0';

      const { status, json } = await restore(
        uuid,
        { centralId: saved, kind: 'global', scopeRef: null },
        { workingDir: `${DIR}-b` },
      );

      expect(status).toBe(200);
      expect(json.terminalId).not.toBe(first.json.terminalId);
      expect(createConfigs()[1].central).toBeUndefined();
      expect(store.getSession(String(json.terminalId))?.central).toBeUndefined();
      expect(centrals.list().map((r) => r.centralId)).toEqual([holder.centralId]);
      expect(centrals.byId(holder.centralId)).toMatchObject({
        token: tokenBefore,
        terminalId: first.json.terminalId,
      });
      expect(warnedAbout(uuid)).toContain('A global central is already running');
      expect(warnedAbout(uuid)).not.toContain(String(tokenBefore));
    });
  });

  describe('a remote browser bringing a central back (Rulings 16 and 18)', () => {
    /** What was logged about the session a restore names: the reason, never a token. */
    const warnedAbout = (id: string): string =>
      log.warn.mock.calls
        .map((call) => call.join(' '))
        .filter((line) => line.includes(id))
        .join('\n');

    it('a remote restore whose centralId no card carries launches plain', async () => {
      // What a remote browser's workspace restore sends after its clear-all: no card is left to carry it.
      const uuid = uuidFor(n);
      const saved = '8a7b6c5d-4e3f-4a29-b1c0-d9e8f7a6b5c4';

      const { status, json } = await create(
        {
          forceNew: false,
          originalSessionId: uuid,
          resumeSessionId: uuid,
          central: { centralId: saved, kind: 'global', scopeRef: null },
        },
        REMOTE,
      );

      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(createConfigs()).toHaveLength(1);
      expect(createConfigs()[0].central).toBeUndefined();
      const card = store.getSession(String(json.terminalId));
      expect(card).not.toBeNull();
      expect(card?.central).toBeUndefined();
      expect(centrals.list()).toEqual([]);
      expect(warnedAbout(uuid)).toContain(saved);
      expect(warnedAbout(uuid)).toContain('no card this device restores and can see carries it');
    });

    it("brings back the central of the card it restores, whose terminal is gone, under that card's kind and scope", async () => {
      const shared = await create({ central: { kind: 'project' }, remoteVisible: true });
      const marker = createConfigs()[0].central!;
      const tokenBefore = centrals.byId(marker.centralId)?.token;

      // Its terminal is not live (the stand-in reports only `live`); the body claims a wider central.
      const { status, json } = await create(
        {
          workingDir: `${DIR}-remote`,
          originalSessionId: String(shared.json.terminalId),
          central: { centralId: marker.centralId, kind: 'global', scopeRef: null },
        },
        REMOTE,
      );

      expect(status).toBe(200);
      expect(marker).toMatchObject({ kind: 'project', scopeRef: DIR });
      expect(createConfigs()[1].central).toEqual(marker);
      expect(store.getSession(String(json.terminalId))?.central).toEqual(marker);
      expect(centrals.byId(marker.centralId)).toMatchObject({
        kind: 'project',
        scopeRef: DIR,
        terminalId: json.terminalId,
      });
      expect(centrals.byId(marker.centralId)?.token).not.toBe(tokenBefore);
    });

    it('naming a live central, a hidden one or another card’s: a plain session, and the central left be', async () => {
      const liveCard = await create({ central: { kind: 'global' }, remoteVisible: true });
      const liveCentral = createConfigs()[0].central!;
      live.add(String(liveCard.json.terminalId));
      const hiddenCard = await create({ central: { kind: 'project' }, workingDir: `${DIR}-h` });
      const hiddenCentral = createConfigs()[1].central!;
      const plainCard = await create({ remoteVisible: true, workingDir: `${DIR}-p` });
      const tokens = centrals.list().map((r) => r.token);

      const remote = (originalSessionId: unknown, central: unknown, folder: string) =>
        create({ originalSessionId, central, workingDir: `${DIR}-${folder}` }, REMOTE);
      const answers = [
        // Its own card, but still live: taking it would end that agent's token.
        await remote(liveCard.json.terminalId, liveCentral, 'r1'),
        // A card this device cannot see.
        await remote(hiddenCard.json.terminalId, hiddenCentral, 'r2'),
        // A card it can see, that is not the one carrying the central.
        await remote(plainCard.json.terminalId, liveCentral, 'r3'),
      ];

      expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
      expect(
        createConfigs()
          .slice(3)
          .map((cfg) => cfg.central),
      ).toEqual([undefined, undefined, undefined]);
      expect(centrals.list().map((r) => r.token)).toEqual(tokens);
      expect(centrals.byId(liveCentral.centralId)?.terminalId).toBe(liveCard.json.terminalId);
    });

    it('naming the central of its card while that card is live, even unwired: a plain session, nothing minted', async () => {
      const liveCard = await create({ central: { kind: 'global' }, remoteVisible: true });
      const marker = createConfigs()[0].central!;
      live.add(String(liveCard.json.terminalId));
      // Its terminal came up without the wiring (no port yet), so no record holds the central.
      centrals.revoke(marker.centralId);

      const { status } = await create(
        { originalSessionId: liveCard.json.terminalId, central: marker, workingDir: `${DIR}-r` },
        REMOTE,
      );

      expect(status).toBe(200);
      expect(createConfigs()[1].central).toBeUndefined();
      expect(centrals.list()).toEqual([]);
      expect(store.getSession(String(liveCard.json.terminalId))?.central).toEqual(marker);
    });
  });

  it('a central whose ops shell fails to open closes its own terminal and revokes it', async () => {
    mocks.createTerminal.mockImplementationOnce(async (cfg: TerminalConfig) => {
      centrals.attachTerminal(cfg.central!.centralId, 'term-orphan');
      return 'term-orphan';
    });
    mocks.createTerminal.mockRejectedValueOnce(new Error('ops shell failed'));

    const { status } = await create({ central: { kind: 'global' }, enableOpsTerminal: true });

    expect(status).toBe(500);
    expect(createConfigs()).toHaveLength(2);
    expect(mocks.closeTerminal).toHaveBeenCalledWith('term-orphan');
    expect(centrals.list()).toEqual([]);
    expect(store.getSession('term-orphan')).toBeNull();
  });

  it("types a Codex central's startup command, stored as its native binary's path, as a bare codex", async () => {
    const native =
      '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex';
    const saved = '5c4b3a29-1807-4f6e-9d5c-4b3a29180716';

    const { status, json } = await create({
      command: '',
      startupCommand: `${native} --yolo`,
      central: { centralId: saved, kind: 'global', scopeRef: null },
    });

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toEqual({
      centralId: saved,
      kind: 'global',
      scopeRef: null,
    });
    expect(centrals.byId(saved)).toMatchObject({ cli: 'codex', terminalId: json.terminalId });
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(
      json.terminalId,
      expect.stringMatching(/^codex --yolo/),
    );
  });

  it('a request deduplicated onto the live central mints nothing, so its token stays valid', async () => {
    const first = await create({ central: { kind: 'global' } });
    const marker = createConfigs()[0].central!;
    const tokenBefore = centrals.byId(marker.centralId)?.token;

    const again = await create({
      forceNew: false,
      originalSessionId: first.json.terminalId,
      central: marker,
    });

    expect(again.json).toMatchObject({
      ok: true,
      deduplicated: true,
      terminalId: first.json.terminalId,
    });
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
    expect(centrals.byId(marker.centralId)?.token).toBe(tokenBefore);
  });

  it('never makes a fork or a floating popup a central', async () => {
    const fork = await create({
      isFork: true,
      originSessionId: 'origin-x',
      central: { kind: 'global' },
    });
    const float = await create({
      isFloating: true,
      isFork: true,
      originSessionId: 'origin-x',
      central: { kind: 'global' },
      workingDir: `${DIR}-f`,
    });
    expect([fork.status, float.status]).toEqual([200, 200]);
    expect(createConfigs().map((cfg) => cfg.central)).toEqual([undefined, undefined]);
    expect(store.getSession(String(fork.json.terminalId))?.central).toBeUndefined();
    expect(centrals.list()).toEqual([]);
  });

  it('with central sessions switched off: refuses a new central, restores a known one without a token', async () => {
    config.mcp = { enabled: false };
    expect((await create({ central: { kind: 'global' } })).status).toBe(400);
    expect(mocks.createTerminal).not.toHaveBeenCalled();

    const saved = '9e8d7c6b-5a49-4382-a716-05f4e3d2c1b0';
    const { status, json } = await create({
      central: { centralId: saved, kind: 'global', scopeRef: null },
    });
    expect(status).toBe(200);
    expect(createConfigs()[0].central).toEqual({
      centralId: saved,
      kind: 'global',
      scopeRef: null,
    });
    expect(store.getSession(String(json.terminalId))?.central).toEqual({
      centralId: saved,
      kind: 'global',
      scopeRef: null,
    });
    expect(centrals.list()).toEqual([]);
  });
});
