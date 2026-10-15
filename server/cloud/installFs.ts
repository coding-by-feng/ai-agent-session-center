import { constants } from 'node:fs';
import { lstat, readdir, open, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import nativePath, { basename, dirname, join, relative, resolve } from 'node:path';
import { safeRelative } from '../resourcePackages/adapters.js';
import { CloudError } from './types.js';
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export interface SnapshotFile {
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}
export interface DestinationSnapshot {
  files: SnapshotFile[];
  digest: string;
  directory: boolean;
  directories: { path: string; mode: number }[];
}
export const changed = () =>
  new CloudError(
    'destination_changed',
    'Local destination changed or contains unsafe files. Review it again; originals were preserved.',
    409,
  );
/** Shared by the native walker and deterministic drive/UNC path tests. */
export function parentPaths(path: string, api = nativePath): string[] {
  const root = api.parse(path).root;
  let cur = root;
  return path
    .slice(root.length)
    .split(api.sep === '\\' ? /[\\/]/ : '/')
    .filter(Boolean)
    .map((part) => (cur = api.join(cur, part)));
}
export async function safeParents(path: string, create = false): Promise<void> {
  for (const cur of parentPaths(path)) {
    let s;
    try {
      s = await lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw changed();
      if (!create) return;
      await mkdir(cur, { mode: 0o700 });
      await syncDirectory(dirname(cur));
      s = await lstat(cur);
    }
    if (!s.isDirectory() || s.isSymbolicLink()) throw changed();
  }
}
export async function readSafeFile(path: string, max = 16 * 1024 * 1024): Promise<Buffer> {
  await safeParents(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > max) throw changed();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (st.ino !== before.ino || st.dev !== before.dev || !st.isFile() || st.nlink !== 1)
      throw changed();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, max + 1 - size));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > max) throw changed();
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const data = Buffer.concat(chunks);
    const after = await handle.stat();
    if (after.size !== data.length || after.mtimeMs !== st.mtimeMs || after.nlink !== 1)
      throw changed();
    return data;
  } finally {
    await handle.close();
  }
}
export async function snapshot(path: string): Promise<DestinationSnapshot | null> {
  await safeParents(dirname(path));
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw changed();
  const files: SnapshotFile[] = [];
  const directories: { path: string; mode: number }[] = [];
  let bytes = 0;
  async function walk(abs: string, rel: string, depth: number) {
    if (depth > 12 || files.length >= 2000) throw changed();
    const stat = await lstat(abs);
    if (stat.isSymbolicLink()) throw changed();
    if (stat.isDirectory()) {
      directories.push({ path: rel, mode: stat.mode & 0o7777 });
      for (const name of (await readdir(abs)).sort()) {
        safeRelative(name);
        await walk(join(abs, name), rel ? rel + '/' + name : name, depth + 1);
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw changed();
    const body = await readSafeFile(abs);
    bytes += body.length;
    if (bytes > 64 * 1024 * 1024) throw changed();
    files.push({
      path: rel,
      sha256: sha256(body),
      bytes: body.length,
      mode: stat.mode & 0o7777,
    });
  }
  await walk(path, st.isDirectory() ? '' : basename(path), 0);
  return {
    files,
    directories,
    digest: sha256(
      JSON.stringify({
        directory: st.isDirectory(),
        directories,
        files: st.isDirectory() ? files : files.map((f) => ({ ...f, path: '' })),
      }),
    ),
    directory: st.isDirectory(),
  };
}
export async function assertDestination(
  root: string,
  path: string,
  expected: DestinationSnapshot | null,
) {
  if (
    resolve(root) !== root ||
    resolve(path) !== path ||
    !relative(root, path) ||
    relative(root, path).startsWith('..')
  )
    throw changed();
  await safeParents(root);
  const now = await snapshot(path);
  if (now?.digest !== expected?.digest) throw changed();
}
export async function writeVerified(path: string, bytes: Buffer, expected: SnapshotFile) {
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
    throw new CloudError('hash_mismatch', 'Cloud file integrity check failed.', 409);
  await safeParents(dirname(path), true);
  const f = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    expected.mode,
  );
  try {
    await f.writeFile(bytes);
    await f.chmod(expected.mode);
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function syncDirectory(path: string) {
  if (process.platform !== 'win32') {
    const d = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  }
}

export interface DirectoryAnchor {
  path: string;
  dev: number;
  ino: number;
}
export async function directoryAnchor(path: string): Promise<DirectoryAnchor> {
  await safeParents(path);
  let current = path;
  for (;;) {
    try {
      const s = await lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink()) throw changed();
      return { path: current, dev: s.dev, ino: s.ino };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const next = dirname(current);
      if (next === current) throw changed();
      current = next;
    }
  }
}
export async function assertAnchors(anchors: DirectoryAnchor[]) {
  for (const a of anchors) {
    await safeParents(a.path);
    const now = await lstat(a.path);
    if (now.dev !== a.dev || now.ino !== a.ino) throw changed();
  }
}
