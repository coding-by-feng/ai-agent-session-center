/**
 * `aasc-server doctor` (terminal-editions plan §8.5): local probes of what a headless server needs,
 * each with the fix it prints. Nothing here talks to the server's API or changes anything; every
 * system command is an argument array handed to `deps.run` (execFile, or a recorder in tests).
 *
 * Exit 0 when nothing failed (warnings allowed), else 1.
 */
import { existsSync, lstatSync, readFileSync } from 'fs';
import { connect } from 'net';
import { join } from 'path';
import { isLockLive, readLock, type LockRecord } from '../../server/instanceLock.js';
import { EXIT, readConfig } from './http.js';
import { unitPath, type RunResult } from './service.js';
import type { CliAuthInfo, CliAuthReport } from '../../src/types/cliAuth.js';

export type CheckState = 'ok' | 'warn' | 'fail';
export interface CheckResult { state: CheckState; name: string; detail: string; fix?: string }

/** The minimum the bundle and `engines` ask for. */
const MIN_NODE: [number, number] = [22, 12];

// ---------------------------------------------------------------------------
// Probes shared with `status`
// ---------------------------------------------------------------------------

/** Which enabled CLIs have the dashboard hook installed in this user's home. */
export function hookState(home: string, enabledClis: readonly string[]): Record<string, boolean> {
  const read = (path: string) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  const out: Record<string, boolean> = {};
  if (enabledClis.includes('claude')) {
    out.claude = existsSync(join(home, '.claude', 'hooks', 'dashboard-hook.sh'))
      && read(join(home, '.claude', 'settings.json')).includes('dashboard-hook');
  }
  if (enabledClis.includes('codex')) {
    out.codex = existsSync(join(home, '.codex', 'hooks', 'dashboard-hook.sh'))
      && read(join(home, '.codex', 'config.toml')).includes('dashboard-hook');
  }
  return out;
}

export type CloudCredential = 'none' | 'readable' | 'encrypted' | 'damaged';

/**
 * The AASC Cloud device token as the headless server would read it (runbook §15). With a keyring,
 * the desktop encrypts it with Electron's safeStorage (cloud/secretStore.ts) and stores the bytes in
 * base64; headless reads the same file as plaintext JSON (index.ts openCloudConnection) and can't.
 * Neither edition can read the other's, so after a swap the owner must reconnect.
 */
export function cloudCredential(dataDir: string): CloudCredential {
  let saved: { connection?: unknown; secretRef?: unknown };
  try {
    saved = JSON.parse(readFileSync(join(dataDir, 'cloud', 'connection.json'), 'utf8'));
  } catch {
    return 'none';
  }
  if (!saved.connection || typeof saved.secretRef !== 'string' || !/^[0-9a-f-]{36}$/i.test(saved.secretRef)) return 'none';
  let secret: string;
  try {
    secret = readFileSync(join(dataDir, 'cloud', 'secrets', saved.secretRef), 'utf8');
  } catch {
    return 'damaged';
  }
  try {
    JSON.parse(secret);
    return 'readable';
  } catch {
    // Not JSON: base64 ciphertext written by the desktop's encrypted store.
    return /^[A-Za-z0-9+/=\s]+$/.test(secret) ? 'encrypted' : 'damaged';
  }
}

export const CLOUD_RECONNECT = 'reconnect AASC Cloud: its saved sign-in was encrypted by the desktop app, which this server can\'t read. Connect again from RESOURCES ▸ Cloud in a browser.';

/** Said by status and doctor: what pauses when no dashboard is open (§11). */
export const AUTOMATION_NOTE = 'The prompt queue, loops and auto-resume run only in a connected dashboard (a browser, the desktop app or the phone). With none open they pause; sessions and hooks keep running.';

function portAnswers(port: number, host = '127.0.0.1', timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (answered: boolean) => { socket.destroy(); resolve(answered); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  dataDir: string;
  /** The installed package's folder: where `npm rebuild` must run. */
  packageRoot: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  user: string;
  uid: number | null;
  nodeVersion: string;
  port: number;
  run(command: string, args: string[]): Promise<RunResult>;
  /** require() from the package, for the native modules. */
  load(name: string): unknown;
  /** node-pty's spawn-helper, or null where there is none (Windows, or node-pty missing). */
  spawnHelperPath(): string | null;
  readServerLock(): LockRecord | null;
  lockLive(record: LockRecord): Promise<boolean>;
  portAnswers(port: number): Promise<boolean>;
  /** The running server's reading of the CLIs' sign-in (GET /api/cli-auth); null when it can't be asked. */
  cliAuth?: () => Promise<CliAuthReport | null>;
  out(line: string): void;
}

/** How to log in, in every edition: setup's offer, any dashboard's strip, or the CLI itself on the box. */
/** Each CLI's login line on a headless machine (Codex shows a code to type on another device). */
const LOGIN_LINE: Record<CliAuthInfo['cli'], string> = { claude: 'claude auth login', codex: 'codex login --device-auth' };

export function loginFix(cli: CliAuthInfo['cli']): string {
  return `press Log in in any dashboard (a phone works), rerun \`aasc-server setup\`, or run \`${LOGIN_LINE[cli]}\` in a terminal on this machine`;
}

/** One CLI's sign-in as a doctor row. */
export function loginCheck(info: CliAuthInfo): CheckResult {
  const name = `${info.cli} login`;
  switch (info.state) {
    case 'logged-in': return { state: 'ok', name, detail: `logged in${info.method ? ` (${info.method})` : ''}` };
    case 'logged-out': return { state: 'fail', name, detail: 'not logged in: its sessions will fail until it is', fix: loginFix(info.cli) };
    case 'missing': return { state: 'warn', name, detail: 'not installed' };
    default: return { state: 'warn', name, detail: `couldn't tell${info.detail ? `: ${info.detail}` : ''}` };
  }
}

function versionAtLeast(version: string, [major, minor]: [number, number]): boolean {
  const [a, b] = version.replace(/^v/, '').split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/** The PATH the systemd unit gives the server, or null when no unit is installed. */
function servicePath(deps: DoctorDeps): string | null {
  try {
    const unit = readFileSync(unitPath(deps.home, deps.env), 'utf8');
    const m = /^Environment="PATH=([^"\n]*)"$/m.exec(unit);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function onPath(tool: string, pathEnv: string): boolean {
  return pathEnv.split(':').some((dir) => dir.startsWith('/') && existsSync(join(dir, tool)));
}

function modeCheck(name: string, path: string, wanted: number, uid: number | null, kind: 'folder' | 'file'): CheckResult {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return { state: kind === 'file' ? 'warn' : 'fail', name, detail: `${path} is missing`, fix: kind === 'file' ? 'start the server: it writes a new one at every start' : 'run `aasc-server setup`' };
  }
  const isRightKind = kind === 'folder' ? st.isDirectory() : st.isFile();
  const mode = st.mode & 0o777;
  if (!isRightKind || st.isSymbolicLink()) return { state: 'fail', name, detail: `${path} is not a regular ${kind}`, fix: `remove it, then restart the server` };
  if (uid !== null && st.uid !== uid) return { state: 'fail', name, detail: `${path} belongs to another user`, fix: 'run the server as the user who owns its data folder' };
  if ((mode & 0o077) !== 0) return { state: 'fail', name, detail: `${path} is ${mode.toString(8)}`, fix: `chmod ${wanted.toString(8)} ${path}` };
  return { state: 'ok', name, detail: `${mode.toString(8)}` };
}

export async function runChecks(deps: DoctorDeps): Promise<CheckResult[]> {
  const config = readConfig(deps.dataDir);
  const enabled = Array.isArray(config.enabledClis) && config.enabledClis.length > 0 ? config.enabledClis : ['claude'];
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);
  const rebuild = (pkg: string) => `cd ${JSON.stringify(deps.packageRoot)} && npm rebuild ${pkg}`;

  add(versionAtLeast(deps.nodeVersion, MIN_NODE)
    ? { state: 'ok', name: 'Node', detail: deps.nodeVersion }
    : { state: 'fail', name: 'Node', detail: `${deps.nodeVersion}, needs ${MIN_NODE.join('.')} or newer`, fix: 'install Node 22 from NodeSource, or with nvm' });

  const jq = await deps.run('jq', ['--version']);
  add(jq.code === 0
    ? { state: 'ok', name: 'jq', detail: jq.stdout.trim() }
    : { state: 'fail', name: 'jq', detail: 'not on PATH: the hook script needs it', fix: 'sudo apt install jq' });

  const svcPath = servicePath(deps);
  const pathEnv = svcPath ?? deps.env.PATH ?? '';
  const where = svcPath !== null ? "the service's PATH" : 'PATH';
  for (const cli of enabled) {
    add(onPath(cli, pathEnv)
      ? { state: 'ok', name: cli, detail: `on ${where}` }
      : { state: 'fail', name: cli, detail: `not on ${where}: no ${cli} session can start`, fix: svcPath !== null ? `rerun \`aasc-server install-service\` from a shell where \`which ${cli}\` works` : `install ${cli}` });
  }

  try {
    deps.load('node-pty');
    const helper = deps.spawnHelperPath();
    let helperOk = true;
    if (helper) {
      try { helperOk = (lstatSync(helper).mode & 0o111) !== 0; } catch { helperOk = false; }
    }
    add(helperOk
      ? { state: 'ok', name: 'node-pty', detail: 'loads' }
      : { state: 'warn', name: 'node-pty', detail: 'spawn-helper is not executable (the server repairs this at start)', fix: rebuild('node-pty') });
  } catch (err) {
    add({ state: 'fail', name: 'node-pty', detail: `does not load: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, fix: rebuild('node-pty') });
  }

  try {
    const Database = deps.load('better-sqlite3') as new (path: string) => { close(): void };
    new Database(':memory:').close();
    add({ state: 'ok', name: 'better-sqlite3', detail: 'loads' });
  } catch (err) {
    add({ state: 'fail', name: 'better-sqlite3', detail: `does not load: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`, fix: rebuild('better-sqlite3') });
  }

  add(modeCheck('Data folder', deps.dataDir, 0o700, deps.uid, 'folder'));
  add(modeCheck('owner.token', join(deps.dataDir, 'owner.token'), 0o600, deps.uid, 'file'));

  add(config.passwordHash
    ? { state: 'ok', name: 'Password', detail: 'set' }
    : { state: 'fail', name: 'Password', detail: 'not set: a headless server refuses to start without one', fix: 'aasc-server set-password' });

  const lock = deps.readServerLock();
  if (lock && await deps.lockLive(lock)) {
    add({ state: 'ok', name: 'Port', detail: `${lock.port} held by this server (pid ${lock.pid})` });
  } else if (await deps.portAnswers(deps.port)) {
    add({ state: 'fail', name: 'Port', detail: `${deps.port} is in use by another program`, fix: 'stop the other server, or pick another with --port' });
  } else {
    add({ state: 'ok', name: 'Port', detail: `${deps.port} is free (the server isn't running)` });
  }

  const hooks = hookState(deps.home, enabled);
  const missing = Object.entries(hooks).filter(([, ok]) => !ok).map(([cli]) => cli);
  add(missing.length === 0
    ? { state: 'ok', name: 'Hooks', detail: Object.keys(hooks).join(', ') || 'none enabled' }
    : { state: 'fail', name: 'Hooks', detail: `not installed for ${missing.join(', ')}: no cards will appear`, fix: 'aasc-server install-hooks' });

  // Asked of the running server: it reads the sign-in in the environment the sessions run in (on macOS an
  // ssh shell may not reach the Keychain, and would say "logged out" when the server is fine).
  if (deps.cliAuth) {
    const report = await deps.cliAuth();
    if (report) report.clis.forEach((info) => add(loginCheck(info)));
    else add({ state: 'warn', name: 'Login', detail: 'start the server to check that claude / codex are logged in', fix: 'aasc-server status' });
  }

  if (deps.platform === 'linux') {
    const linger = await deps.run('loginctl', ['show-user', deps.user, '--property=Linger']);
    add(/Linger=yes/.test(linger.stdout)
      ? { state: 'ok', name: 'Linger', detail: 'on: the service survives logout' }
      : { state: 'warn', name: 'Linger', detail: 'off: the service stops when you log out', fix: `sudo loginctl enable-linger ${deps.user}` });
  }

  const tailscale = await deps.run('tailscale', ['ip', '-4']);
  add(tailscale.code === 0 && tailscale.stdout.trim()
    ? { state: 'ok', name: 'Tailscale', detail: `up, ${tailscale.stdout.trim().split('\n')[0]}` }
    : { state: 'warn', name: 'Tailscale', detail: 'not up (optional: the recommended way in)', fix: 'sudo tailscale up' });

  const cloud = cloudCredential(deps.dataDir);
  if (cloud === 'encrypted') add({ state: 'warn', name: 'AASC Cloud', detail: CLOUD_RECONNECT });
  else if (cloud === 'damaged') add({ state: 'warn', name: 'AASC Cloud', detail: 'its saved sign-in is damaged', fix: 'connect again from RESOURCES ▸ Cloud in a browser' });

  return results;
}

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', fail: '✗' };

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const results = await runChecks(deps);
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    deps.out(`${MARK[r.state]} ${r.name.padEnd(width)}  ${r.detail}`);
    if (r.fix && r.state !== 'ok') deps.out(`  ${' '.repeat(width)}  → ${r.fix}`);
  }
  deps.out('');
  deps.out(AUTOMATION_NOTE);
  return results.some((r) => r.state === 'fail') ? EXIT.FAILED : EXIT.OK;
}

/** Real probes for a doctor run (index.ts). */
export const realProbes = {
  lockLive: isLockLive,
  readServerLock: (dataDir: string) => readLock(join(dataDir, 'server.lock')),
  portAnswers: (port: number) => portAnswers(port),
};
