// test/spawnFloatingVisibility.test.ts — AASC-20: the fixed routes under /sessions/ are names, not
// session ids. A remote device may start an AI popup (spawn-floating) from a session it can see and from
// no other; clear-all, history and resume-command stay the Mac's alone.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as
// remote). The spawner is mocked: no PTY is ever created.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []),
  getAllPersistedSessions: vi.fn(() => [{ id: 'every-session-ever' }]),
  getSessionsByProjectPath: vi.fn(() => []),
  default: {},
}));

const spawner = vi.hoisted(() => ({
  spawnFloatingSession: vi.fn(async () => ({ terminalId: 'term-float-1', label: 'Explain (English)' })),
}));
vi.mock('../server/floatingSessionSpawner.js', () => spawner);

const term = vi.hoisted(() => ({ owner: new Map<string, string>([['t-shared', 'fv-shared'], ['t-hidden', 'fv-hidden']]) }));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async () => { throw new Error('a test must never spawn a PTY'); }),
    closeTerminal: vi.fn(),
    getTerminalSessionId: (id: string) => term.owner.get(id) ?? null,
  };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server;
let base = '';
let store: typeof import('../server/sessionStore.js');

const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.70' };
const BODY = { mode: 'explain-native', selection: 'what is this', nativeLanguage: 'English', learningLanguage: 'English' };

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const { createToken } = await import('../server/authManager.js');
  REMOTE.Authorization = `Bearer ${createToken()}`;
  await store.createTerminalSession('fv-shared', { host: 'localhost', workingDir: '/tmp/fv/s', command: 'claude' });
  await store.createTerminalSession('fv-hidden', { host: 'localhost', workingDir: '/tmp/fv/h', command: 'claude' });
  store.setSessionRemoteVisible('fv-shared', true);
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

beforeEach(() => {
  spawner.spawnFloatingSession.mockClear();
});

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('spawn-floating from a remote device', () => {
  it('starts an AI popup from a shared session, and shares the popup with the device', async () => {
    const res = await call('POST', '/sessions/spawn-floating', REMOTE, { ...BODY, originSessionId: 'fv-shared' });
    expect(res.status).toBe(200);
    expect(res.json.terminalId).toBe('term-float-1');
    expect(spawner.spawnFloatingSession).toHaveBeenCalledTimes(1);
    expect(spawner.spawnFloatingSession.mock.calls[0]).toEqual([
      expect.objectContaining({ originSessionId: 'fv-shared', mode: 'explain-native' }),
      { remoteVisible: true },
    ]);
  });

  it('may name the shared session’s own terminal as the host', async () => {
    const res = await call('POST', '/sessions/spawn-floating', REMOTE, { ...BODY, originSessionId: 'fv-shared', spawnTerminalId: 't-shared' });
    expect(res.status).toBe(200);
  });

  it('is a 404 from a hidden session, an unknown one, or without one — never a 403', async () => {
    for (const origin of [{ originSessionId: 'fv-hidden' }, { originSessionId: 'no-such-session' }, {}]) {
      const res = await call('POST', '/sessions/spawn-floating', REMOTE, { ...BODY, ...origin });
      expect(res.status, JSON.stringify(origin)).toBe(404);
      expect(res.json.error).toBe('Session not found');
    }
    expect(spawner.spawnFloatingSession).not.toHaveBeenCalled();
  });

  it('can’t fork a hidden session by naming its terminal as the host', async () => {
    for (const host of ['t-hidden', 't-orphan']) {
      const res = await call('POST', '/sessions/spawn-floating', REMOTE, { ...BODY, originSessionId: 'fv-shared', spawnTerminalId: host });
      expect(res.status, host).toBe(404);
    }
    expect(spawner.spawnFloatingSession).not.toHaveBeenCalled();
  });

  it('treats a path below the name as a session id, which fails closed', async () => {
    const res = await call('POST', '/sessions/spawn-floating/fork', REMOTE, { ...BODY, originSessionId: 'fv-shared' });
    expect(res.status).toBe(404);
    expect(spawner.spawnFloatingSession).not.toHaveBeenCalled();
  });
});

describe('spawn-floating on the Mac', () => {
  it('keeps the popup local', async () => {
    const res = await call('POST', '/sessions/spawn-floating', {}, { ...BODY, originSessionId: 'fv-hidden' });
    expect(res.status).toBe(200);
    expect(spawner.spawnFloatingSession.mock.calls[0][1]).toEqual({ remoteVisible: false });
  });
});

describe('the other fixed routes stay the Mac’s', () => {
  it('clear-all is unreachable for a remote device, sessions untouched', async () => {
    const res = await call('POST', '/sessions/clear-all', REMOTE, {});
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Not found');
    expect(store.getSession('fv-shared')).toBeDefined();
    expect(store.getSession('fv-hidden')).toBeDefined();
  });

  it('history (every persisted session) is the Mac’s only', async () => {
    expect((await call('GET', '/sessions/history', REMOTE)).status).toBe(404);
    const local = await call('GET', '/sessions/history');
    expect(local.status).toBe(200);
  });

  it('resume-command is the Mac’s only', async () => {
    const res = await call('GET', '/sessions/resume-command?path=%2Ftmp%2Ffv%2Fh', REMOTE);
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('Not found');
  });

  it('a shared session is still reachable by id', async () => {
    expect((await call('GET', '/sessions/fv-shared/source', REMOTE)).status).toBe(200);
    expect((await call('GET', '/sessions/fv-hidden/source', REMOTE)).status).toBe(404);
  });
});
