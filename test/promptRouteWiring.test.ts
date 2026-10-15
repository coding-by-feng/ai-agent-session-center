// test/promptRouteWiring.test.ts — AASC-42: POST /api/sessions/:id/prompt wired as the server
// wires it (promptWiring.ts): the real phone profile, apiRouter's visibility gate and device
// binding, the control baton, the session store and the hook pipeline. The PTY layer is a fake
// (sshManager is mocked), the process monitor's scans and kills are switched off, and the
// queue-image sweep runs on a scratch folder: nothing is spawned, written to a real terminal,
// killed, or deleted from the Mac's own image folder.
//
// A remote device is a forwarding header on a loopback request (AASC-13 treats that as remote).
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const pty = vi.hoisted(() => ({
  terminals: new Set<string>(),
  fg: new Map<string, string>(),
  write: vi.fn(),
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async () => { throw new Error('no terminals in this test'); }),
    writeWhenReady: vi.fn(),
    getTerminals: () => [...pty.terminals].map((terminalId) => ({ terminalId, isOps: false })),
    writeToTerminal: pty.write,
    getTerminalSessionId: () => null,
    isOpsTerminal: () => false,
    getForegroundProcess: (id: string) => pty.fg.get(id) ?? null,
  };
});

// The session store starts the liveness monitor and the 20 s external-session scan on import;
// neither may look at (or kill) a real process from a test.
vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...actual,
    startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn(), stopExternalDiscovery: vi.fn(),
    findClaudeProcess: vi.fn(() => null), terminateProcessTree: vi.fn(async () => false),
    reapPtyChildren: vi.fn(), listChildPids: vi.fn(() => []),
  };
});

// apiRouter sweeps the queue-image folder when it loads: point it at a scratch folder.
vi.mock('../server/queueImages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/queueImages.js')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return { ...actual, QUEUE_IMAGES_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aasc42-queue-images-')) };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { createPhoneProfile } from '../server/mobile/phoneProfile.js';

let tmp = '';
let project = '';
let server: Server;
let base = '';
let store: typeof import('../server/sessionStore.js');
let hooks: typeof import('../server/hookProcessor.js');
let presence: typeof import('../server/presenceManager.js');
let auth: typeof import('../server/authManager.js');
const PHONE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.70', 'X-AASC-Client-Id': 'phone-w' };

const SHARED = 'uuid-shared-w';
const HIDDEN = 'uuid-hidden-w';
const T_SHARED = 'term-shared-w';
const T_HIDDEN = 'term-hidden-w';

/** One hook through the real pipeline, as the MQ reader would hand it over. */
function hook(event: string, sessionId: string, terminalId: string, extra: Record<string, unknown> = {}): void {
  hooks.processHookEvent({
    session_id: sessionId, hook_event_name: event, agent_terminal_id: terminalId, cwd: project, tty_path: '/dev/ttys950', ...extra,
  } as never);
}

beforeAll(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc42-wiring-')));
  project = join(tmp, 'home', 'proj');
  mkdirSync(project, { recursive: true });
  store = await import('../server/sessionStore.js');
  hooks = await import('../server/hookProcessor.js');
  presence = await import('../server/presenceManager.js');
  auth = await import('../server/authManager.js');
  PHONE.Authorization = `Bearer ${auth.createToken('dev-phone-w')}`;

  for (const [terminalId, sessionId] of [[T_SHARED, SHARED], [T_HIDDEN, HIDDEN]]) {
    pty.terminals.add(terminalId);
    await store.createTerminalSession(terminalId, { host: 'localhost', workingDir: project, command: 'claude' });
    hook('SessionStart', sessionId, terminalId);
  }
  store.setSessionRemoteVisible(SHARED, true);

  const app = express();
  app.use(express.json());
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
    sharedProjectPaths: () => [project],
    knownProjectPaths: () => [project],
    isOpsTerminal: () => false,
    isSharedSession: (id) => store.getSession(id)?.remoteVisible === true,
    sessionOfTerminal: () => null,
    foregroundProcess: (id) => pty.fg.get(id) ?? null,
    home: join(tmp, 'home'),
  }));
  const { createServerPromptRouter } = await import('../server/promptWiring.js');
  const { default: apiRouter } = await import('../server/apiRouter.js');
  app.use('/api', createServerPromptRouter(), apiRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
  const { QUEUE_IMAGES_DIR } = await import('../server/queueImages.js');
  expect(QUEUE_IMAGES_DIR).toContain('aasc42-queue-images-');
  rmSync(QUEUE_IMAGES_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  pty.write.mockClear();
  pty.fg.set(T_SHARED, 'claude');
  pty.fg.set(T_HIDDEN, 'claude');
  presence.releaseAllControls('phone-w');
  presence.releaseAllControls('mac-w');
});

let keyN = 0;
async function prompt(sessionId: string, body: Record<string, unknown> = {}) {
  const key = `wiring-key-${++keyN}`;
  const res = await fetch(`${base}/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...PHONE },
    body: JSON.stringify({ text: 'hello from the phone', key, ...body }),
  });
  return { status: res.status, key, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** What became of a prompt, asked from the Mac itself (it sees hidden sessions too). */
async function stateOf(sessionId: string, key: string): Promise<unknown> {
  const res = await fetch(`${base}/api/sessions/${sessionId}/prompt/${key}`);
  return ((await res.json()) as { data?: { state?: unknown } }).data?.state;
}

const writesTo = (terminalId: string) => pty.write.mock.calls.filter(([id]) => id === terminalId).map(([, data]) => data);

describe('the prompt route on the live server', () => {
  it('sessions are set up as an agent terminal each, one of them shared', () => {
    expect(store.getSession(SHARED)?.terminalId).toBe(T_SHARED);
    expect(store.getSession(SHARED)?.remoteVisible).toBe(true);
    expect(store.getSession(HIDDEN)?.terminalId).toBe(T_HIDDEN);
    expect(store.getSession(HIDDEN)?.remoteVisible).not.toBe(true);
  });

  it('a phone sends to a shared session: 202, the text is typed, then Enter on its own', async () => {
    const res = await prompt(SHARED);
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ success: true, data: { accepted: true } });
    expect(writesTo(T_SHARED)).toEqual(['hello from the phone']);
    // The phone now drives the session.
    expect(presence.getController(SHARED)?.clientId).toBe('phone-w');
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['hello from the phone', '\r']), { timeout: 3_000 });
    hook('UserPromptSubmit', SHARED, T_SHARED, { prompt: 'hello from the phone' });
    hook('Stop', SHARED, T_SHARED);
  });

  it('a phone still holding the id from before the re-key (term-*) reaches the same session', async () => {
    const res = await prompt(T_SHARED, { text: 'by the old id' });
    expect(res.status).toBe(202);
    expect(writesTo(T_SHARED)).toEqual(['by the old id']);
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['by the old id', '\r']), { timeout: 3_000 });
    hook('UserPromptSubmit', SHARED, T_SHARED, { prompt: 'by the old id' });
    hook('Stop', SHARED, T_SHARED);
  });

  it('a hidden session is a 404, and nothing is typed', async () => {
    const res = await prompt(HIDDEN);
    expect(res.status).toBe(404);
    expect(writesTo(T_HIDDEN)).toEqual([]);
  });

  it('423 while another connected device drives it, naming that device', async () => {
    presence.registerClient({ clientId: 'mac-w', label: 'Studio Mac', address: '127.0.0.1', isLocal: true });
    try {
      expect(presence.claimControl(SHARED, 'mac-w', { label: 'Studio Mac' }).ok).toBe(true);
      const res = await prompt(SHARED);
      expect(res.status).toBe(423);
      expect(res.json).toMatchObject({ code: 'control_held', driver: { label: 'Studio Mac', online: true } });
      expect(writesTo(T_SHARED)).toEqual([]);
    } finally {
      presence.unregisterClient('mac-w');
    }
  });

  it('409 once the agent exited and the shell is in front', async () => {
    pty.fg.set(T_SHARED, 'zsh');
    const res = await prompt(SHARED);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('AGENT_NOT_RUNNING');
    expect(writesTo(T_SHARED)).toEqual([]);
  });

  it('an interrupt types only once the turn’s Stop hook has come through the pipeline', async () => {
    hook('UserPromptSubmit', SHARED, T_SHARED, { prompt: 'a long task' });
    hook('PreToolUse', SHARED, T_SHARED, { tool_name: 'Bash', tool_input: { command: 'sleep 100' } });
    expect(store.getSession(SHARED)?.status).toBe('working');

    const res = await prompt(SHARED, { text: 'stop and do this', mode: 'interrupt' });
    expect(res.status).toBe(202);
    expect(writesTo(T_SHARED)).toEqual(['\x1b']);
    hook('Stop', SHARED, T_SHARED);
    expect(writesTo(T_SHARED)).toEqual(['\x1b']);
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['\x1b', 'stop and do this']), { timeout: 500 });
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['\x1b', 'stop and do this', '\r']), { timeout: 3_000 });
    hook('UserPromptSubmit', SHARED, T_SHARED, { prompt: 'stop and do this' });
  });
  it('un-sharing the session mid-send stops the Enter retries', async () => {
    hook('Stop', SHARED, T_SHARED); // waiting for a prompt: a swallowed Enter is retried
    const res = await prompt(SHARED, { text: 'until it is hidden' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['until it is hidden', '\r']), { timeout: 3_000 });
    store.setSessionRemoteVisible(SHARED, false);
    try {
      // The first repeated Enter is due 3 s after the Enter; it must not come.
      await vi.waitFor(async () => expect(await stateOf(SHARED, res.key)).toBe('stopped'), { timeout: 6_000, interval: 200 });
      expect(writesTo(T_SHARED)).toEqual(['until it is hidden', '\r']);
    } finally {
      store.setSessionRemoteVisible(SHARED, true);
    }
  }, 15_000);

  // Last: it ends the phone's sign-in.
  it('removing the phone mid-send stops the Enter retries', async () => {
    hook('Stop', SHARED, T_SHARED);
    const res = await prompt(SHARED, { text: 'until the phone is removed' });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(writesTo(T_SHARED)).toEqual(['until the phone is removed', '\r']), { timeout: 3_000 });
    expect(auth.revokeTokensForDevice('dev-phone-w')).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await stateOf(SHARED, res.key)).toBe('stopped'), { timeout: 6_000, interval: 200 });
    expect(writesTo(T_SHARED)).toEqual(['until the phone is removed', '\r']);
  }, 15_000);
});
