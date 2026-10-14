import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudError, type SecretEncryption, type SecretStore } from './types.js';
const storageError = () => new CloudError('secret_storage', 'Private cloud storage is unavailable; check local directory ownership and permissions.', 503);
const unavailable = () => new CloudError('secure_storage_unavailable', 'Secure encryption is unavailable. Unlock the OS keychain or configure a secure key store, then reconnect.', 503);
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
/** Refuse links at every existing component; callers canonicalize trusted OS base dirs. */
export async function privateDirectory(directory: string): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw storageError();
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink() || !s.isDirectory()) throw storageError();
    } catch (error) {
      if (!isMissing(error)) throw storageError();
      await mkdir(current, { mode: 0o700 });
    }
  }
  const s = await lstat(directory);
  if ((process.platform !== 'win32' && ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))) || s.isSymbolicLink()) throw storageError();
}
async function regularFile(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (process.platform !== 'win32' && ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())))) throw storageError();
    return true;
  } catch (error) { if (isMissing(error)) return false; throw storageError(); }
}
/** Atomic private publication; existing links/insecure files are never followed or replaced. */
export async function writePrivateFile(path: string, bytes: string | Buffer): Promise<void> {
  await privateDirectory(dirname(path));
  await regularFile(path);
  const temp = join(dirname(path), `.write-${randomUUID()}`);
  try {
    const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await regularFile(path);
    await rename(temp, path);
    // Flush the directory entry when supported (Windows has no directory fsync).
    if (process.platform !== 'win32') { const dir = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW); try { await dir.sync(); } finally { await dir.close(); } }
  } catch { throw storageError(); }
  finally { await unlink(temp).catch(() => {}); }
}
export async function readPrivateFile(path: string): Promise<Buffer | null> {
  await privateDirectory(dirname(path));
  if (!await regularFile(path)) return null;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const s = await file.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > 1024 * 1024) throw storageError(); return await file.readFile(); } finally { await file.close(); }
  } catch { throw storageError(); }
}
export function createFileSecretStore(directory: string): SecretStore {
  const pathFor = (key: string) => { if (!/^[a-zA-Z0-9_-]{1,128}$/.test(key)) throw storageError(); return join(directory, key); };
  return {
    async set(key, value) { await writePrivateFile(pathFor(key), value); },
    async get(key) { const data = await readPrivateFile(pathFor(key)); return data?.toString('utf8') ?? null; },
    async remove(key) { const path = pathFor(key); await privateDirectory(directory); if (await regularFile(path)) await unlink(path); },
  };
}
export function createEncryptedSecretStore(directory: string, encryption: SecretEncryption): SecretStore {
  const files = createFileSecretStore(directory);
  const check = () => { if (!encryption.isAvailable()) throw unavailable(); };
  return {
    async set(key, value) { check(); let bytes: Buffer; try { bytes = encryption.encrypt(value); } catch { throw unavailable(); } await files.set(key, bytes.toString('base64')); },
    async get(key) { check(); const data = await files.get(key); if (data === null) return null; try { return encryption.decrypt(Buffer.from(data, 'base64')); } catch { throw unavailable(); } },
    async remove(key) { await files.remove(key); },
  };
}
