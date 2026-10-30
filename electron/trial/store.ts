import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LocalTrialState } from '../../bin/trial/client.cjs';

type Crypto = {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
};
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Trial secrets never cross preload/renderer IPC. No plaintext keychain fallback. */
export function createSecureTrialStore({ file, crypto }: { file: string; crypto: Crypto }) {
  function checkFile() {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32768)
        fail('credential_store_invalid');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      fail('credential_store_invalid');
    }
  }
  function load(): LocalTrialState | null {
    if (!checkFile()) return null;
    if (!crypto.isAvailable()) fail('credential_store_unavailable');
    try {
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      if (
        envelope.version !== 1 ||
        typeof envelope.encrypted !== 'string' ||
        !/^[A-Za-z0-9+/]+=*$/.test(envelope.encrypted)
      )
        fail('credential_store_invalid');
      const value = JSON.parse(crypto.decrypt(Buffer.from(envelope.encrypted, 'base64')));
      if (
        value.version !== 1 ||
        (value.cookie !== null && typeof value.cookie !== 'string') ||
        (value.pending !== null &&
          (typeof value.pending?.requestKey !== 'string' ||
            typeof value.pending?.prompt !== 'string' ||
            value.pending.prompt.length > 600))
      )
        fail('credential_store_invalid');
      return value;
    } catch {
      fail('credential_store_invalid');
    }
  }
  function save(value: LocalTrialState | null) {
    const existing = checkFile();
    if (value === null) {
      if (existing) rmSync(file);
      return;
    }
    if (!crypto.isAvailable()) fail('credential_store_unavailable');
    if (existing) load(); // Never silently overwrite a corrupt or undecryptable credential.
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())
      fail('credential_store_invalid');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const encrypted = crypto.encrypt(JSON.stringify(value)).toString('base64');
      writeFileSync(temp, JSON.stringify({ version: 1, encrypted }), { flag: 'wx', mode: 0o600 });
      renameSync(temp, file);
    } catch {
      fail('credential_store_unavailable');
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return { load, save };
}
