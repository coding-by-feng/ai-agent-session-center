// test/mcp/handsOffCreate.test.ts — hands-off through a workspace restore: the restore POSTs /api/terminals once
// per saved session, and a session that was hands-off carries `handsOff: true` in that body (as `muted` does), so
// the new card has the flag from its first broadcast. The route accepts only a boolean, and passes only `true`
// on to the terminal's config: absent already means a central may steer the session.
//
// No process or PTY is real: createTerminal and the other PTY calls are stand-ins, node-pty is the recording
// fake, process lookups are stubbed and process.kill is guarded (known-issues.md: a test must never reach a
// real process).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
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

// NEVER let this file reach a real process.
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
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`handsOffCreate.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
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
  mocks.createTerminal.mockImplementation(async () => `term-handsoff-create-${n}`);
  mocks.getTerminals.mockReturnValue([]);
  mocks.writeWhenReady.mockResolvedValue(true);
  mocks.closeTerminalAndWait.mockResolvedValue(true);
  mocks.isTmuxBackedTerminal.mockReturnValue(false);
  mocks.getTerminalRelaunchSettings.mockReturnValue({});
  mocks.findClaudeProcess.mockReturnValue(null);
  mocks.terminateProcessTree.mockResolvedValue(true);
});

/** A local launch request, always a new session (no deduplication). */
const create = (body: Record<string, unknown>) =>
  api.call('POST', '/terminals', {
    host: 'localhost',
    workingDir: `/tmp/handsoff-create-${n}`,
    command: 'claude',
    sessionTitle: `Restored ${n}`,
    forceNew: true,
    ...body,
  });

const configs = (): TerminalConfig[] => mocks.createTerminal.mock.calls.map(([cfg]) => cfg as TerminalConfig);

describe('POST /api/terminals with handsOff (a workspace restore)', () => {
  it('passes the flag to the terminal’s config, so the new card has it from its first broadcast', async () => {
    const { status, json } = await create({ handsOff: true });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(configs()).toHaveLength(1);
    expect(configs()[0].handsOff).toBe(true);
  });

  it('leaves it out of the config when the body has none', async () => {
    await create({});

    expect(configs()[0]).not.toHaveProperty('handsOff');
  });

  it('leaves it out for false too: absent already means a central may steer the session', async () => {
    await create({ handsOff: false });

    expect(configs()[0]).not.toHaveProperty('handsOff');
  });

  it('refuses a flag that is not a boolean, and starts nothing', async () => {
    for (const bad of ['yes', 1, null, {}, []]) {
      const { status } = await create({ handsOff: bad });
      expect(status, JSON.stringify(bad)).toBe(400);
    }
    expect(mocks.createTerminal).not.toHaveBeenCalled();
  });

  it('sits beside muted and pinned: the same body carries all of them', async () => {
    await create({ handsOff: true, muted: true, pinned: true });

    expect(configs()[0]).toMatchObject({ handsOff: true, muted: true, pinned: true });
  });
});
