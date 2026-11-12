// dataDir.js — the one data-folder resolver for every tool outside the server process.
//
// `aasc-server` (bin/cli.js), the setup wizard, `install-hooks` and `set-password` all read and write
// `<data folder>/server-config.json`, and the server reads the same file through APP_USER_DATA
// (server/serverConfig.ts). Before this module each tool hard-coded `<package>/data`, which on a global
// npm install is inside node_modules, and the packaged desktop read a different folder altogether.
//
// Order: --data-dir > APP_USER_DATA > a git checkout's <repo>/data > the desktop's own folder
// (Electron's app.getPath('userData')), so swapping the Linux .deb for the headless server keeps the
// password, paired devices and history.
//
// Plain ESM JavaScript on purpose: it ships as-is in the package's hooks/ folder and runs before the
// server bundle exists.

import { existsSync, mkdirSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';

export const APP_DIR_NAME = 'ai-agent-session-center';

/** The folder the desktop app keeps its data in, per platform (Electron's userData). */
export function desktopDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), APP_DIR_NAME);
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(xdg, APP_DIR_NAME);
}

/** A git checkout (development): `.git` is a folder in a clone and a file in a worktree. */
export function isCheckout(projectRoot) {
  return existsSync(join(projectRoot, '.git'));
}

/** The value of `--data-dir <path>` or `--data-dir=<path>`, made absolute; null when absent. */
export function dataDirFlag(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--data-dir=')) return arg.length > 11 ? resolve(arg.slice(11)) : null;
    if (arg === '--data-dir') return argv[i + 1] ? resolve(argv[i + 1]) : null;
  }
  return null;
}

/**
 * Where server-config.json lives. `source` says which rule picked it: a checkout's folder keeps
 * today's layout, so callers must not export it as APP_USER_DATA (the database would move from
 * <repo>/data/sessions.db to <repo>/data/data/sessions.db).
 */
export function resolveDataDir({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  home = homedir(),
  projectRoot,
} = {}) {
  const flag = dataDirFlag(argv);
  if (flag) return { dir: flag, source: 'flag' };
  if (env.APP_USER_DATA) return { dir: env.APP_USER_DATA, source: 'env' };
  if (projectRoot && isCheckout(projectRoot)) return { dir: join(projectRoot, 'data'), source: 'checkout' };
  return { dir: desktopDataDir({ platform, env, home }), source: 'default' };
}

/** Create the folder (mode 0700) when missing; an existing folder keeps its mode. */
export function ensureDataDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
