// test/terminalRouteVisibility.test.ts — AASC-25: the /terminals routes obey session visibility and the
// control baton for remote devices, as TERMINAL_SUBSCRIBE and terminal_input already do on the socket.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as
// remote), so the suite needs no second network interface.
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const term = vi.hoisted(() => ({
  owner: new Map<string, string>([['t-shared', 'tv-shared'], ['t-hidden', 'tv-hidden']]),
  write: vi.fn(),
  close: vi.fn(),
  prefill: vi.fn(() => true),
}));

vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    getTerminals: () => [...term.owner.keys(), 't-orphan'].map((terminalId) => ({ terminalId })),
    getTerminalSessionId: (id: string) => term.owner.get(id) ?? null,
    getTerminalOutputBuffer: (id: string) => (id.startsWith('t-') ? Buffer.from(`output of ${id}`).toString('base64') : null),
    writeToTerminal: term.write,
    closeTerminal: term.close,
    prefillTerminalOutput: term.prefill,
  };
});

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server;
let base = '';
let store: typeof import('../server/sessionStore.js');
let presence: typeof import('../server/presenceManager.js');

const REMOTE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.50' };

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  presence = await import('../server/presenceManager.js');
  // A remote device is always signed in (remote access needs a password), and
  // its device id is tied to that sign-in (AASC-27).
  const { createToken } = await import('../server/authManager.js');
  REMOTE.Authorization = `Bearer ${createToken()}`;
  await store.createTerminalSession('tv-shared', { host: 'localhost', workingDir: '/tmp/term-vis/s', command: 'claude' });
  await store.createTerminalSession('tv-hidden', { host: 'localhost', workingDir: '/tmp/term-vis/h', command: 'claude' });
  store.setSessionRemoteVisible('tv-shared', true);
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
  term.write.mockClear();
  term.close.mockClear();
  term.prefill.mockClear();
  presence.releaseAllControls('phone-1');
  presence.releaseAllControls('desk-1');
});

async function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

describe('remote device', () => {
  it('lists only the terminals of shared sessions', async () => {
    const res = await call('GET', '/terminals', REMOTE);
    expect(res.status).toBe(200);
    expect((res.json.terminals as Array<{ terminalId: string }>).map((t) => t.terminalId)).toEqual(['t-shared']);
  });

  it('cannot read a hidden session’s terminal output (404, not 403)', async () => {
    expect((await call('GET', '/terminals/t-hidden/output', REMOTE)).status).toBe(404);
    expect((await call('GET', '/terminals/t-orphan/output', REMOTE)).status).toBe(404); // unattributable fails closed
    expect((await call('GET', '/terminals/t-shared/output', REMOTE)).status).toBe(200);
  });

  it('cannot type into a hidden session’s terminal', async () => {
    const res = await call('POST', '/terminals/t-hidden/write', { ...REMOTE, 'X-AASC-Client-Id': 'phone-1' }, { data: 'rm -rf ~\r' });
    expect(res.status).toBe(404);
    expect(term.write).not.toHaveBeenCalled();
  });

  it('types into a shared session only when identified and holding control', async () => {
    const anonymous = await call('POST', '/terminals/t-shared/write', REMOTE, { data: 'ls\r' });
    expect(anonymous.status).toBe(409);
    const ok = await call('POST', '/terminals/t-shared/write', { ...REMOTE, 'X-AASC-Client-Id': 'phone-1' }, { data: 'ls\r' });
    expect(ok.status).toBe(200);
    expect(term.write).toHaveBeenCalledWith('t-shared', 'ls\r');
  });

  // Oct 2026, by request: no Ask / Take control. A remote device types into a shared session it can see.
  it('writes even while another connected device drove the session last', async () => {
    presence.registerClient({ clientId: 'desk-1', label: 'Desktop', address: '127.0.0.1', isLocal: true });
    expect(presence.claimControl('tv-shared', 'desk-1').ok).toBe(true);
    const res = await call('POST', '/terminals/t-shared/write', { ...REMOTE, 'X-AASC-Client-Id': 'phone-1' }, { data: 'ls\r' });
    expect(res.status).toBe(200);
    expect(term.write).toHaveBeenCalled();
    presence.unregisterClient('desk-1');
  });

  it('cannot close a hidden session’s terminal', async () => {
    expect((await call('DELETE', '/terminals/t-hidden', REMOTE)).status).toBe(404);
    expect(term.close).not.toHaveBeenCalled();
    expect((await call('DELETE', '/terminals/t-shared', REMOTE)).status).toBe(200);
  });

  it('cannot restore scrollback or register terminals (desktop-only)', async () => {
    expect((await call('POST', '/terminals/t-shared/prefill-output', REMOTE, { data: 'eA==' })).status).toBe(404);
    expect(term.prefill).not.toHaveBeenCalled();
    expect((await call('POST', '/terminals/register', REMOTE, { terminalId: 'x' })).status).toBe(404);
  });
});

describe('the desktop app (local)', () => {
  it('keeps full access, unchanged', async () => {
    expect(((await call('GET', '/terminals')).json.terminals as unknown[]).length).toBe(3);
    expect((await call('GET', '/terminals/t-hidden/output')).status).toBe(200);
    expect((await call('POST', '/terminals/t-hidden/write', {}, { data: 'x' })).status).toBe(200);
    expect((await call('POST', '/terminals/t-hidden/prefill-output', {}, { data: 'eA==' })).status).toBe(200);
  });
});
