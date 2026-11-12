/**
 * `aasc-server install-service` / `uninstall-service` (terminal-editions plan §7.4–7.5): run the
 * headless server as a systemd USER unit, as the user whose ~/.claude and ~/.codex the agents use.
 *
 * Every system command is an argument array handed to `deps.run` (execFile in production, a recorder
 * in tests), never a shell string. The unit file is written to a temporary file and renamed over.
 */
import { accessSync, constants, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { z } from 'zod';
import type { LockRecord } from '../../server/instanceLock.js';

export const UNIT_NAME = 'aasc-server';

/** The tools a session needs, looked up on the CURRENT shell's PATH: systemd reads no ~/.bashrc or nvm. */
const SERVICE_TOOLS = ['node', 'claude', 'codex', 'jq', 'git', 'tailscale'] as const;
type ServiceTool = (typeof SERVICE_TOOLS)[number];
const SYSTEM_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];

const HEALTH_POLL_MS = 500;

export function unitPath(home: string, env: NodeJS.ProcessEnv): string {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(config, 'systemd', 'user', `${UNIT_NAME}.service`);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface CapturedPath {
  /** The PATH the unit gets: the found tools' folders, then every other absolute PATH entry, then the system folders. */
  path: string;
  found: Record<ServiceTool, string | null>;
  missing: ServiceTool[];
}

export function capturePath(pathEnv: string | undefined): CapturedPath {
  const dirs = (pathEnv ?? '').split(':').filter((d) => isAbsolute(d));
  const found = Object.fromEntries(SERVICE_TOOLS.map((tool) => {
    const dir = dirs.find((d) => isExecutableFile(join(d, tool)));
    return [tool, dir ? join(dir, tool) : null];
  })) as Record<ServiceTool, string | null>;
  const toolDirs = new Set(Object.values(found).filter((p): p is string => p !== null).map((p) => dirname(p)));
  const ordered = [...new Set([...dirs.filter((d) => toolDirs.has(d)), ...dirs])];
  const path = [...ordered, ...SYSTEM_PATH.filter((d) => !ordered.includes(d))].join(':');
  return { path, found, missing: SERVICE_TOOLS.filter((t) => found[t] === null) };
}

const safeValue = z.string().min(1).refine((v) => !/[\n\r\0]/.test(v), 'must not contain a newline or NUL');
const absolutePath = safeValue.refine((v) => isAbsolute(v), 'must be an absolute path');
const UnitInputSchema = z.object({
  nodePath: absolutePath,
  cliPath: absolutePath,
  pathEnv: safeValue,
  dataDir: absolutePath,
});
export type UnitInput = z.infer<typeof UnitInputSchema>;

/** A double-quoted systemd value: C escapes, `%` specifiers doubled, and `$` doubled where expanded. */
function quote(value: string, { expandsDollar }: { expandsDollar: boolean }): string {
  let escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (expandsDollar) escaped = escaped.replace(/\$/g, '$$$$');
  return `"${escaped}"`;
}

export function buildUnit(input: UnitInput): string {
  const { nodePath, cliPath, pathEnv, dataDir } = UnitInputSchema.parse(input);
  return [
    '# Written by `aasc-server install-service`; `aasc-server uninstall-service` removes it.',
    '[Unit]',
    'Description=AI Agent Session Center (headless)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quote(nodePath, { expandsDollar: true })} ${quote(cliPath, { expandsDollar: true })} serve`,
    `Environment=${quote(`PATH=${pathEnv}`, { expandsDollar: false })}`,
    `Environment=${quote(`APP_USER_DATA=${dataDir}`, { expandsDollar: false })}`,
    'WorkingDirectory=%h',
    'Restart=on-failure',
    // A config refusal (78, EX_CONFIG: no password, unsafe queue folder), a held lock (3) or a busy
    // port (4) won't fix itself: no retry loop. 1 and a crash (128 + signal) are restarted.
    'RestartPreventExitStatus=78 3 4',
    'RestartSec=3',
    // Time for gracefulShutdown to save the snapshot and close the database.
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

interface UnitFs {
  mkdirSync(path: string, options: { recursive: true }): unknown;
  writeFileSync(path: string, data: string, options: { mode: number }): void;
  renameSync(from: string, to: string): void;
}

export function writeUnitAtomic(path: string, text: string, fs: UnitFs = { mkdirSync, writeFileSync, renameSync }): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o644 });
  fs.renameSync(tmp, path);
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface ServiceDeps {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  user: string;
  nodePath: string;
  cliPath: string;
  dataDir: string;
  port: number;
  run(command: string, args: string[]): Promise<RunResult>;
  /** `<dataDir>/server.lock`, or null. */
  readServerLock(dataDir: string): LockRecord | null;
  pidAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  healthTimeoutMs: number;
}

function requireLinux(deps: ServiceDeps): boolean {
  if (deps.platform === 'linux') return true;
  deps.out('install-service and uninstall-service need Linux with systemd. On this machine, run `aasc-server serve` yourself.');
  return false;
}

async function step(deps: ServiceDeps, command: string, args: string[]): Promise<boolean> {
  const result = await deps.run(command, args);
  if (result.code === 0) return true;
  deps.out(`✗ ${command} ${args.join(' ')} failed (exit ${result.code})${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return false;
}

/**
 * Up means OUR server: the unit is active and the data folder's lock names a live headless server that
 * is listening. An HTTP answer alone could be the desktop app, or the old version before the restart.
 */
async function isServiceUp(deps: ServiceDeps): Promise<boolean> {
  const active = await deps.run('systemctl', ['--user', 'is-active', '--quiet', UNIT_NAME]);
  if (active.code !== 0) return false;
  const lock = deps.readServerLock(deps.dataDir);
  return lock !== null && lock.edition === 'headless' && lock.listening === true && deps.pidAlive(lock.pid);
}

async function waitHealthy(deps: ServiceDeps): Promise<boolean> {
  for (let waited = 0; waited < deps.healthTimeoutMs; waited += HEALTH_POLL_MS) {
    if (await isServiceUp(deps)) return true;
    await deps.sleep(HEALTH_POLL_MS);
  }
  return false;
}

export async function installService(deps: ServiceDeps): Promise<number> {
  if (!requireLinux(deps)) return 1;

  const captured = capturePath(deps.env.PATH);
  if (captured.found.claude === null) {
    deps.out('! claude is not on this shell\'s PATH, so no session can start from the service. Install it, or run install-service from a shell where `claude` works.');
  }
  if (captured.missing.length > 0) deps.out(`! not on PATH: ${captured.missing.join(', ')}`);

  const path = unitPath(deps.home, deps.env);
  writeUnitAtomic(path, buildUnit({ nodePath: deps.nodePath, cliPath: deps.cliPath, pathEnv: captured.path, dataDir: deps.dataDir }));
  deps.out(`✓ wrote ${path}`);

  if (!await step(deps, 'systemctl', ['--user', 'daemon-reload'])) return 1;
  if (!await step(deps, 'systemctl', ['--user', 'enable', '--now', UNIT_NAME])) return 1;
  // enable --now leaves an already-active unit running the old version: restart it on the new one.
  if (!await step(deps, 'systemctl', ['--user', 'restart', UNIT_NAME])) return 1;

  const linger = await deps.run('loginctl', ['enable-linger', deps.user]);
  if (linger.code !== 0) {
    deps.out(`! Couldn't keep the service running after you log out. Run: sudo loginctl enable-linger ${deps.user}`);
  }

  if (await waitHealthy(deps)) {
    deps.out(`✓ Running. Logs: journalctl --user -u ${UNIT_NAME} -f`);
    return 0;
  }
  deps.out(`✗ The service isn't up on port ${deps.port} within ${Math.round(deps.healthTimeoutMs / 1000)} s. Last log lines:`);
  const journal = await deps.run('journalctl', ['--user', '-u', UNIT_NAME, '-n', '20', '--no-pager']);
  for (const line of (journal.stdout || journal.stderr).trimEnd().split('\n')) deps.out(`  ${line}`);
  return 1;
}

/** Reverses install-service's unit and enablement; linger and the data folder are left alone. */
export async function uninstallService(deps: ServiceDeps): Promise<number> {
  if (!requireLinux(deps)) return 1;
  // Not fatal: the unit may already be stopped or was never enabled.
  await step(deps, 'systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  const path = unitPath(deps.home, deps.env);
  try {
    unlinkSync(path);
    deps.out(`✓ removed ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!await step(deps, 'systemctl', ['--user', 'daemon-reload'])) return 1;
  deps.out(`✓ ${UNIT_NAME} uninstalled. Your data in ${deps.dataDir} is unchanged.`);
  return 0;
}
