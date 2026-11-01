/**
 * Pinned SSH for Project Sync. Trust comes only from the user's own known_hosts: a server
 * is added once its key is there (connect once in a terminal), the key set is pinned by
 * digest, and every later connection uses that snapshot alone — no prompts, no global
 * known_hosts, no reuse of another connection. Restored from the retired SSH Transfers
 * transport (AASC-51) with only what Project Sync uses.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { SyncDeviceInput } from '../../src/types/projectSync.js';

function run(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(out);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(new Error('Reading known_hosts timed out.'));
    }, timeout);
    child.on('error', () => done(new Error('SSH tools are unavailable on this machine.')));
    child.stdout.on('data', (b) => {
      if (out.length < 1_000_000) out += b;
    });
    child.on('close', (code) => (code === 0 ? done() : done(new Error(`exit ${code}`))));
  });
}

const hostKeyName = (d: SyncDeviceInput) => (d.port === 22 ? d.host : `[${d.host}]:${d.port}`);

async function knownKeys(device: SyncDeviceInput): Promise<string[]> {
  let output: string;
  try {
    output = await run(
      'ssh-keygen',
      ['-F', hostKeyName(device), '-f', join(homedir(), '.ssh', 'known_hosts')],
      5000,
    );
  } catch {
    throw new Error(
      `No trusted SSH host key for ${device.host}. Connect once in a terminal (ssh ${device.username}@${device.host}) and verify its fingerprint, then add the server.`,
    );
  }
  const lines = output.split('\n').filter((x) => x && !x.startsWith('#'));
  if (!lines.length || lines.some((x) => x.startsWith('@')))
    throw new Error(
      'A directly trusted SSH host key is required. Host certificates and revoked entries are not supported.',
    );
  return [...new Set(lines.map((x) => x.trim().split(/\s+/).slice(1, 3).join(' ')))].sort();
}

const fingerprintOf = (keys: string[]) =>
  'SHA256:' + createHash('sha256').update(keys.join('\n')).digest('base64');

/** Digest of the trusted key set, not the individual server key fingerprint. */
export async function knownFingerprint(device: SyncDeviceInput): Promise<string> {
  return fingerprintOf(await knownKeys(device));
}

/** `node -e` command that evaluates a fixed helper source sent inside the command itself. */
export function nodeEvalCommand(source: string): string {
  const encoded = Buffer.from(source).toString('base64');
  return `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`;
}

/** Pinned options: only the trusted key snapshot, no global known_hosts, no prompts, keepalive. */
function sshArgs(device: SyncDeviceInput, keyFile: string, host: string, command: string) {
  return [
    '-T',
    '-o',
    `UserKnownHostsFile=${keyFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    `HostKeyAlias=${host}`,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    // The user's ssh config must not widen the pinned trust or reuse another connection.
    '-o',
    'VerifyHostKeyDNS=no',
    '-o',
    'KnownHostsCommand=none',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    // Nothing of this computer travels with the helper: no agent, no forwards, no local command.
    '-o',
    'ForwardAgent=no',
    '-o',
    'ForwardX11=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=2',
    '-p',
    String(device.port),
    '--',
    `${device.username}@${device.host}`,
    command,
  ];
}

/**
 * A long-lived process over pinned SSH: the helper's frames stream through it. `pinned` is the
 * digest recorded when the server was added (or, while adding, the one just read). The caller
 * runs `cleanup` after the process closes.
 */
export async function spawnPinnedSsh(
  device: SyncDeviceInput & { fingerprint: string },
  command: string,
): Promise<{ child: ChildProcessWithoutNullStreams; cleanup: () => Promise<void> }> {
  const keys = await knownKeys(device);
  if (fingerprintOf(keys) !== device.fingerprint)
    throw new Error(
      'Trusted host keys changed. Verify the server in a terminal, then add it again.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'aasc-sync-'));
  const keyFile = join(directory, 'known_hosts');
  const host = hostKeyName(device);
  try {
    await writeFile(keyFile, keys.map((k) => `${host} ${k}`).join('\n') + '\n', { mode: 0o600 });
    const child = spawn('ssh', sshArgs(device, keyFile, host, command), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { child, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
}
