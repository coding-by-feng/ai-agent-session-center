// test/helpers/headlessBundle.ts — start the built server bundle as a sealed child process.
//
// The same rules as test/headlessStart.test.ts (§14 of the terminal-editions plan), shared by the
// P2 tests that need a real server: a temporary HOME, XDG_CONFIG_HOME, APP_USER_DATA and
// AASC_TEST_QUEUE_DIR, a random free port, AASC_NO_PORT_KILL=1 (no path can kill a port holder) and
// phone pairing off (nothing is advertised on the LAN). Without HOME the server would install hooks
// into the developer's ~/.claude; without AASC_TEST_QUEUE_DIR it would eat live sessions' hook events.
//
// Each test file builds its own copy of the bundle beside dist/server-bundle.cjs (same folder, so
// every __dirname-relative path is the same), because test files run in parallel and two builds
// writing one file would hand a child a half-written bundle.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'net';
import { scryptSync, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { vi } from 'vitest';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

/** Any real signal other than the liveness probe (signal 0) throws instead of reaching a process. */
export function installKillGuard(name: string): () => void {
  const realProcessKill = process.kill.bind(process);
  const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0) return realProcessKill(pid, 0);
    throw new Error(`${name} must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
  }) as typeof process.kill);
  return () => spy.mockRestore();
}

const scratchDirs: string[] = [];
export function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `aasc-${prefix}-`));
  scratchDirs.push(d);
  return d;
}
export function cleanScratch(): void {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function passwordHash(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export interface Box { home: string; xdg: string; dataDir: string; queueDir: string }
export function makeBox(config: Record<string, unknown> = {}): Box {
  const root = scratch('box');
  const box = { home: join(root, 'home'), xdg: join(root, 'xdg'), dataDir: join(root, 'data'), queueDir: join(root, 'queue') };
  for (const d of [box.home, box.xdg]) mkdirSync(d, { recursive: true });
  mkdirSync(box.dataDir, { recursive: true, mode: 0o700 });
  const cfg = { port: 1, enabledClis: ['claude'], passwordHash: passwordHash('Aa1!aaaaaa'), ...config };
  if (!existsSync(join(box.dataDir, 'server-config.json'))) writeFileSync(join(box.dataDir, 'server-config.json'), JSON.stringify(cfg));
  return box;
}

/**
 * The runtime that can load this checkout's native modules. `npm install` rebuilds better-sqlite3 for
 * Electron's ABI, so plain Node often can't open the database; Electron run as Node can.
 */
export interface Runtime { command: string; env: NodeJS.ProcessEnv }
export function pickRuntime(): Runtime {
  const probe = "new (require('better-sqlite3'))(':memory:').close()";
  const candidates: Runtime[] = [{ command: process.execPath, env: {} }];
  try {
    candidates.push({ command: require('electron') as unknown as string, env: { ELECTRON_RUN_AS_NODE: '1' } });
  } catch { /* electron not installed */ }
  for (const c of candidates) {
    const r = spawnSync(c.command, ['-e', probe], { cwd: ROOT, env: { PATH: process.env.PATH, ...c.env }, timeout: 30_000 });
    if (r.status === 0) return c;
  }
  throw new Error('No runtime here can load better-sqlite3 (tried node and electron as node)');
}

/** Build this file's own bundle: dist/server-bundle.<tag>.cjs. Returns its path. */
export async function buildBundle(tag: string): Promise<string> {
  const { build } = await import('esbuild');
  const { serverBuildOptions } = await import('../../scripts/build-server.mjs');
  const outfile = join(ROOT, 'dist', `server-bundle.${tag}.cjs`);
  await build({ ...serverBuildOptions, absWorkingDir: ROOT, outfile, logLevel: 'silent' });
  return outfile;
}

export interface Run { child: ChildProcess; output: () => string; exited: Promise<number | null> }

export function startBundle(
  bundle: string,
  runtime: Runtime,
  box: Box,
  port: number,
  { env: extraEnv = {}, args = [] }: { env?: NodeJS.ProcessEnv; args?: string[] } = {},
): Run {
  const env: NodeJS.ProcessEnv = {
    ...runtime.env,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: box.home,
    XDG_CONFIG_HOME: box.xdg,
    APP_USER_DATA: box.dataDir,
    AASC_TEST_QUEUE_DIR: box.queueDir,
    AASC_HEADLESS: '1',
    AASC_NO_PORT_KILL: '1',
    AASC_PHONE_PAIRING: '0',
    PORT: String(port),
    ...extraEnv,
  };
  const child = spawn(runtime.command, [bundle, '--no-open', ...args], { env, cwd: box.home, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, output: () => out, exited };
}

export async function waitReady(run: Run, port: number, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) throw new Error(`server exited ${run.child.exitCode}:\n${run.output()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never answered:\n${run.output()}`);
}

/** Stop our own child: ChildProcess.kill signals only it. */
export async function stop(run: Run): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill('SIGTERM');
  const timer = setTimeout(() => run.child.kill('SIGKILL'), 10_000);
  await run.exited;
  clearTimeout(timer);
}
