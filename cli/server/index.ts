/**
 * The admin CLI's entry, bundled to dist/cli/admin.cjs and run by bin/cli.js as
 * `node dist/cli/admin.cjs <command> --data-dir <folder> [args]` (in a checkout: tsx on this file).
 *
 *   install-service · uninstall-service       the systemd user unit (P1, service.ts)
 *   pair · devices · status · doctor · logs   the owner's commands on the box (P2)
 *   share-default                             share sessions started on the box (Oct 29 2026)
 *
 * The API commands authenticate with <data>/owner.token (http.ts); nothing here reads a token from
 * argv or the environment. Exit codes follow §8.1 (http.ts EXIT).
 */
import { execFile, spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { homedir, userInfo } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { readLock } from '../../server/instanceLock.js';
import { spawnHelperCandidates } from '../../server/ptySpawnHelper.js';
import { qrText } from '../../src/lib/qrText.js';
import { installService, uninstallService, unitPath, type RunResult, type ServiceDeps } from './service.js';
import { AdminError, EXIT, createAdminClient, readOwnerToken, resolveAdminPort, type AdminClient } from './http.js';
import { runPair, type AddressKind } from './pair.js';
import { runDevices } from './devices.js';
import { runShareDefault } from './shareDefault.js';
import { runStatus } from './status.js';
import { runDoctor, realProbes } from './doctor.js';
import type { CliAuthReport } from '../../src/types/cliAuth.js';
import { runLogs, DEFAULT_LINES } from './logs.js';

/** dist/cli/admin.cjs and cli/server/index.ts both sit two folders below the package root. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEALTH_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

const COMMANDS = ['install-service', 'uninstall-service', 'pair', 'devices', 'status', 'doctor', 'logs', 'share-default'] as const;

const ArgsSchema = z.object({
  command: z.enum(COMMANDS),
  dataDir: z.string().min(1),
  port: z.string().optional(),
  json: z.boolean(),
  include: z.array(z.enum(['lan', 'tailnet', 'public'])),
  invert: z.boolean(),
  lines: z.coerce.number().int().min(1).max(100_000),
  follow: z.boolean(),
  rest: z.array(z.string()),
});
type Args = z.infer<typeof ArgsSchema>;

/** Flags that take a value. Everything else starting with -- is a switch. */
const VALUE_FLAGS = new Set(['--data-dir', '--port', '-n', '--lines']);
const ADDRESS_FLAGS: Record<string, AddressKind> = { '--lan': 'lan', '--tailscale': 'tailnet', '--tailnet': 'tailnet', '--public': 'public' };
const SWITCHES = new Set(['--json', '--invert', '--no-follow', ...Object.keys(ADDRESS_FLAGS)]);

function parseArgs(argv: string[]): Args {
  const [command, ...tail] = argv;
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith('--') ? arg.slice(eq + 1) : tail[++i];
      if (value === undefined) throw new Error(`${name} needs a value`);
      values[name] = value;
    } else if (SWITCHES.has(arg)) {
      switches.add(arg);
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new Error(`unknown option ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  const include = [...new Set(Object.entries(ADDRESS_FLAGS).filter(([flag]) => switches.has(flag)).map(([, kind]) => kind))];
  return ArgsSchema.parse({
    command,
    dataDir: values['--data-dir'],
    port: values['--port'],
    json: switches.has('--json'),
    include,
    invert: switches.has('--invert'),
    lines: values['-n'] ?? values['--lines'] ?? DEFAULT_LINES,
    follow: !switches.has('--no-follow'),
    rest,
  });
}

function run(command: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && !stderr ? err.message : String(stderr) });
    });
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const out = (line: string): void => { process.stdout.write(`${line}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A sleep that Ctrl-C/SIGTERM ends early, so `pair` withdraws its code at once, not on the next poll. */
function sleepUnless(cancelled: AbortSignal) {
  return (ms: number): Promise<void> => new Promise((resolve) => {
    if (cancelled.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); cancelled.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    cancelled.addEventListener('abort', done);
  });
}

function packageVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '?');
  } catch {
    return '?';
  }
}

/** Ctrl-C as an AbortSignal, for the commands that wait (pair, logs). */
function ctrlC(): AbortSignal {
  const ctl = new AbortController();
  process.once('SIGINT', () => ctl.abort());
  process.once('SIGTERM', () => ctl.abort());
  return ctl.signal;
}

/** One y/N line from the terminal; null on Ctrl-C, end of input, `cancelled` or the timeout. */
function askOn(cancelled: AbortSignal) {
  return (question: string, timeoutMs: number): Promise<string | null> => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    const finish = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelled.removeEventListener('abort', onAbort);
      if (answer === null) process.stdout.write('\n');
      rl.close();
      resolve(answer);
    };
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    cancelled.addEventListener('abort', onAbort);
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    rl.question(question, (answer) => finish(answer));
  });
}

function spawnHelperPath(): string | null {
  try {
    const root = dirname(createRequire(join(PACKAGE_ROOT, 'package.json')).resolve('node-pty/package.json'));
    return spawnHelperCandidates(root).find((p) => existsSync(p)) ?? null;
  } catch {
    return null;
  }
}

/** The running server's reading of the CLIs' sign-in, or null when it isn't running or can't say. */
async function serverCliAuth(args: Args): Promise<CliAuthReport | null> {
  try {
    const { client } = adminClient(args);
    const res = await client.request('GET', '/api/cli-auth');
    return res.status === 200 ? ((res.body as { data?: CliAuthReport }).data ?? null) : null;
  } catch {
    return null;
  }
}

function adminClient(args: Args): { client: AdminClient; port: number } {
  const port = resolveAdminPort({ dataDir: args.dataDir, flagPort: args.port, env: process.env });
  return { client: createAdminClient({ port, token: readOwnerToken(args.dataDir) }), port };
}

async function serviceCommand(args: Args): Promise<number> {
  const deps: ServiceDeps = {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    user: userInfo().username,
    nodePath: process.execPath,
    cliPath: join(PACKAGE_ROOT, 'bin', 'cli.js'),
    dataDir: args.dataDir,
    port: resolveAdminPort({ dataDir: args.dataDir, flagPort: args.port, env: process.env }),
    run,
    readServerLock: (dataDir) => readLock(join(dataDir, 'server.lock')),
    pidAlive,
    sleep,
    out,
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
  };
  return args.command === 'install-service' ? installService(deps) : uninstallService(deps);
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`).join('; ') : (err as Error).message;
    process.stderr.write(`usage: admin.cjs <${COMMANDS.join('|')}> --data-dir <folder> [options] (${detail})\n`);
    return EXIT.USAGE;
  }

  switch (args.command) {
    case 'install-service':
    case 'uninstall-service':
      return serviceCommand(args);

    case 'pair': {
      const { client } = adminClient(args);
      const cancelled = ctrlC();
      return runPair({
        client,
        include: args.include.length > 0 ? args.include : undefined,
        invert: args.invert,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        out,
        ask: askOn(cancelled),
        sleep: sleepUnless(cancelled),
        now: Date.now,
        cancelled,
        qr: (text, options) => qrText(text, options),
      });
    }

    case 'devices': {
      const { client } = adminClient(args);
      return runDevices({ client, args: args.rest, json: args.json, out, now: Date.now });
    }

    case 'share-default': {
      const { client } = adminClient(args);
      return runShareDefault({ client, args: args.rest, json: args.json, out });
    }

    case 'status': {
      const port = resolveAdminPort({ dataDir: args.dataDir, flagPort: args.port, env: process.env });
      let client: AdminClient | null = null;
      try {
        client = createAdminClient({ port, token: readOwnerToken(args.dataDir) });
      } catch (err) {
        // No token: report what the files say, and exit 2.
        if (!(err instanceof AdminError) || err.exitCode !== EXIT.NOT_RUNNING) throw err;
      }
      return runStatus({
        client, dataDir: args.dataDir, port, version: packageVersion(), home: homedir(), env: process.env,
        lock: readLock(join(args.dataDir, 'server.lock')), json: args.json, now: Date.now, out,
      });
    }

    case 'doctor': {
      const require = createRequire(join(PACKAGE_ROOT, 'package.json'));
      return runDoctor({
        dataDir: args.dataDir,
        packageRoot: PACKAGE_ROOT,
        home: homedir(),
        platform: process.platform,
        env: process.env,
        user: userInfo().username,
        uid: process.getuid?.() ?? null,
        nodeVersion: process.version,
        port: resolveAdminPort({ dataDir: args.dataDir, flagPort: args.port, env: process.env }),
        run,
        load: (name) => require(name),
        spawnHelperPath,
        readServerLock: () => realProbes.readServerLock(args.dataDir),
        lockLive: (record) => realProbes.lockLive(record),
        cliAuth: () => serverCliAuth(args),
        portAnswers: realProbes.portAnswers,
        out,
      });
    }

    case 'logs': {
      const cancelled = ctrlC();
      return runLogs({
        dataDir: args.dataDir,
        platform: process.platform,
        serviceInstalled: existsSync(unitPath(homedir(), process.env)),
        lines: args.lines,
        follow: args.follow,
        spawnAttached: (command, cmdArgs) => new Promise((resolve) => {
          const child = spawn(command, cmdArgs, { stdio: 'inherit' });
          child.on('error', (err) => { process.stderr.write(`aasc-server: cannot run ${command}: ${err.message}\n`); resolve(EXIT.FAILED); });
          child.on('exit', (code) => resolve(code ?? EXIT.OK));
        }),
        write: (text) => { process.stdout.write(text); },
        sleep,
        cancelled,
      });
    }
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    process.stderr.write(`aasc-server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof AdminError ? err.exitCode : EXIT.FAILED;
  },
);
