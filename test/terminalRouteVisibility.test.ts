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
  ops: [] as string[],
  write: vi.fn(),
  close: vi.fn(),
  prefill: vi.fn(() => true),
  /** What readTerminalScreenCells renders: rows of text, or null for no screen. */
  screen: null as string[] | null,
  /** The terminal's foreground program. */
  foreground: 'claude' as string | null,
}));

vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    getTerminals: () => [...term.owner.keys(), 't-orphan', ...term.ops].map((terminalId) => ({ terminalId })),
    getTerminalSessionId: (id: string) => term.owner.get(id) ?? null,
    getTerminalOutputBuffer: (id: string) => (id.startsWith('t-') ? Buffer.from(`output of ${id}`).toString('base64') : null),
    writeToTerminal: term.write,
    closeTerminal: term.close,
    prefillTerminalOutput: term.prefill,
    getForegroundProcess: () => term.foreground,
    readTerminalScreenCells: async () =>
      term.screen?.map((line) => [...line].map((ch) => ({ ch, dim: false }))) ?? null,
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
  term.ops.length = 0;
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

  it('resolves attributed ops shells through session visibility while keeping hidden and orphan shells denied', async () => {
    term.ops.push('t-ops-shared', 't-ops-hidden');
    store.reconnectOpsTerminal('tv-shared', 't-ops-shared');
    store.reconnectOpsTerminal('tv-hidden', 't-ops-hidden');
    expect(store.getSessionIdByTerminalId('t-ops-shared')).toBe('tv-shared');
    expect((await call('GET', '/terminals/t-ops-shared/output', REMOTE)).status).toBe(200);
    expect((await call('POST', '/terminals/t-ops-shared/write', { ...REMOTE, 'X-AASC-Client-Id': 'desk-ops' }, { data: 'echo proof\r' })).status).toBe(200);
    expect(term.write).toHaveBeenCalledWith('t-ops-shared', 'echo proof\r');
    expect((await call('GET', '/terminals/t-ops-hidden/output', REMOTE)).status).toBe(404);
    expect((await call('GET', '/terminals/t-ops-orphan/output', REMOTE)).status).toBe(404);
    for (const terminalId of ['t-ops-hidden', 't-ops-orphan']) {
      expect((await call('POST', `/terminals/${terminalId}/write`, { ...REMOTE, 'X-AASC-Client-Id': 'desk-ops' }, { data: 'must-not-write\r' })).status).toBe(404);
    }
    expect(term.write).toHaveBeenCalledTimes(1);
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

// Nov 13 2026: the queue's "take the text from Claude's input box" types Ctrl+U, so it obeys /write's rules.
describe('POST /terminals/:id/take-input', () => {
  const RULE = '─'.repeat(40);
  const box = (text: string) => [RULE, `❯ ${text}`, RULE];
  beforeEach(async () => {
    term.foreground = 'claude';
    (await import('../server/inputBoxCapture.js')).forgetTerminalWrites();
  });

  it('hands the desktop the box text and clears the box with Ctrl+U', async () => {
    term.screen = box('dictated words');
    const res = await call('POST', '/terminals/t-hidden/take-input', {}, {});
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true, data: { text: 'dictated words' } });
    expect(term.write).toHaveBeenCalledWith('t-hidden', expect.stringMatching(/^\x15+$/));
  });

  it('says so, writing nothing, when no input box is on screen', async () => {
    term.screen = ['Do you want to proceed?', '❯ 1. Yes'];
    const res = await call('POST', '/terminals/t-shared/take-input', {}, {});
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('NO_INPUT_BOX');
    expect(term.write).not.toHaveBeenCalled();
  });

  it('waits out a queue send between its text and its Enter, then takes', async () => {
    term.screen = box('queued prompt');
    await call('POST', '/terminals/t-shared/write', {}, { data: 'queued prompt' });
    term.write.mockClear();
    const busy = await call('POST', '/terminals/t-shared/take-input', {}, {});
    expect(busy.status).toBe(409);
    expect(busy.json.code).toBe('SEND_IN_PROGRESS');
    expect(term.write).not.toHaveBeenCalled();
    await call('POST', '/terminals/t-shared/write', {}, { data: '\r' });
    expect((await call('POST', '/terminals/t-shared/take-input', {}, {})).status).toBe(200);
  });

  it('refuses when Claude is no longer the program in front', async () => {
    term.screen = box('stale');
    term.foreground = 'zsh';
    const res = await call('POST', '/terminals/t-shared/take-input', {}, {});
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('NOT_AGENT');
    expect(term.write).not.toHaveBeenCalled();
  });

  it('is 404 for a terminal with no screen', async () => {
    term.screen = null;
    expect((await call('POST', '/terminals/t-shared/take-input', {}, {})).status).toBe(404);
  });

  it('never reaches a hidden session from a remote device, nor any session anonymously', async () => {
    term.screen = box('secret');
    expect((await call('POST', '/terminals/t-hidden/take-input', { ...REMOTE, 'X-AASC-Client-Id': 'phone-1' }, {})).status).toBe(404);
    expect((await call('POST', '/terminals/t-shared/take-input', REMOTE, {})).status).toBe(409);
    expect(term.write).not.toHaveBeenCalled();
  });
});
