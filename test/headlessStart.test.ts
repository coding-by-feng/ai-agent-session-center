// test/headlessStart.test.ts — how `aasc-server serve` starts (terminal-editions plan §7.1, §14).
//
// Three layers:
//   1. bin/cliPlan.js: the subcommand router and the headless environment it hands the server.
//   2. server/startupGuard.ts: the password rule (D9), the folder lock, the machine lock and the
//      queue-folder ownership check, with liveness injected.
//   3. The built bundle (dist/server-bundle.cjs) started as a child process.
//
// Layer 3 starts real servers, so each one gets a temporary HOME, APP_USER_DATA, XDG_CONFIG_HOME and
// AASC_TEST_QUEUE_DIR and a random free port. Without HOME the server would install hooks into the
// developer's real ~/.claude; without AASC_TEST_QUEUE_DIR it would consume live sessions' hook events
// from /tmp/claude-session-center. Every child is started with AASC_NO_PORT_KILL=1, so no path in it
// can kill a port holder, and phone pairing is off so it advertises nothing on the LAN.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'net';
import { scryptSync, randomBytes } from 'crypto';
import { createRequire } from 'module';
import { parseCli, planServe, exitStatus } from '../bin/cliPlan.js';
import { guardStartup, StartupError, EXIT_CODES } from '../server/startupGuard.js';
import { readLock } from '../server/instanceLock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'server-bundle.cjs');
const require = createRequire(import.meta.url);

// Any real signal other than the liveness probe (signal 0) fails the test instead of reaching a process.
// Children are stopped through ChildProcess.kill, which signals only our own child.
const realProcessKill = process.kill.bind(process);
const killGuard = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`headlessStart.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `aasc-${prefix}-`));
  scratchDirs.push(d);
  return d;
}

afterAll(() => {
  killGuard.mockRestore();
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. bin/cliPlan.js
// ---------------------------------------------------------------------------

describe('parseCli', () => {
  it('runs serve when no subcommand is given, and keeps the legacy flags working', () => {
    expect(parseCli([])).toEqual({ command: 'serve', rest: [], setup: false });
    expect(parseCli(['--port', '4000'])).toEqual({ command: 'serve', rest: ['--port', '4000'], setup: false });
    expect(parseCli(['serve', '--no-open'])).toEqual({ command: 'serve', rest: ['--no-open'], setup: false });
    expect(parseCli(['--setup'])).toEqual({ command: 'serve', rest: [], setup: true });
    expect(parseCli(['--uninstall'])).toEqual({ command: 'uninstall-hooks', rest: [], setup: false });
  });

  it('names each P1 and P2 subcommand, and flags an unknown one', () => {
    for (const c of ['setup', 'set-password', 'install-service', 'uninstall-service', 'install-hooks', 'uninstall-hooks', 'help',
      'pair', 'devices', 'status', 'doctor', 'logs', 'share-default']) {
      expect(parseCli([c, '-x']).command).toBe(c);
    }
    expect(parseCli(['--help']).command).toBe('help');
    expect(parseCli(['frobnicate']).command).toBe('unknown');
  });
});

describe('exitStatus', () => {
  it("passes a child's exit code on, and turns a signal into 128 + its number so systemd still restarts a crash", () => {
    expect(exitStatus(0, null)).toBe(0);
    expect(exitStatus(78, null)).toBe(78);
    expect(exitStatus(null, 'SIGKILL')).toBe(137);
    expect(exitStatus(null, 'SIGTERM')).toBe(143);
    expect(exitStatus(null, null)).toBe(1);
  });
});

describe('bin/cli.js passes on how the server ended', () => {
  // A throwaway package: the real bin/ and hooks/dataDir.js, and a fake "bundle" that ends as told.
  function fakeInstall(bundle: string): { cli: string; dataDir: string } {
    const root = scratch('wrap');
    for (const d of ['bin', 'hooks', 'dist']) mkdirSync(join(root, d), { recursive: true });
    for (const f of ['cli.js', 'cliPlan.js']) writeFileSync(join(root, 'bin', f), readFileSync(join(ROOT, 'bin', f)));
    writeFileSync(join(root, 'hooks', 'dataDir.js'), readFileSync(join(ROOT, 'hooks', 'dataDir.js')));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'dist', 'server-bundle.cjs'), bundle);
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'server-config.json'), '{}');
    return { cli: join(root, 'bin', 'cli.js'), dataDir };
  }
  const env = { PATH: process.env.PATH, HOME: tmpdir() };

  it('exits with the server exit code (78 is not restarted by systemd)', () => {
    const { cli, dataDir } = fakeInstall('process.exit(78)');
    expect(spawnSync(process.execPath, [cli, 'serve', '--data-dir', dataDir], { env }).status).toBe(78);
  });

  it('dies of the same signal when the server is killed, so systemd restarts a crash', () => {
    const { cli, dataDir } = fakeInstall("process.kill(process.pid, 'SIGKILL')");
    const r = spawnSync(process.execPath, [cli, 'serve', '--data-dir', dataDir], { env });
    expect(r.status).toBeNull();
    expect(r.signal).toBe('SIGKILL');
  });

  it('exits 64 (EX_USAGE) on an unknown command, and shows the usage', () => {
    const { cli } = fakeInstall('');
    const r = spawnSync(process.execPath, [cli, 'frobnicate'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r.status).toBe(64);
    expect(String(r.stderr)).toMatch(/unknown command "frobnicate"[\s\S]*Usage: aasc-server/);
  });

  it('exits 78 when there is no config and no terminal for the wizard', () => {
    const { cli } = fakeInstall('');
    const r = spawnSync(process.execPath, [cli, 'serve', '--data-dir', scratch('nocfg')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(r.status).toBe(78);
    expect(String(r.stderr)).toMatch(/aasc-server setup/);
  });
});

describe('planServe', () => {
  function fakePackage(): string {
    const root = scratch('pkg');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'server-bundle.cjs'), '');
    return root;
  }
  function fakeCheckout(): string {
    const root = scratch('checkout');
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'server'), { recursive: true });
    writeFileSync(join(root, 'server', 'index.ts'), '');
    return root;
  }

  it('runs the bundle with node from a package, with the headless environment', () => {
    const root = fakePackage();
    const plan = planServe({ projectRoot: root, rest: ['--port', '4100'], env: { XDG_CONFIG_HOME: '/xdg', PATH: '/bin' }, platform: 'linux', home: '/h' });
    expect(plan.mode).toBe('package');
    expect(plan.command).toBe(process.execPath);
    expect(plan.args).toEqual([join(root, 'dist', 'server-bundle.cjs'), '--port', '4100', '--no-open']);
    expect(plan.dataDir).toBe('/xdg/ai-agent-session-center');
    expect(plan.env).toMatchObject({
      PATH: '/bin', APP_USER_DATA: '/xdg/ai-agent-session-center', AASC_HEADLESS: '1', AASC_NO_PORT_KILL: '1',
    });
    expect(plan.env.ELECTRON).toBeUndefined();
  });

  it('passes --allow-second-server through and consumes --data-dir', () => {
    const root = fakePackage();
    const plan = planServe({ projectRoot: root, rest: ['--data-dir', '/d', '--allow-second-server', '--no-open'], env: {}, platform: 'linux', home: '/h' });
    expect(plan.args).toEqual([join(root, 'dist', 'server-bundle.cjs'), '--allow-second-server', '--no-open']);
    expect(plan.env.APP_USER_DATA).toBe('/d');
  });

  it('never inherits ELECTRON, which would stop the server starting itself', () => {
    const plan = planServe({ projectRoot: fakePackage(), rest: [], env: { ELECTRON: '1' }, platform: 'linux', home: '/h' });
    expect(plan.env.ELECTRON).toBeUndefined();
  });

  it('runs tsx in a checkout and leaves APP_USER_DATA unset so <repo>/data keeps its layout', () => {
    const root = fakeCheckout();
    const plan = planServe({ projectRoot: root, rest: [], env: {}, platform: 'linux', home: '/h' });
    expect(plan.mode).toBe('checkout');
    expect(plan.args[0]).toBe(join(root, 'server', 'index.ts'));
    expect(plan.dataDir).toBe(join(root, 'data'));
    expect(plan.env.APP_USER_DATA).toBeUndefined();
    expect(plan.env.AASC_HEADLESS).toBe('1');
  });

  it('asks for the setup wizard when the data folder has no server-config.json', () => {
    const root = fakePackage();
    const dataDir = scratch('data');
    expect(planServe({ projectRoot: root, rest: ['--data-dir', dataDir], env: {}, platform: 'linux', home: '/h' }).needsSetup).toBe(true);
    writeFileSync(join(dataDir, 'server-config.json'), '{}');
    expect(planServe({ projectRoot: root, rest: ['--data-dir', dataDir], env: {}, platform: 'linux', home: '/h' }).needsSetup).toBe(false);
  });

  it('fails clearly when a package has no bundle', () => {
    const root = scratch('empty');
    expect(() => planServe({ projectRoot: root, rest: [], env: {}, platform: 'linux', home: '/h' })).toThrow(/server-bundle\.cjs/);
  });
});

// ---------------------------------------------------------------------------
// 2. server/startupGuard.ts
// ---------------------------------------------------------------------------

describe('guardStartup', () => {
  const uid = process.getuid?.() ?? 0;
  const base = (over: Partial<Parameters<typeof guardStartup>[0]> = {}) => ({
    port: 45001,
    edition: 'headless' as const,
    dataDir: scratch('gdata'),
    queueDir: join(scratch('gqueue'), 'q'),
    passwordSet: true,
    allowSecondServer: false,
    uid,
    isLive: async () => true,
    ...over,
  });
  async function expectExit(p: Promise<unknown>, code: number, message: RegExp): Promise<void> {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect((err as StartupError).exitCode).toBe(code);
    expect((err as StartupError).message).toMatch(message);
  }

  it('uses EX_CONFIG for refusals that need the user, and 1 only for plain failures', () => {
    expect(EXIT_CODES).toEqual({ FAILURE: 1, LOCKED: 3, PORT_BUSY: 4, CONFIG: 78 });
  });

  it('refuses a headless start with no password (D9), naming the command', async () => {
    await expectExit(guardStartup(base({ passwordSet: false })), 78, /aasc-server set-password/);
  });

  it('lets the desktop and a dev server start with no password, as today', async () => {
    const locks = await guardStartup(base({ passwordSet: false, edition: 'desktop' }));
    locks.release();
  });

  it('takes both locks, records the bound address once listening, and releases them', async () => {
    const input = base();
    const locks = await guardStartup(input);
    expect(readLock(join(input.dataDir, 'server.lock'))).toMatchObject({ pid: process.pid, port: 45001, edition: 'headless' });
    expect(readLock(join(input.dataDir, 'server.lock'))?.listening).toBeUndefined();
    locks.markListening('100.64.0.7');
    expect(readLock(join(input.dataDir, 'server.lock'))).toMatchObject({ listening: true, bindAddress: '100.64.0.7' });
    expect(readLock(join(input.queueDir, 'server.lock'))).toMatchObject({ listening: true, bindAddress: '100.64.0.7' });
    expect(readLock(join(input.queueDir, 'server.lock'))).toMatchObject({ pid: process.pid, edition: 'headless' });
    locks.release();
    expect(existsSync(join(input.dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(input.queueDir, 'server.lock'))).toBe(false);
  });

  it('refuses a live holder of the folder in every edition (exit 3)', async () => {
    for (const edition of ['headless', 'desktop', 'dev'] as const) {
      const input = base({ edition });
      writeFileSync(join(input.dataDir, 'server.lock'), JSON.stringify({ pid: 4121, port: 3333, edition: 'desktop', startedAt: 1, dataDir: input.dataDir }));
      await expectExit(guardStartup(input), 3, /already running on this folder \(pid 4121, :3333\)/);
    }
  });

  it('refuses another server on the machine only when headless, unless --allow-second-server', async () => {
    const queueDir = join(scratch('gq2'), 'q');
    mkdirSync(queueDir, { mode: 0o700 });
    const other = { pid: 4122, port: 3333, edition: 'desktop', startedAt: 1, dataDir: '/elsewhere' };
    writeFileSync(join(queueDir, 'server.lock'), JSON.stringify(other));

    const headless = base({ queueDir });
    await expectExit(guardStartup(headless), 3, /another AASC server.*pid 4122.*--allow-second-server/s);
    // The refusal also gave back the folder lock it had taken.
    expect(existsSync(join(headless.dataDir, 'server.lock'))).toBe(false);

    const allowed = await guardStartup(base({ queueDir, allowSecondServer: true }));
    allowed.release();

    const desktop = await guardStartup(base({ queueDir, edition: 'desktop' }));
    // The desktop leaves a live holder's record alone, so a later aasc-server still sees it.
    expect(readLock(join(queueDir, 'server.lock'))).toEqual(other);
    desktop.release();
    expect(readLock(join(queueDir, 'server.lock'))).toEqual(other);
  });

  it('refuses an unsafe queue folder before trusting the machine lock (exit 78)', async () => {
    const parent = scratch('gq3');
    mkdirSync(join(parent, 'real'), { mode: 0o700 });
    const queueDir = join(parent, 'q');
    symlinkSync(join(parent, 'real'), queueDir);
    const input = base({ queueDir });
    await expectExit(guardStartup(input), 78, /hook queue folder.*symlink/);
    expect(existsSync(join(input.dataDir, 'server.lock'))).toBe(false);
    // The desktop keeps today's behaviour: it doesn't check.
    (await guardStartup(base({ queueDir, edition: 'desktop' }))).release();
  });
});

// ---------------------------------------------------------------------------
// 3. The bundle, as a child process
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function passwordHash(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

interface Box { home: string; xdg: string; dataDir: string; queueDir: string }
function makeBox(opts: { password?: boolean; dataDir?: string; queueDir?: string } = {}): Box {
  const root = scratch('box');
  const box = {
    home: join(root, 'home'),
    xdg: join(root, 'xdg'),
    dataDir: opts.dataDir ?? join(root, 'data'),
    queueDir: opts.queueDir ?? join(root, 'queue'),
  };
  for (const d of [box.home, box.xdg, box.dataDir]) mkdirSync(d, { recursive: true });
  const cfg = { port: 1, enabledClis: ['claude'], ...(opts.password === false ? {} : { passwordHash: passwordHash('Aa1!aaaaaa') }) };
  if (!existsSync(join(box.dataDir, 'server-config.json'))) writeFileSync(join(box.dataDir, 'server-config.json'), JSON.stringify(cfg));
  return box;
}

interface Run { child: ChildProcess; output: () => string; exited: Promise<number | null> }
const running: Run[] = [];

/**
 * The runtime that can load this checkout's native modules. `npm install` rebuilds better-sqlite3 for
 * Electron's ABI (postinstall), so on a developer's machine plain Node often can't open the database;
 * Electron run as Node can, and it is the runtime the desktop runs this very bundle in.
 */
interface Runtime { command: string; env: NodeJS.ProcessEnv }
let runtime: Runtime | null = null;
function pickRuntime(): Runtime {
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

function startBundle(box: Box, port: number, extraArgs: string[] = []): Run {
  const env: NodeJS.ProcessEnv = {
    ...runtime!.env,
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
  };
  const child = spawn(runtime!.command, [BUNDLE, '--no-open', ...extraArgs], { env, cwd: box.home, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr!.on('data', (b: Buffer) => { out += b.toString(); });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const run = { child, output: () => out, exited };
  running.push(run);
  return run;
}

async function waitReady(run: Run, port: number, timeoutMs = 40_000): Promise<void> {
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

async function stop(run: Run): Promise<void> {
  if (run.child.exitCode !== null || run.child.signalCode !== null) return;
  run.child.kill('SIGTERM');
  const timer = setTimeout(() => run.child.kill('SIGKILL'), 10_000);
  await run.exited;
  clearTimeout(timer);
}

describe('the bundle, started headless', () => {
  beforeAll(() => {
    // The same build the desktop ships (npm run build:server); it writes only dist/server-bundle.cjs.
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs')], { cwd: ROOT, stdio: 'pipe' });
    runtime = pickRuntime();
  }, 120_000);

  afterEach(async () => {
    await Promise.all(running.splice(0).map(stop));
  }, 30_000);

  it('starts on a temporary folder and port, answers /api/auth/status, and cleans its locks on SIGTERM', async () => {
    const box = makeBox();
    const port = await freePort();
    const run = startBundle(box, port);
    await waitReady(run, port);
    const status = await (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).json();
    expect(status).toMatchObject({ passwordRequired: true, authenticated: false });
    expect(readLock(join(box.dataDir, 'server.lock'))).toMatchObject({ pid: run.child.pid, port, edition: 'headless', listening: true });
    expect(readLock(join(box.queueDir, 'server.lock'))).toMatchObject({ pid: run.child.pid });
    // Hooks went into the temporary HOME, never the developer's.
    expect(existsSync(join(box.home, '.claude'))).toBe(true);
    // The session snapshot lives in the data folder, not the shared queue folder (§7.1).
    await stop(run);
    expect(existsSync(join(box.dataDir, 'data', 'sessions-snapshot.json'))).toBe(true);
    expect(existsSync(join(box.dataDir, 'server.lock'))).toBe(false);
    expect(existsSync(join(box.queueDir, 'server.lock'))).toBe(false);
  }, 60_000);

  it('exits 78 with the set-password hint when no password is set (D9)', async () => {
    const run = startBundle(makeBox({ password: false }), await freePort());
    expect(await run.exited).toBe(78);
    expect(run.output()).toMatch(/aasc-server set-password/);
  }, 60_000);

  it('exits 3 on a second start on the same folder', async () => {
    const first = makeBox();
    const port = await freePort();
    const a = startBundle(first, port);
    await waitReady(a, port);
    // Same data folder, its own queue folder: the folder lock is what refuses it.
    const second = makeBox({ dataDir: first.dataDir });
    const b = startBundle(second, await freePort());
    expect(await b.exited).toBe(3);
    expect(b.output()).toMatch(new RegExp(`already running on this folder \\(pid ${a.child.pid}, :${port}\\)`));
    expect(a.child.exitCode).toBeNull();
  }, 90_000);

  it('exits 3 while another AASC server runs on the machine, unless --allow-second-server', async () => {
    const first = makeBox();
    const port = await freePort();
    const a = startBundle(first, port);
    await waitReady(a, port);
    // Another data folder, the same hook-queue folder.
    const b = startBundle(makeBox({ queueDir: first.queueDir }), await freePort());
    expect(await b.exited).toBe(3);
    expect(b.output()).toMatch(/another AASC server is running on this machine/);

    const port3 = await freePort();
    const c = startBundle(makeBox({ queueDir: first.queueDir }), port3, ['--allow-second-server']);
    await waitReady(c, port3);
  }, 120_000);

  it('takes over a stale lock left by a dead pid', async () => {
    const box = makeBox();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    expect(() => realProcessKill(dead, 0)).toThrow();
    writeFileSync(join(box.dataDir, 'server.lock'), JSON.stringify({ pid: dead, port: 1, edition: 'headless', startedAt: 1, dataDir: box.dataDir }));
    const port = await freePort();
    const run = startBundle(box, port);
    await waitReady(run, port);
    expect(JSON.parse(readFileSync(join(box.dataDir, 'server.lock'), 'utf8')).pid).toBe(run.child.pid);
  }, 60_000);

  it('exits 4 on a busy port with AASC_NO_PORT_KILL, and the holder survives', async () => {
    const holder: Server = createServer((s) => s.end());
    await new Promise<void>((r) => holder.listen(0, r));
    const port = (holder.address() as { port: number }).port;
    try {
      const box = makeBox();
      const run = startBundle(box, port);
      expect(await run.exited).toBe(4);
      expect(run.output()).toMatch(new RegExp(`port ${port} is in use`));
      expect(holder.listening).toBe(true);
      // An exit after the locks were taken gives them back.
      expect(existsSync(join(box.dataDir, 'server.lock'))).toBe(false);
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
  }, 60_000);
});
