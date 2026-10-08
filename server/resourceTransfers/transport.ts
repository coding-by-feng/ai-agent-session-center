import { spawn } from 'child_process';
import { homedir, tmpdir } from 'os';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import { REMOTE_HELPER } from './remoteHelper.js';
import type { TransferDeviceInput, TransferDevice } from '../../src/types/resourceTransfers.js';

export type RemoteCall = (
  device: TransferDeviceInput | TransferDevice,
  request: unknown,
) => Promise<Record<string, unknown>>;
function run(command: string, args: string[], input: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(out);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done(
        new Error(
          'Connection timed out. Retry checks the destination receipt before copying again.',
        ),
      );
    }, timeout);
    child.on('error', () => done(new Error('SSH tools are unavailable on this machine.')));
    child.stdout.on('data', (b) => {
      out += b;
      if (out.length > 32000000) {
        child.kill();
        done(new Error('Remote response exceeded the limit.'));
      }
    });
    child.stderr.on('data', (b) => {
      if (err.length < 3000) err += b;
    });
    child.on('close', (code) => {
      if (code !== 0 && !out.trim().startsWith('{'))
        done(
          new Error(
            err.includes('Host key') || err.includes('host key')
              ? 'SSH host is not trusted or its key changed. Verify it in your SSH known_hosts before connecting.'
              : 'SSH connection failed. Check host, user, key-based login and Node.js 18+ on the destination.',
          ),
        );
      else done();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function knownKeys(device: TransferDeviceInput): Promise<string[]> {
  const host = device.port === 22 ? device.host : `[${device.host}]:${device.port}`;
  let output: string;
  try {
    output = await run(
      'ssh-keygen',
      ['-F', host, '-f', join(homedir(), '.ssh', 'known_hosts')],
      '',
      5000,
    );
  } catch {
    throw new Error(
      'No trusted SSH host key. Connect once in your terminal and verify the host fingerprint, then add this device.',
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
export async function knownFingerprint(device: TransferDeviceInput): Promise<string> {
  return fingerprintOf(await knownKeys(device));
}
/** Native SSH authentication; no passwords or private keys enter the browser or task journal. */
export const sshRemoteCall: RemoteCall = async (device, request) => {
  const encoded = Buffer.from(REMOTE_HELPER).toString('base64');
  const command = `node -e 'eval(Buffer.from("${encoded}","base64").toString())'`;
  const keys = await knownKeys(device);
  if ('fingerprint' in device && fingerprintOf(keys) !== device.fingerprint)
    throw new Error(
      'Trusted host keys changed. Re-add the destination after verifying its identity.',
    );
  const directory = await mkdtemp(join(tmpdir(), 'aasc-transfer-'));
  const keyFile = join(directory, 'known_hosts');
  const host = device.port === 22 ? device.host : `[${device.host}]:${device.port}`;
  let raw: string;
  try {
    await writeFile(keyFile, keys.map((k) => `${host} ${k}`).join('\n') + '\n', { mode: 0o600 });
    raw = await run(
      'ssh',
      [
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
      ],
      JSON.stringify(request),
      120000,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  let result: { ok?: boolean; data?: Record<string, unknown>; error?: string };
  try {
    result = JSON.parse(raw);
  } catch {
    throw new Error('The remote helper returned an invalid response. Node.js 18+ is required.');
  }
  if (!result.ok || !result.data) throw new Error(result.error || 'Remote transfer failed.');
  return result.data;
};
