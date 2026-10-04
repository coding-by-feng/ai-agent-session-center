// test/hookInstallerStatusline.test.ts — the status-line tap's install / uninstall plumbing.
//
// hooks/dashboard-statusline.sh must be sitting in ~/.claude/hooks before a launch names it
// (server/config.ts isStatusLineTapInstalled), so every path that installs the hook script
// installs it too — and every path that removes the hook removes it. It is NOT registered in
// ~/.claude/settings.json: the dashboard passes it per launch (`claude --settings …`), and a
// status line registered there would take over the user's own in every session they start.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

// hookInstaller.js merges data/server-config.json from the repo into its options, and on a
// developer's machine that file lists enabledClis — which would override what these tests ask
// for. Hide it; everything else reads through.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.replace(/\\/g, '/').endsWith('/data/server-config.json')) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

import { ensureHooksInstalled } from '../server/hookInstaller.js';
import { installHooks } from '../hooks/install-hooks-api.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const TAP_SOURCE = join(REPO, 'hooks', 'dashboard-statusline.sh');
const HOOK_SOURCE = join(REPO, 'hooks', 'dashboard-hook.sh');
const realPlatform = process.platform;

let home: string;
let previousHome: string | undefined;

const hooksDir = () => join(home, '.claude', 'hooks');
const tapDest = () => join(hooksDir(), 'dashboard-statusline.sh');
const mode = (path: string) => statSync(path).mode & 0o777;
const settings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aasc-installer-home-'));
  previousHome = process.env.HOME;
  process.env.HOME = home; // os.homedir() follows HOME on POSIX
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe.skipIf(realPlatform === 'win32')('ensureHooksInstalled (server startup)', () => {
  it('syncs the tap next to the hook script, executable', () => {
    ensureHooksInstalled({ enabledClis: ['claude'] });

    expect(readFileSync(tapDest())).toEqual(readFileSync(TAP_SOURCE));
    expect(mode(tapDest())).toBe(0o755);
    expect(readFileSync(join(hooksDir(), 'dashboard-hook.sh'))).toEqual(readFileSync(HOOK_SOURCE));
    expect(mode(join(hooksDir(), 'dashboard-hook.sh'))).toBe(0o755);
  });

  it('registers the hook events as before, and no status line', () => {
    ensureHooksInstalled({ enabledClis: ['claude'] });

    const written = settings();
    expect(Object.keys(written.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'Stop']));
    expect(written).not.toHaveProperty('statusLine');
    expect(JSON.stringify(written)).not.toContain('dashboard-statusline');
  });

  it('leaves a status line the user already has untouched', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const mine = { type: 'command', command: '~/bin/my-bar' };
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: mine }));

    ensureHooksInstalled({ enabledClis: ['claude'] });

    expect(settings().statusLine).toEqual(mine);
  });

  it('is a no-op the second time', () => {
    ensureHooksInstalled({ enabledClis: ['claude'] });
    // age the files so a rewrite shows in the mtime
    const old = new Date(Date.now() - 60_000);
    for (const f of [tapDest(), join(home, '.claude', 'settings.json')]) utimesSync(f, old, old);
    const before = [tapDest(), join(home, '.claude', 'settings.json')].map((f) => statSync(f).mtimeMs);

    ensureHooksInstalled({ enabledClis: ['claude'] });

    expect([tapDest(), join(home, '.claude', 'settings.json')].map((f) => statSync(f).mtimeMs)).toEqual(before);
  });

  it('replaces a stale copy of the tap', () => {
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(tapDest(), '#!/bin/bash\n# an older release\n');
    chmodSync(tapDest(), 0o644);

    ensureHooksInstalled({ enabledClis: ['claude'] });

    expect(readFileSync(tapDest())).toEqual(readFileSync(TAP_SOURCE));
    expect(mode(tapDest())).toBe(0o755);
  });

  it('does not install it when Claude is not an enabled CLI', () => {
    ensureHooksInstalled({ enabledClis: ['codex'] });

    expect(existsSync(tapDest())).toBe(false);
    expect(existsSync(join(hooksDir(), 'dashboard-hook.sh'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'hooks', 'dashboard-hook.sh'))).toBe(true); // codex still installed
  });

  it('does not install it on Windows (it is a bash script)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    ensureHooksInstalled({ enabledClis: ['claude'] });

    expect(existsSync(tapDest())).toBe(false);
    expect(existsSync(join(hooksDir(), 'dashboard-hook.ps1'))).toBe(true);
  });
});

describe.skipIf(realPlatform === 'win32')('installHooks (the API installer behind the CLI and the settings screen)', () => {
  const install = (over: Record<string, unknown> = {}) =>
    installHooks({ projectRoot: REPO, enabledClis: ['claude'], onLog: () => {}, ...over });

  it('deploys the tap with the hook script, executable, and registers no status line', async () => {
    await install();

    expect(readFileSync(tapDest())).toEqual(readFileSync(TAP_SOURCE));
    expect(mode(tapDest())).toBe(0o755);
    expect(settings()).not.toHaveProperty('statusLine');
    expect(JSON.stringify(settings())).not.toContain('dashboard-statusline');
  });

  it('removes the tap on uninstall', async () => {
    await install();
    expect(existsSync(tapDest())).toBe(true);

    await install({ uninstall: true });

    expect(existsSync(tapDest())).toBe(false);
  });

  it('keeps it when the uninstall is scoped to another CLI', async () => {
    await install();

    await install({ uninstall: true, uninstallOnly: ['codex'] });

    expect(existsSync(tapDest())).toBe(true);
  });

  it('never deletes a file of that name that is not ours', async () => {
    mkdirSync(hooksDir(), { recursive: true });
    writeFileSync(tapDest(), '#!/bin/sh\necho "my own status line"\n');

    await install({ uninstall: true });

    expect(readFileSync(tapDest(), 'utf8')).toContain('my own status line');
  });
});

describe('hooks/reset.js (`npm run reset`) — checked as source, because running it wipes the repo\'s data/', () => {
  const source = readFileSync(join(REPO, 'hooks', 'reset.js'), 'utf8');
  const scriptLists = source.split('\n').filter((line) => /^for \(const script of \[/.test(line));

  it('walks the same two Claude script lists as before', () => {
    expect(scriptLists).toHaveLength(2); // one backs the scripts up, one removes them
    for (const line of scriptLists) expect(line).toContain("'dashboard-hook.sh'");
  });

  it('backs up AND removes the tap with them', () => {
    for (const line of scriptLists) expect(line).toContain("'dashboard-statusline.sh'");
  });

  it('only removes a script that carries the project marker the tap\'s header has', () => {
    expect(source).toContain("content.includes('claude-session-center')");
    expect(readFileSync(TAP_SOURCE, 'utf8')).toContain('claude-session-center');
  });
});
