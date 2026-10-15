// test/subagentTranscriptVisibility.test.ts — a subagent's transcript is its session's content: a remote
// device reads it only for a session shared with it. The route is mounted under /sessions/:id, after the
// visibility gate; this pins that through the real API router.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as
// remote). No PTY is ever spawned.
import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []),
  getAllPersistedSessions: vi.fn(() => []), getSessionsByProjectPath: vi.fn(() => []),
  default: {},
}));

vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async () => { throw new Error('a test must never spawn a PTY'); }),
    closeTerminal: vi.fn(),
  };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server;
let base = '';
const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.70' };

beforeAll(async () => {
  const store = await import('../server/sessionStore.js');
  const { createToken } = await import('../server/authManager.js');
  REMOTE.Authorization = `Bearer ${createToken()}`;
  await store.createTerminalSession('sv-shared', { host: 'localhost', workingDir: '/tmp/sv/s', command: 'claude' });
  await store.createTerminalSession('sv-hidden', { host: 'localhost', workingDir: '/tmp/sv/h', command: 'claude' });
  store.setSessionRemoteVisible('sv-shared', true);
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('GET /sessions/:id/subagents/:agentId/transcript from a remote device', () => {
  it('a hidden session is "not found" at the gate, before the route looks for the agent', async () => {
    const res = await get('/sessions/sv-hidden/subagents/a1/transcript', REMOTE);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Session not found');
  });

  it('a shared session passes the gate (and this one has no such run)', async () => {
    const res = await get('/sessions/sv-shared/subagents/a1/transcript', REMOTE);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Subagent not found');
  });

  it('the Mac itself reaches the route for any session', async () => {
    const res = await get('/sessions/sv-hidden/subagents/a1/transcript');
    expect(res.json.error).toBe('Subagent not found');
  });
});
