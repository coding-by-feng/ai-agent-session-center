// cliPlan.js — what `aasc-server <command>` runs, as plain data (bin/cli.js executes it).
//
// Kept apart from bin/cli.js so the routing and the headless environment are testable without
// starting anything (test/headlessStart.test.ts).

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, constants } from 'os';
import { resolveDataDir, isCheckout } from '../hooks/dataDir.js';

/** The owner's commands on the box (P2): cli/server, authenticated with <data>/owner.token. */
export const ADMIN_COMMANDS = ['pair', 'devices', 'status', 'doctor', 'logs', 'share-default'];

export const COMMANDS = [
  'serve', 'setup', 'set-password', 'install-service', 'uninstall-service', 'install-hooks', 'uninstall-hooks', 'help',
  ...ADMIN_COMMANDS,
];

/**
 * `aasc-server [command] [args]`. No command (or a leading flag) means `serve`, so `npx
 * ai-agent-session-center --port 4000` keeps working. The old `--setup` and `--uninstall` flags map
 * to setup-then-serve and `uninstall-hooks`.
 */
export function parseCli(argv) {
  const [first, ...more] = argv;
  if (first === '--help' || first === '-h') return { command: 'help', rest: more, setup: false };
  if (first === '--uninstall') return { command: 'uninstall-hooks', rest: more, setup: false };
  if (first === undefined || first.startsWith('-') || first === 'serve') {
    const args = first === 'serve' ? more : argv;
    return { command: 'serve', rest: args.filter((a) => a !== '--setup'), setup: args.includes('--setup') };
  }
  if (COMMANDS.includes(first)) return { command: first, rest: more, setup: false };
  return { command: 'unknown', rest: more, setup: false, name: first };
}

/** sysexits' EX_CONFIG: a refusal only the user can fix; the systemd unit doesn't restart on it. */
export const EX_CONFIG = 78;
/** sysexits' EX_USAGE: an unknown command or bad flags. 2 already means "the server isn't running" (§8.1). */
export const EX_USAGE = 64;

/**
 * The exit status for a child that exited with `code` or was killed by `signal`: the shell's 128 + the
 * signal number, so an OOM SIGKILL reads as 137 and systemd's Restart=on-failure restarts it.
 */
export function exitStatus(code, signal) {
  if (code !== null && code !== undefined) return code;
  const number = signal ? constants.signals[signal] : undefined;
  return number ? 128 + number : 1;
}

/** `rest` without `--data-dir <path>` / `--data-dir=<path>`, which the server itself never reads. */
function withoutDataDir(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--data-dir') { i++; continue; }
    if (rest[i].startsWith('--data-dir=')) continue;
    out.push(rest[i]);
  }
  return out;
}

function tsxBin(projectRoot) {
  const local = join(projectRoot, 'node_modules', '.bin', 'tsx');
  return existsSync(local) ? local : 'tsx';
}

/** A checkout runs the TypeScript sources with tsx (development only); a package runs the bundles. */
function isSourceCheckout(projectRoot) {
  return isCheckout(projectRoot) && existsSync(join(projectRoot, 'server', 'index.ts'));
}

/**
 * The environment every headless child gets. ELECTRON is dropped: with it the server would wait to be
 * started by Electron and never start itself. A checkout's own <repo>/data is not exported as
 * APP_USER_DATA, which would move its database to <repo>/data/data/.
 */
function headlessEnv(env, dataDir, dataSource) {
  const { ELECTRON: _electron, ...rest } = env;
  return {
    ...rest,
    AASC_HEADLESS: '1',
    AASC_NO_PORT_KILL: '1',
    ...(dataSource === 'checkout' ? {} : { APP_USER_DATA: dataDir }),
  };
}

/** `aasc-server serve`: the server process, its arguments and environment, and whether setup runs first. */
export function planServe({ projectRoot, rest, env = process.env, platform = process.platform, home = homedir() }) {
  const { dir, source } = resolveDataDir({ argv: rest, env, platform, home, projectRoot });
  const serverArgs = withoutDataDir(rest);
  if (!serverArgs.includes('--no-open')) serverArgs.push('--no-open');

  let mode, command, args;
  if (isSourceCheckout(projectRoot)) {
    mode = 'checkout';
    command = tsxBin(projectRoot);
    args = [join(projectRoot, 'server', 'index.ts'), ...serverArgs];
  } else {
    const bundle = join(projectRoot, 'dist', 'server-bundle.cjs');
    if (!existsSync(bundle)) {
      throw new Error(`${bundle} is missing. This install is incomplete; reinstall it, or run \`npm run build:server\` in a checkout.`);
    }
    mode = 'package';
    command = process.execPath;
    args = [bundle, ...serverArgs];
  }

  return {
    mode,
    command,
    args,
    env: headlessEnv(env, dir, source),
    dataDir: dir,
    dataSource: source,
    needsSetup: !existsSync(join(dir, 'server-config.json')),
  };
}

/**
 * Every other command: a node script from the package, run with the same data folder and headless
 * environment. install-service / uninstall-service need the built admin CLI, so they run from a
 * package only: a systemd unit pointing into a git checkout would run tsx from a working tree.
 */
export function planTool(command, { projectRoot, rest, env = process.env, platform = process.platform, home = homedir() }) {
  const { dir, source } = resolveDataDir({ argv: rest, env, platform, home, projectRoot });
  const args = withoutDataDir(rest);
  const childEnv = headlessEnv(env, dir, source);
  const node = (script, extra = []) => ({ command: process.execPath, args: [join(projectRoot, script), ...extra, ...args], env: childEnv, dataDir: dir, dataSource: source });

  switch (command) {
    case 'setup': return node('hooks/setup-wizard.js');
    case 'set-password': return node('scripts/set-password.mjs');
    case 'install-hooks': return node('hooks/install-hooks.js');
    case 'uninstall-hooks': return node('hooks/install-hooks.js', ['--uninstall']);
    case 'install-service':
    case 'uninstall-service': {
      if (isSourceCheckout(projectRoot)) {
        throw new Error(`${command} runs from an installed package, not a git checkout. Install it with npm first.`);
      }
      const admin = join(projectRoot, 'dist', 'cli', 'admin.cjs');
      if (!existsSync(admin)) throw new Error(`${admin} is missing. This install is incomplete; reinstall it.`);
      return { command: process.execPath, args: [admin, command, '--data-dir', dir, ...args], env: childEnv, dataDir: dir, dataSource: source };
    }
    case 'pair':
    case 'devices':
    case 'status':
    case 'doctor':
    case 'logs':
    case 'share-default': {
      // A checkout runs the sources with tsx (development); a package runs the bundle.
      if (isSourceCheckout(projectRoot)) {
        return { command: tsxBin(projectRoot), args: [join(projectRoot, 'cli', 'server', 'index.ts'), command, '--data-dir', dir, ...args], env: childEnv, dataDir: dir, dataSource: source };
      }
      const admin = join(projectRoot, 'dist', 'cli', 'admin.cjs');
      if (!existsSync(admin)) throw new Error(`${admin} is missing. This install is incomplete; reinstall it.`);
      return { command: process.execPath, args: [admin, command, '--data-dir', dir, ...args], env: childEnv, dataDir: dir, dataSource: source };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
