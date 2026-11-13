// test/dataDir.test.ts — the one data-folder resolver (hooks/dataDir.js, terminal-editions plan §7.2).
//
// Every case passes its own env, home and project root, so nothing here reads or writes the real
// ~/.config, ~/Library or the checkout's data/ folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { APP_DIR_NAME, desktopDataDir, resolveDataDir, ensureDataDir, dataDirFlag } from '../hooks/dataDir.js';

let scratch = '';
let pkg = '';
let checkout = '';
const home = '/home/someone';

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aasc-datadir-'));
  pkg = join(scratch, 'pkg');
  checkout = join(scratch, 'checkout');
  mkdirSync(pkg, { recursive: true });
  mkdirSync(join(checkout, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('desktopDataDir', () => {
  it('matches the folder Electron gives the desktop on each platform', () => {
    expect(APP_DIR_NAME).toBe('ai-agent-session-center');
    expect(desktopDataDir({ platform: 'linux', env: {}, home })).toBe(join(home, '.config', APP_DIR_NAME));
    expect(desktopDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home })).toBe(join('/xdg', APP_DIR_NAME));
    expect(desktopDataDir({ platform: 'darwin', env: { XDG_CONFIG_HOME: '/xdg' }, home }))
      .toBe(join(home, 'Library', 'Application Support', APP_DIR_NAME));
    expect(desktopDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, home }))
      .toBe(join('C:\\Users\\a\\AppData\\Roaming', APP_DIR_NAME));
  });

  it('ignores a relative XDG_CONFIG_HOME, as the XDG spec says', () => {
    expect(desktopDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: 'rel/dir' }, home })).toBe(join(home, '.config', APP_DIR_NAME));
  });
});

describe('resolveDataDir', () => {
  const base = { platform: 'linux', home } as const;

  it('takes --data-dir first, then APP_USER_DATA, then XDG, then ~/.config', () => {
    const env = { APP_USER_DATA: '/from/env', XDG_CONFIG_HOME: '/xdg' };
    expect(resolveDataDir({ ...base, projectRoot: pkg, env, argv: ['serve', '--data-dir', '/from/flag'] }))
      .toEqual({ dir: '/from/flag', source: 'flag' });
    expect(resolveDataDir({ ...base, projectRoot: pkg, env, argv: ['serve'] }))
      .toEqual({ dir: '/from/env', source: 'env' });
    expect(resolveDataDir({ ...base, projectRoot: pkg, env: { XDG_CONFIG_HOME: '/xdg' }, argv: [] }))
      .toEqual({ dir: join('/xdg', APP_DIR_NAME), source: 'default' });
    expect(resolveDataDir({ ...base, projectRoot: pkg, env: {}, argv: [] }))
      .toEqual({ dir: join(home, '.config', APP_DIR_NAME), source: 'default' });
  });

  it('accepts --data-dir=<path> and makes a relative path absolute', () => {
    expect(dataDirFlag(['--data-dir=/a/b'])).toBe('/a/b');
    expect(dataDirFlag(['--data-dir', 'rel'])).toBe(resolve('rel'));
    expect(dataDirFlag(['--data-dir'])).toBeNull();
    expect(dataDirFlag(['--port', '1'])).toBeNull();
  });

  it('keeps <repo>/data in a git checkout, below an explicit flag or APP_USER_DATA', () => {
    expect(resolveDataDir({ ...base, projectRoot: checkout, env: { XDG_CONFIG_HOME: '/xdg' }, argv: [] }))
      .toEqual({ dir: join(checkout, 'data'), source: 'checkout' });
    expect(resolveDataDir({ ...base, projectRoot: checkout, env: { APP_USER_DATA: '/from/env' }, argv: [] }))
      .toEqual({ dir: '/from/env', source: 'env' });
    expect(resolveDataDir({ ...base, projectRoot: checkout, env: {}, argv: ['--data-dir', '/f'] }))
      .toEqual({ dir: '/f', source: 'flag' });
  });
});

describe('ensureDataDir', () => {
  it('creates the folder with mode 0700', () => {
    const dir = join(scratch, 'new', 'aasc');
    ensureDataDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('leaves an existing folder as it is', () => {
    const dir = join(scratch, 'existing');
    mkdirSync(dir, { mode: 0o755 });
    ensureDataDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o755);
  });
});
