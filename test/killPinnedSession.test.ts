// test/killPinnedSession.test.ts — POST /api/sessions/:id/kill on a pinned session: a kill must unpin it
// BEFORE anything is terminated (an ENDED broadcast can land mid-kill, e.g. the CLI's SessionEnd hook, and
// every client's pinnedRespawn relaunches a session that still says pinned:true). A kill that fails (the process
// survives SIGKILL) leaves it unpinned too: a stuck process reaped later must not bring back what the user killed.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

// db.ts opens better-sqlite3 at module scope; stub it so this suite runs under any Node ABI.
vi.mock('../server/db.js', () => ({
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

const mocks = vi.hoisted(() => ({
  findClaudeProcess: vi.fn(),
  terminateProcessTree: vi.fn(),
  closeTerminal: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sessionStore.js')>('../server/sessionStore.js');
  return { ...actual, findClaudeProcess: mocks.findClaudeProcess };
});
vi.mock('../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../server/processMonitor.js')>('../server/processMonitor.js');
  return { ...actual, terminateProcessTree: mocks.terminateProcessTree };
});
vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, closeTerminal: mocks.closeTerminal };
});
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((resolveStart) => server!.listen(0, '127.0.0.1', resolveStart));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

async function unpinnedSession(id: string): Promise<void> {
  await store.createTerminalSession(id, { host: 'localhost', workingDir: '/tmp/kill-pinned-test', command: 'claude' });
}

async function pinnedSession(id: string): Promise<void> {
  await unpinnedSession(id);
  store.setSessionPinned(id, true);
  expect(store.getSession(id)?.pinned).toBe(true);
}

async function kill(id: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/sessions/${id}/kill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function endedBroadcastsFor(id: string): Array<{ session: { pinned?: boolean; status: string } }> {
  return mocks.broadcast.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg?.type === 'session_update' && msg.session?.sessionId === id && msg.session.status === 'ended');
}

describe('POST /api/sessions/:id/kill — pinned sessions', () => {
  it('unpins a killed session before broadcasting it ENDED, so no client respawns it', async () => {
    await pinnedSession('kill-pinned-ok');
    mocks.findClaudeProcess.mockReturnValue(4242);
    mocks.terminateProcessTree.mockResolvedValue(true);

    const { status, json } = await kill('kill-pinned-ok');

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const ended = endedBroadcastsFor('kill-pinned-ok');
    expect(ended).toHaveLength(1);
    expect(ended[0].session.pinned).toBe(false);
    expect(store.getSession('kill-pinned-ok')?.pinned).toBe(false);
  });

  it('clears the pin before termination starts, so an ENDED that lands mid-kill is not respawned', async () => {
    await pinnedSession('kill-pinned-midkill');
    mocks.findClaudeProcess.mockReturnValue(4444);
    let pinnedWhenTerminationStarted: boolean | undefined;
    mocks.terminateProcessTree.mockImplementation(async () => {
      pinnedWhenTerminationStarted = store.getSession('kill-pinned-midkill')?.pinned;
      return true;
    });

    const { status } = await kill('kill-pinned-midkill');

    expect(status).toBe(200);
    expect(pinnedWhenTerminationStarted).toBe(false);
  });

  it('a SessionEnd hook that arrives while the process is still being terminated is already unpinned', async () => {
    await pinnedSession('kill-pinned-hook');
    mocks.findClaudeProcess.mockReturnValue(4646);
    let midKill: { status?: string; pinned?: boolean } = {};
    mocks.terminateProcessTree.mockImplementation(async () => {
      // The real hook path: handleEvent builds the session that hookProcessor then broadcasts.
      const result = store.handleEvent({
        hook_event_name: 'SessionEnd',
        session_id: 'kill-pinned-hook',
        cwd: '/tmp/kill-pinned-test',
        reason: 'other',
      });
      midKill = { status: result?.session.status, pinned: result?.session.pinned };
      return true;
    });

    const { status } = await kill('kill-pinned-hook');

    expect(status).toBe(200);
    expect(midKill).toEqual({ status: 'ended', pinned: false });
  });

  it('stays unpinned when the process survives SIGKILL, so a stuck process reaped later is not brought back', async () => {
    await pinnedSession('kill-pinned-survivor');
    mocks.findClaudeProcess.mockReturnValue(4343);
    mocks.terminateProcessTree.mockResolvedValue(false);

    const { status, json } = await kill('kill-pinned-survivor');

    expect(status).toBe(500);
    expect(json.stillAlivePid).toBe(4343);
    expect(endedBroadcastsFor('kill-pinned-survivor')).toEqual([]);
    // The stuck process finally dies. Its SessionEnd must not say pinned:true, or every
    // connected device would respawn the session the user just tried to kill.
    const lateEnd = store.handleEvent({
      hook_event_name: 'SessionEnd',
      session_id: 'kill-pinned-survivor',
      cwd: '/tmp/kill-pinned-test',
      reason: 'other',
    });
    expect(lateEnd?.session.status).toBe('ended');
    expect(lateEnd?.session.pinned).toBe(false);
  });
});
