// test/killPinnedSession.test.ts — POST /api/sessions/:id/kill on a pinned session: a kill must unpin it
// before the ENDED broadcast (or every client's pinnedRespawn relaunches it); a failed kill keeps the pin.
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

async function pinnedSession(id: string): Promise<void> {
  await store.createTerminalSession(id, { host: 'localhost', workingDir: '/tmp/kill-pinned-test', command: 'claude' });
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

  it('keeps the pin when the process survives SIGKILL, because the session is still running', async () => {
    await pinnedSession('kill-pinned-survivor');
    mocks.findClaudeProcess.mockReturnValue(4343);
    mocks.terminateProcessTree.mockResolvedValue(false);

    const { status, json } = await kill('kill-pinned-survivor');

    expect(status).toBe(500);
    expect(json.stillAlivePid).toBe(4343);
    expect(store.getSession('kill-pinned-survivor')?.pinned).toBe(true);
    expect(endedBroadcastsFor('kill-pinned-survivor')).toEqual([]);
  });
});
