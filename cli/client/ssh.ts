/**
 * Owner mode (`aasc add --ssh you@host`, plan §9.5): no pairing. Each connect
 *
 *   1 checks the target is a plain user@host[:port],
 *   2 reads the server's owner token over SSH (BatchMode, so it never prompts),
 *   3 opens `ssh -N -L <dir>/s.sock:127.0.0.1:<PORT>` and waits for the forward,
 *   4 and on close, process exit or a signal kills that ssh child and removes <dir>.
 *
 * The local end is a Unix socket in a fresh 0700 folder, not a TCP port: a loopback port is
 * open to every local user, and a port picked free and then released can be taken by someone
 * else first, who would then receive the owner token. Only `aasc open` uses TCP, because a
 * browser can't dial a socket (and says so). Windows has no Unix-socket forwarding in its
 * OpenSSH, so there the tunnel is TCP.
 *
 * ssh is always spawned with an argument array and `shell: false`. The one string a shell
 * does see is the remote command, which runs in the remote account's login shell: its only
 * variable part is the data folder, which must match a strict character set and is single-
 * quoted. The token stays in memory: never in argv, an error message or a log.
 */
import { spawn as nodeSpawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createConnection, createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import { onCleanup } from './cleanup.js';
import { cleanText } from './sanitize.js';

/** The server's data folder on Linux, relative to the remote home: ssh runs the command there. */
export const DEFAULT_REMOTE_DATA_DIR = '.config/ai-agent-session-center';
export const OWNER_TOKEN_FILE = 'owner.token';
/** = the SSH failure exit code in plan §9.10. */
export const SSH_EXIT_CODE = 5;

const TOKEN_READ_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const MAX_STDERR = 4096;

export class SshError extends Error {
  readonly exitCode = SSH_EXIT_CODE;
}

export interface SshTarget {
  user: string;
  host: string;
  port: number | null;
  /** `user@host`, exactly as validated: what goes after `--` in argv. */
  destination: string;
}

// POSIX-ish login names: no leading '-', nothing a shell or ssh would read specially.
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
// DNS labels (or a dotted IPv4): letters, digits and inner hyphens; no leading '-' or '.'.
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** `user@host[:port]`, or null for anything else. The same spirit as the server's SHELL_META_RE, but an allow-list. */
export function parseSshTarget(raw: string): SshTarget | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const m = /^([^@]+)@([^@:]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return null;
  const [, user, host, portText] = m;
  if (!USER.test(user)) return null;
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) return null;
  let port: number | null = null;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return { user, host, port, destination: `${user}@${host}` };
}

// Characters a remote shell reads literally inside single quotes, minus the quote itself.
const SAFE_PATH = /^[A-Za-z0-9._/ +@,-]+$/;

/**
 * Where the owner token is on the server: `<data folder>/owner.token`. A `~/` folder is read
 * relative to the remote home (inside quotes the shell wouldn't expand `~`). Throws SshError
 * on anything a shell might interpret.
 */
export function remoteTokenPath(remoteDataDir: string = DEFAULT_REMOTE_DATA_DIR): string {
  let dir = remoteDataDir;
  if (dir.startsWith('~/')) dir = dir.slice(2);
  dir = dir.replace(/\/+$/, '');
  if (!dir || !SAFE_PATH.test(dir) || dir.startsWith('-')) {
    throw new SshError(`"${remoteDataDir.slice(0, 80)}" isn’t a usable --remote-data-dir: letters, digits, spaces and . _ / + @ , - only.`);
  }
  return `${dir}/${OWNER_TOKEN_FILE}`;
}

function portArgs(t: SshTarget): string[] {
  return t.port === null ? [] : ['-p', String(t.port)];
}

/** argv (after `ssh`) that prints the owner token. */
export function tokenReadArgs(t: SshTarget, remoteDataDir?: string): string[] {
  return [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...portArgs(t), '--', t.destination,
    `cat -- '${remoteTokenPath(remoteDataDir)}'`,
  ];
}

function validPort(p: number): boolean {
  return Number.isInteger(p) && p >= 1 && p <= 65535;
}

/** Where the tunnel's local end listens: a private Unix socket, or (aasc open only) a loopback port. */
export type LocalEnd = { socketPath: string } | { port: number };

/** An absolute socket path ssh's -L can parse: no ':' (its separator), within sun_path's ~104 bytes. */
function validSocketPath(p: string): boolean {
  return p.startsWith('/') && !/[:\s]/.test(p) && Buffer.byteLength(p) <= 100;
}

/** argv (after `ssh`) for the tunnel to the server's loopback. */
export function tunnelArgs(t: SshTarget, local: LocalEnd, remotePort: number): string[] {
  if (!validPort(remotePort)) throw new SshError('Invalid tunnel port.');
  const base = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15'];
  if ('socketPath' in local) {
    if (!validSocketPath(local.socketPath)) throw new SshError('Invalid tunnel socket path.');
    return [
      ...base, '-o', 'StreamLocalBindMask=0177', '-o', 'StreamLocalBindUnlink=yes',
      '-L', `${local.socketPath}:127.0.0.1:${remotePort}`, ...portArgs(t), '--', t.destination,
    ];
  }
  if (!validPort(local.port)) throw new SshError('Invalid tunnel port.');
  return [...base, '-L', `127.0.0.1:${local.port}:127.0.0.1:${remotePort}`, ...portArgs(t), '--', t.destination];
}

/** The slice of a ChildProcess this module uses (a fake in tests). */
export interface ChildLike {
  stdout: Readable | null;
  stderr: Readable | null;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnLike = (cmd: string, args: readonly string[], opts: { shell: false; stdio: ['ignore', 'pipe', 'pipe'] }) => ChildLike;

const defaultSpawn: SpawnLike = (cmd, args, opts) => nodeSpawn(cmd, [...args], opts);

/** ssh's own complaint, one line, control characters out: safe to print. */
function sshComplaint(stderr: string): string {
  const lines = stderr.split('\n').map((l) => cleanText(l).trim()).filter(Boolean);
  return lines.at(-1)?.slice(0, 300) ?? '';
}

function collect(stream: Readable | null, into: { text: string }): void {
  stream?.on('data', (chunk: Buffer | string) => {
    if (into.text.length < MAX_STDERR) into.text += chunk.toString();
  });
}

const OWNER_TOKEN = /^[0-9a-f]{64}$/;

export interface ReadTokenOptions {
  spawn?: SpawnLike;
  remoteDataDir?: string;
  timeoutMs?: number;
}

/** Read the owner token over SSH. Resolves with the token; rejects with SshError (exit 5). */
export function readOwnerToken(t: SshTarget, opts: ReadTokenOptions = {}): Promise<string> {
  const args = tokenReadArgs(t, opts.remoteDataDir);
  const spawn = opts.spawn ?? defaultSpawn;
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { text: '' };
    const err = { text: '' };
    collect(child.stdout, out);
    collect(child.stderr, err);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => {
      child.kill('SIGTERM');
      reject(new SshError(`ssh ${t.destination} didn’t answer in ${Math.round((opts.timeoutMs ?? TOKEN_READ_TIMEOUT_MS) / 1000)} s.`));
    }), opts.timeoutMs ?? TOKEN_READ_TIMEOUT_MS);
    child.on('error', (e) => finish(() => reject(new SshError(
      (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ssh isn’t installed on this computer.' : `ssh ${t.destination} failed to start.`,
    ))));
    child.on('close', (code) => finish(() => {
      // ssh itself fails with 255; 1 with cat's "No such file" means we got in and there's no token.
      if (code === 1 && /No such file or directory/.test(err.text)) {
        reject(new SshError(`ssh ${t.destination} worked, but there is no ${remoteTokenPath(opts.remoteDataDir)}. `
          + 'Is aasc-server running there, and is --remote-data-dir right? The desktop app writes the owner token only '
          + 'when asked: set AASC_OWNER_TOKEN=1, or "ownerToken": true in its server-config.json, and restart it.'));
        return;
      }
      if (code !== 0) {
        const why = sshComplaint(err.text);
        reject(new SshError(`ssh ${t.destination} failed${why ? `: ${why}` : ` (exit ${code})`}`));
        return;
      }
      const token = out.text.trim();
      if (!OWNER_TOKEN.test(token)) {
        reject(new SshError(`ssh ${t.destination} worked, but ${remoteTokenPath(opts.remoteDataDir)} doesn’t hold an owner token. Is aasc-server running there, and is --remote-data-dir right?`));
        return;
      }
      resolve(token);
    }));
  });
}

/** A free TCP port on 127.0.0.1 (the OS picks; released just before ssh binds it). */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/** Does something accept a connection on the tunnel's local end right now? */
export function probeLocalEnd(local: LocalEnd): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = 'socketPath' in local
      ? createConnection({ path: local.socketPath })
      : createConnection({ host: '127.0.0.1', port: local.port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** A fresh 0700 folder for the socket. os.tmpdir() unless that path is too long for a socket. */
function makeSocketDir(): string {
  const base = Buffer.byteLength(tmpdir()) <= 70 ? tmpdir() : '/tmp';
  return mkdtempSync(join(base, 'aasc-'));
}

export interface Tunnel {
  /** The Unix socket that reaches the server's loopback (the default transport). */
  socketPath?: string;
  /** The loopback port that reaches it (transport 'tcp', for aasc open). */
  port?: number;
  close(): void;
}

export interface TunnelOptions {
  remotePort: number;
  /** 'unix' (default, except on Windows) or 'tcp' (aasc open: a browser needs a port). */
  transport?: 'unix' | 'tcp';
  localPort?: number;
  spawn?: SpawnLike;
  probe?: (local: LocalEnd) => Promise<boolean>;
  /** Registers the kill for process exit and signals; default cleanup.ts. */
  onExit?: (fn: () => void) => () => void;
  pollMs?: number;
  readyTimeoutMs?: number;
}

/** Start `ssh -N -L …` and resolve once the forward accepts connections. */
export async function openTunnel(t: SshTarget, opts: TunnelOptions): Promise<Tunnel> {
  const transport = opts.transport ?? (process.platform === 'win32' ? 'tcp' : 'unix');
  const socketDir = transport === 'unix' ? makeSocketDir() : null;
  const removeDir = (): void => { if (socketDir) rmSync(socketDir, { recursive: true, force: true }); };
  let local: LocalEnd;
  let args: string[];
  try {
    local = socketDir ? { socketPath: join(socketDir, 's.sock') } : { port: opts.localPort ?? await findFreePort() };
    args = tunnelArgs(t, local, opts.remotePort);
  } catch (err) {
    removeDir();
    throw err;
  }
  const spawn = opts.spawn ?? defaultSpawn;
  const probe = opts.probe ?? probeLocalEnd;
  const child = spawn('ssh', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const err = { text: '' };
  collect(child.stderr, err);
  child.stdout?.resume();

  let exited: { code: number | null } | null = null;
  let startError: Error | null = null;
  child.on('close', (code) => { exited = { code }; });
  child.on('error', (e) => { startError = e; });

  let closed = false;
  const kill = (): void => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && exited === null) child.kill('SIGTERM');
    removeDir();
  };
  // The ssh child must not outlive us, however we leave.
  const unregister = (opts.onExit ?? onCleanup)(kill);
  const close = (): void => {
    unregister();
    kill();
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? READY_TIMEOUT_MS);
  const pollMs = opts.pollMs ?? READY_POLL_MS;
  for (;;) {
    if (startError) {
      close();
      throw new SshError((startError as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'ssh isn’t installed on this computer.' : `ssh ${t.destination} failed to start.`);
    }
    if (exited) {
      close();
      const why = sshComplaint(err.text);
      throw new SshError(`The ssh tunnel to ${t.destination} failed${why ? `: ${why}` : ` (exit ${(exited as { code: number | null }).code})`}`);
    }
    if (await probe(local)) {
      return 'socketPath' in local ? { socketPath: local.socketPath, close } : { port: local.port, close };
    }
    if (Date.now() > deadline) {
      close();
      throw new SshError(`The ssh tunnel to ${t.destination} didn’t come up.`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
