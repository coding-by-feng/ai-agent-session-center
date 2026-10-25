// test/mcp/terminalsCentralGuard.test.ts — a central never starts another central (Ruling P4-8): POST /api/terminals
// refuses `central` in the body from a central's own calls (`x-aasc-client-id: mcp:…`) with 403 CENTRAL_FROM_CENTRAL,
// before anything is minted or spawned. The desktop's central request, and a central's plain session (its own
// worker, openWorker.ts), are unchanged.
//
// No process or PTY is real: createTerminal and the other PTY calls are stand-ins, node-pty is the recording fake,
// process lookups are stubbed and process.kill is guarded.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { centrals } from '../../server/mcp/centrals.js';
import { config } from '../../server/serverConfig.js';
import { makeDataDir, startApi, type ApiServer } from './centralRouteFixtures.js';

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
    `terminalsCentralGuard.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`,
  );
}) as typeof process.kill);

let api: ApiServer;
let data: ReturnType<typeof makeDataDir>;
let previousDataDir: string | undefined;
let n = 0;

beforeAll(async () => {
  data = makeDataDir();
  previousDataDir = process.env.APP_USER_DATA;
  process.env.APP_USER_DATA = data.dir;
  api = await startApi();
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
  for (const mock of Object.values(mocks)) mock.mockReset();
  let seq = 0;
  // What the real createTerminal does for a wired central: attach it to the new terminal right after spawn.
  mocks.createTerminal.mockImplementation(async (cfg: TerminalConfig) => {
    const terminalId = `term-guard-${n}-${++seq}`;
    if (cfg.central && centrals.byId(cfg.central.centralId)) centrals.attachTerminal(cfg.central.centralId, terminalId);
    return terminalId;
  });
  mocks.getTerminals.mockReturnValue([]);
  mocks.writeWhenReady.mockResolvedValue(true);
  mocks.closeTerminalAndWait.mockResolvedValue(true);
  mocks.isTmuxBackedTerminal.mockReturnValue(false);
  mocks.getTerminalRelaunchSettings.mockReturnValue({});
  mocks.findClaudeProcess.mockReturnValue(null);
  mocks.terminateProcessTree.mockResolvedValue(true);
});

afterEach(() => {
  for (const record of centrals.list()) centrals.revoke(record.centralId);
  delete config.mcp;
});

const create = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  api.call(
    'POST',
    '/terminals',
    {
      host: 'localhost',
      workingDir: `/tmp/central-guard-${n}`,
      command: 'claude',
      sessionTitle: `Guard ${n}`,
      forceNew: true,
      ...body,
    },
    headers,
  );

const FROM_CENTRAL = { 'x-aasc-client-id': 'mcp:central-g' };

describe('POST /api/terminals from a central', () => {
  it('POST /terminals refuses central from an mcp: caller', async () => {
    for (const central of [{ kind: 'global' }, { kind: 'project' }, { kind: 'room', scopeRef: 'r1' }, null, 'x']) {
      const { status, json } = await create({ central }, FROM_CENTRAL);
      expect(status, JSON.stringify(central)).toBe(403);
      expect(json).toEqual({
        ok: false,
        code: 'CENTRAL_FROM_CENTRAL',
        error: 'A central session cannot start another central.',
      });
    }
    expect(mocks.createTerminal).not.toHaveBeenCalled();
    expect(centrals.list()).toEqual([]);
  });

  it('an mcp: caller’s plain session is not refused', async () => {
    const { status, json } = await create({}, FROM_CENTRAL);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("a desktop caller's central request is unchanged", async () => {
    const { status, json } = await create({ central: { kind: 'global' } }, { 'x-aasc-client-id': 'desktop-1' });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const [[cfg]] = mocks.createTerminal.mock.calls as [[TerminalConfig]];
    expect(cfg.central).toMatchObject({ kind: 'global', scopeRef: null });
    expect(centrals.list()).toHaveLength(1);
  });
});
