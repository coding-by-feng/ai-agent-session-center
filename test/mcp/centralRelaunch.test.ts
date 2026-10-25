// test/mcp/centralRelaunch.test.ts — every relaunch of a central's card that spawns a new PTY gives that
// PTY the central again, with a fresh token under the same id; a relaunch into the still-open shell keeps
// the token that shell already holds; forks and clones are never centrals.
//
// What must hold, per route:
//   - a relaunch is never refused over its central (Ruling 16): when the central cannot be established
//     again (its room is gone, another central holds its scope, it is live in another card's terminal),
//     the card is relaunched as a plain session and its marker is cleared; where the caller is does not
//     count (Ruling 18);
//   - restart (POST /sessions/:id/restart-terminal): re-minted AFTER its own refusals and BEFORE the new PTY
//     spawns (at spawn time the record already has the new token and no terminal), passed to createTerminal;
//     a paired phone's restart keeps a central a central (Ruling 18); a failed spawn leaves no central, and
//     says the session's central MCP access was reset;
//   - resume (POST /sessions/:id/resume): with the old terminal gone, the same as restart; with it still
//     open, nothing is minted and the line goes through writeWhenReady (which puts a central's flags on it),
//     while a card that is no central is still typed raw, as before;
//   - reconnect (POST /sessions/:id/reconnect-terminal): re-minted and passed; a Codex central whose stored
//     command is the native binary's path is typed as a bare `codex`, so its flags can be put on it;
//   - fork and clone: never a central, and the central they were made from is left untouched.
//
// No process or PTY is real (see centralCreate.test.ts for the stand-ins).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import type { CentralRecord } from '../../server/mcp/types.js';
import { centrals } from '../../server/mcp/centrals.js';
import {
  REMOTE,
  ROOM_ID,
  makeDataDir,
  startApi,
  uuidFor,
  type ApiServer,
} from './centralRouteFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

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

// NEVER let this file reach a real process: restart stops the agent in the old terminal.
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

const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((
  pid: number,
  signal?: string | number,
) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(
    `centralRelaunch.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`,
  );
}) as typeof process.kill);

let api: ApiServer;
let store: typeof import('../../server/sessionStore.js');
let data: ReturnType<typeof makeDataDir>;
let previousDataDir: string | undefined;

const live = new Set<string>();
let n = 0;
let DIR = '';
let UUID = '';
/** The record each createTerminal call found when it ran: what the central looked like at spawn time. */
let atSpawn: Array<CentralRecord | null> = [];

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
  DIR = `/tmp/central-relaunch-${n}`;
  UUID = uuidFor(1000 + n);
  atSpawn = [];
  for (const mock of Object.values(mocks)) mock.mockReset();
  let seq = 0;
  mocks.createTerminal.mockImplementation(async (cfg: TerminalConfig) => {
    const terminalId = `term-relaunch-${n}-${++seq}`;
    atSpawn.push(cfg.central ? centrals.byId(cfg.central.centralId) : null);
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
});

const createConfigs = (): TerminalConfig[] =>
  mocks.createTerminal.mock.calls.map(([cfg]) => cfg as TerminalConfig);

/** What was logged about this test's card (its id is UUID): the reason it went plain, never a token. */
const warnedAboutCard = (): string =>
  log.warn.mock.calls
    .map((call) => call.join(' '))
    .filter((line) => line.includes(UUID))
    .join('\n');

/** The room list the data folder starts with; a test that deletes the room puts it back. */
const ROOMS = { rooms: [{ id: ROOM_ID, name: 'Ops', sessionIds: [] }] };

/**
 * A running central the way the app builds one: POST /terminals with `central`, then the CLI's
 * SessionStart re-keys the term-* card onto its own id. Its terminal is alive.
 */
async function liveCentral(
  opts: {
    command?: string;
    startupCommand?: string;
    remoteVisible?: boolean;
    central?: { kind: 'global' | 'room' | 'project'; scopeRef?: string };
  } = {},
) {
  const central = opts.central ?? { kind: 'global' };
  const { json } = await api.call('POST', '/terminals', {
    host: 'localhost',
    workingDir: DIR,
    command: opts.command ?? 'claude',
    sessionTitle: `Central ${n}`,
    forceNew: true,
    central,
    ...(opts.remoteVisible ? { remoteVisible: true } : {}),
  });
  const terminal = String(json.terminalId);
  store.handleEvent({
    session_id: UUID,
    hook_event_name: 'SessionStart',
    agent_terminal_id: terminal,
    cwd: DIR,
    tty_path: '/dev/ttys009',
    startup_command: opts.startupCommand ?? 'claude -n Central',
    ...(opts.command?.startsWith('codex') ? { cli_source: 'codex' } : {}),
  } as never);
  live.add(terminal);
  const card = store.getSession(UUID);
  expect(card?.terminalId).toBe(terminal);
  const marker = card!.central!;
  expect(marker.kind).toBe(central.kind);
  const record = centrals.byId(marker.centralId)!;
  expect(record.terminalId).toBe(terminal);
  mocks.createTerminal.mockClear();
  atSpawn = [];
  return { terminal, marker, record };
}

describe('restart', () => {
  it('re-mints the central before the new PTY spawns, and gives it to that PTY', async () => {
    const { terminal, marker, record } = await liveCentral();

    const { status, json } = await api.call('POST', `/sessions/${UUID}/restart-terminal`, {
      confirm: true,
    });

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toEqual(marker);
    // Re-minted before spawning: the record the spawn saw already had a new token and no terminal.
    expect(atSpawn[0]).toMatchObject({ centralId: marker.centralId, terminalId: null });
    expect(atSpawn[0]?.token).not.toBe(record.token);
    const after = centrals.byId(marker.centralId);
    expect(after?.terminalId).toBe(json.terminalId);
    expect(after?.createdAt).toBe(record.createdAt);
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith(terminal);
    expect(store.getSession(UUID)?.central).toEqual(marker);
  });

  it('a restart refused for its own reasons leaves the central and its token alone', async () => {
    const { terminal, marker, record } = await liveCentral();
    mocks.isTmuxBackedTerminal.mockReturnValue(true);

    const { status } = await api.call('POST', `/sessions/${UUID}/restart-terminal`, {
      confirm: true,
    });

    expect(status).toBe(409);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.byId(marker.centralId)).toMatchObject({
      token: record.token,
      terminalId: terminal,
    });
  });

  it('restart of a central whose room was deleted relaunches plain and clears the marker', async () => {
    const { terminal } = await liveCentral({ central: { kind: 'room', scopeRef: ROOM_ID } });
    // The room goes the way the workspace writer deletes one: the Mac's room list without it.
    expect((await api.call('PUT', '/rooms', { rooms: [] })).status).toBe(200);
    try {
      const { status, json } = await api.call('POST', `/sessions/${UUID}/restart-terminal`, {
        confirm: true,
      });

      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      expect(createConfigs()).toHaveLength(1);
      expect(createConfigs()[0].central).toBeUndefined();
      expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith(terminal);
      const card = store.getSession(UUID);
      expect(card?.terminalId).toBe(json.terminalId);
      expect(card?.central).toBeUndefined();
      expect(mocks.writeWhenReady).toHaveBeenCalledWith(
        json.terminalId,
        expect.stringContaining(`--resume '${UUID}'`),
      );
      expect(warnedAboutCard()).toContain(`Room "${ROOM_ID}" does not exist`);
    } finally {
      await api.call('PUT', '/rooms', ROOMS);
    }
  });

  it('a phone restart of a central keeps it central', async () => {
    const { terminal, marker, record } = await liveCentral({ remoteVisible: true });

    const { status, json } = await api.call(
      'POST',
      `/sessions/${UUID}/restart-terminal`,
      { confirm: true },
      REMOTE,
    );

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // Re-minted on the Mac for the new PTY, exactly as for a restart from the Mac (Ruling 18).
    expect(createConfigs()[0].central).toEqual(marker);
    expect(atSpawn[0]).toMatchObject({ centralId: marker.centralId, terminalId: null });
    expect(atSpawn[0]?.token).not.toBe(record.token);
    expect(centrals.byId(marker.centralId)?.terminalId).toBe(json.terminalId);
    expect(store.getSession(UUID)?.central).toEqual(marker);
    expect(mocks.closeTerminalAndWait).toHaveBeenCalledWith(terminal);
    // The token goes into the new PTY's environment only: nothing in the answer, nothing logged.
    expect(JSON.stringify(json)).not.toContain(String(atSpawn[0]?.token));
    expect(warnedAboutCard()).toBe('');
  });

  it('revokes the re-minted central when the new terminal fails to open, and says its MCP access was reset', async () => {
    const { marker } = await liveCentral();
    mocks.createTerminal.mockRejectedValueOnce(new Error('spawn failed'));

    const { status, json } = await api.call('POST', `/sessions/${UUID}/restart-terminal`, {
      confirm: true,
    });

    expect(status).toBe(500);
    expect(centrals.byId(marker.centralId)).toBeNull();
    expect(mocks.closeTerminalAndWait).not.toHaveBeenCalled();
    // Its token was minted again before the spawn: the running session was not "left untouched".
    expect(json.error).toBe(
      'Could not restart the session: the new terminal failed to open, and the running session was left running; its central MCP access was reset, and a restart or resume restores it',
    );
    expect(store.getSession(UUID)?.central).toEqual(marker);
  });
});

describe('resume', () => {
  it('with the old terminal gone: re-mints and gives the central to the new PTY', async () => {
    const { terminal, marker, record } = await liveCentral();
    live.delete(terminal);

    const { status, json } = await api.call('POST', `/sessions/${UUID}/resume`, {});

    expect(status).toBe(200);
    expect(json.newTerminal).toBe(true);
    expect(createConfigs()[0].central).toEqual(marker);
    expect(atSpawn[0]?.token).not.toBe(record.token);
    expect(centrals.byId(marker.centralId)?.terminalId).toBe(json.terminalId);
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(
      json.terminalId,
      expect.stringContaining(`--resume '${UUID}'`),
    );
  });

  it('with the old terminal gone and its room deleted: resumes plain and clears the marker', async () => {
    const { terminal } = await liveCentral({ central: { kind: 'room', scopeRef: ROOM_ID } });
    live.delete(terminal);
    expect((await api.call('PUT', '/rooms', { rooms: [] })).status).toBe(200);
    try {
      const { status, json } = await api.call('POST', `/sessions/${UUID}/resume`, {});

      expect(status).toBe(200);
      expect(json.newTerminal).toBe(true);
      expect(createConfigs()[0].central).toBeUndefined();
      expect(store.getSession(UUID)).toMatchObject({ terminalId: json.terminalId });
      expect(store.getSession(UUID)?.central).toBeUndefined();
      expect(warnedAboutCard()).toContain(`Room "${ROOM_ID}" does not exist`);
    } finally {
      await api.call('PUT', '/rooms', ROOMS);
    }
  });

  it('with the old terminal still open: no new token, and the line goes through writeWhenReady', async () => {
    await liveCentral();
    // A reconnect is what leaves a card with a lastTerminalId; this one stays open.
    const reconnect = await api.call('POST', `/sessions/${UUID}/reconnect-terminal`, {});
    const open = String(reconnect.json.terminalId);
    live.add(open);
    const marker = store.getSession(UUID)!.central!;
    const tokenBefore = centrals.byId(marker.centralId)?.token;
    mocks.createTerminal.mockClear();
    mocks.writeWhenReady.mockClear();

    store.handleEvent({ session_id: UUID, hook_event_name: 'SessionEnd' } as never);
    const { status, json } = await api.call('POST', `/sessions/${UUID}/resume`, {});

    expect(status).toBe(200);
    expect(json.terminalId).toBe(open);
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(mocks.writeToTerminal).not.toHaveBeenCalled();
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(
      open,
      expect.stringContaining(`--resume '${UUID}'`),
    );
    expect(centrals.byId(marker.centralId)).toMatchObject({ token: tokenBefore, terminalId: open });
  });

  it('a card that is no central is still typed raw into its open terminal, as before', async () => {
    const created = await api.call('POST', '/terminals', {
      host: 'localhost',
      workingDir: DIR,
      command: 'claude',
      sessionTitle: `Plain ${n}`,
      forceNew: true,
    });
    store.handleEvent({
      session_id: UUID,
      hook_event_name: 'SessionStart',
      agent_terminal_id: String(created.json.terminalId),
      cwd: DIR,
      tty_path: '/dev/ttys009',
      startup_command: 'claude -n Plain',
    } as never);
    const reconnect = await api.call('POST', `/sessions/${UUID}/reconnect-terminal`, {});
    const open = String(reconnect.json.terminalId);
    live.add(open);
    mocks.writeWhenReady.mockClear();

    store.handleEvent({ session_id: UUID, hook_event_name: 'SessionEnd' } as never);
    const { status } = await api.call('POST', `/sessions/${UUID}/resume`, {});

    expect(status).toBe(200);
    expect(mocks.writeToTerminal).toHaveBeenCalledWith(
      open,
      expect.stringContaining(`--resume '${UUID}'`),
    );
    expect(mocks.writeWhenReady).not.toHaveBeenCalled();
  });
});

describe('reconnect-terminal', () => {
  it('re-mints and gives the central to the new PTY', async () => {
    const { terminal, marker, record } = await liveCentral();
    live.delete(terminal);

    const { status, json } = await api.call('POST', `/sessions/${UUID}/reconnect-terminal`, {});

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toEqual(marker);
    expect(atSpawn[0]?.token).not.toBe(record.token);
    expect(centrals.byId(marker.centralId)?.terminalId).toBe(json.terminalId);
    // The stored `-n Central` is rebuilt, quoted, from the card's title (Ruling P3-36).
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(json.terminalId, `claude -n "Central ${n}"\r`);
  });

  it("types a Codex central's stored native-binary path as a bare codex, so its flags can go on it", async () => {
    const native =
      '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex';
    const { terminal, marker } = await liveCentral({
      command: 'codex',
      startupCommand: `${native} --yolo`,
    });
    live.delete(terminal);

    const { status, json } = await api.call('POST', `/sessions/${UUID}/reconnect-terminal`, {});

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toEqual(marker);
    expect(mocks.writeWhenReady).toHaveBeenCalledWith(json.terminalId, 'codex --yolo\r');
  });

  it('when another central has taken its scope meanwhile: reconnects plain and clears the marker', async () => {
    const { terminal, marker } = await liveCentral();
    // Its terminal died (the lifecycle revoked its central), and another global central started.
    live.delete(terminal);
    centrals.revoke(marker.centralId);
    const holder = centrals.mint({
      kind: 'global',
      scopeRef: null,
      cli: 'claude',
      permissionMode: null,
    });

    const { status, json } = await api.call('POST', `/sessions/${UUID}/reconnect-terminal`, {});

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(createConfigs()[0].central).toBeUndefined();
    expect(store.getSession(UUID)).toMatchObject({ terminalId: json.terminalId });
    expect(store.getSession(UUID)?.central).toBeUndefined();
    expect(centrals.list().map((r) => r.centralId)).toEqual([holder.centralId]);
    expect(centrals.byId(holder.centralId)?.token).toBe(holder.token);
    expect(warnedAboutCard()).toContain('A global central is already running');
    expect(warnedAboutCard()).not.toContain(holder.token);
  });

  it('two cards, one central: reconnecting the other card leaves the live one its token', async () => {
    const { terminal, marker, record } = await liveCentral();
    // A second card that carries the same marker, its own terminal gone.
    await store.createTerminalSession('term-second', {
      host: 'localhost',
      workingDir: `${DIR}-second`,
      command: 'claude',
      central: marker,
    });

    const { status, json } = await api.call('POST', '/sessions/term-second/reconnect-terminal', {});

    expect(status).toBe(200);
    expect(createConfigs()[0].central).toBeUndefined();
    expect(store.getSession('term-second')).toMatchObject({ terminalId: json.terminalId });
    expect(store.getSession('term-second')?.central).toBeUndefined();
    // The live card is untouched: same token, same terminal, still the central.
    expect(centrals.byId(marker.centralId)).toMatchObject({
      token: record.token,
      terminalId: terminal,
    });
    expect(store.getSession(UUID)?.central).toEqual(marker);
    expect(JSON.stringify(log.warn.mock.calls)).toContain(
      `live in another session's terminal (${terminal})`,
    );
  });
});

describe('fork and clone', () => {
  it.each(['fork', 'clone'])(
    'a %s of a central is no central, and the central is left as it was',
    async (route) => {
      const { terminal, marker, record } = await liveCentral();

      const { status, json } = await api.call('POST', `/sessions/${UUID}/${route}`, {});

      expect(status).toBe(200);
      expect(createConfigs()[0].central).toBeUndefined();
      expect(store.getSession(String(json.terminalId))?.central).toBeUndefined();
      expect(centrals.byId(marker.centralId)).toMatchObject({
        token: record.token,
        terminalId: terminal,
      });
      expect(centrals.list()).toHaveLength(1);
    },
  );
});
