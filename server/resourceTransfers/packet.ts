import { createHash } from 'crypto';
import { lstat, readdir, open, realpath } from 'fs/promises';
import { constants } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { isCredentialPath, isWithin, PACKAGE_SKIP } from '../fsSafe.js';
import { redactText } from '../resourceMask.js';
import { transferBlocker } from '../../src/types/resourceTransfers.js';
import type { InternalResource } from '../resourceScanner.js';

export interface PacketFile {
  path: string;
  content: string;
  mode: number;
  hash: string;
}
export interface TransferPacket {
  kind: 'file' | 'package';
  hash: string;
  files: PacketFile[];
  relativePath: string;
  dependencies: string[];
}
export const digest = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export function packetHash(files: PacketFile[]): string {
  return digest(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => `${f.path}\0${f.hash}\0${f.mode}\n`)
      .join(''),
  );
}
/** Raw bytes stay server-side. Refuse a whole package rather than silently omit credentials or links. */
export async function readTransferPacket(r: InternalResource): Promise<TransferPacket> {
  const blocked = transferBlocker(r.summary);
  if (blocked) throw new Error(blocked);
  if (
    !r.realPath ||
    !r.rootReal ||
    (await realpath(r.entry.absPath)) !== r.realPath ||
    (await realpath(r.entry.rootAbs)) !== r.rootReal ||
    !isWithin(r.rootReal, r.realPath) ||
    r.rootReal === r.realPath
  )
    throw new Error('Resource moved since the scan. Rescan before copying.');
  const kind = r.entry.kind;
  if (kind !== 'file' && kind !== 'package') throw new Error('Unsupported resource shape.');
  const files: PacketFile[] = [];
  const dependencies = new Set<string>();
  let bytes = 0;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > 12 || files.length >= 2000) throw new Error('Package exceeds the transfer limits.');
    const st = await lstat(abs);
    const expected = resolve(r.realPath!, relative(r.entry.absPath, abs));
    if ((await realpath(abs)) !== expected)
      throw new Error('Resource path changed or contains a link. Rescan.');
    if (st.isSymbolicLink())
      throw new Error('Package contains a symbolic link. Copy its owner explicitly instead.');
    if (isCredentialPath(relative(r.entry.rootAbs, abs)))
      throw new Error('Package contains a credential file; it cannot be transferred.');
    if (st.isDirectory()) {
      for (const name of (await readdir(abs)).sort()) {
        if (PACKAGE_SKIP.has(name)) continue;
        await walk(join(abs, name), rel ? `${rel}/${name}` : name, depth + 1);
      }
      return;
    }
    if (!st.isFile()) throw new Error('Package contains a non-regular file.');
    bytes += st.size;
    if (bytes > 64 * 1024 * 1024 || st.size > 16 * 1024 * 1024)
      throw new Error('Resource exceeds the transfer size limit.');
    const handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      const opened = await handle.stat();
      if (opened.dev !== st.dev || opened.ino !== st.ino || !opened.isFile())
        throw new Error('Resource changed while reading.');
      body = await handle.readFile();
      const after = await handle.stat();
      if (after.mtimeMs !== st.mtimeMs || after.size !== st.size)
        throw new Error('Resource changed while reading.');
    } finally {
      await handle.close();
    }
    if (body.length !== st.size) throw new Error('Resource changed while reading. Compare again.');
    if (!body.includes(0)) {
      const text = body.toString('utf8');
      if (redactText(text) !== text)
        throw new Error('Possible secret detected in the resource. Remove it before copying.');
      for (const match of text.matchAll(
        /(?:\.\.\/)+([A-Za-z0-9_.-]+)\/(?:SKILL\.md|[^\s)"'`]*_shared[^\s)"'`]*|[^\s)"'`]+)/g,
      )) {
        const target = resolve(abs, '..', match[0]);
        if (!isWithin(r.realPath!, target)) dependencies.add(target);
      }
    }
    files.push({
      path: rel || basename(abs),
      content: body.toString('base64'),
      mode: st.mode & 0o111 ? 0o755 : 0o644,
      hash: digest(body),
    });
  };
  await walk(r.entry.absPath, kind === 'file' ? basename(r.entry.absPath) : '', 0);
  if (
    (await realpath(r.entry.absPath)) !== r.realPath ||
    (await realpath(r.entry.rootAbs)) !== r.rootReal
  )
    throw new Error('Resource root changed while reading.');
  if (!files.length) throw new Error('Resource has no transferable files.');
  return {
    kind,
    files,
    hash: packetHash(files),
    relativePath: relative(r.entry.rootAbs, r.entry.absPath).split('\\').join('/'),
    dependencies: [...dependencies],
  };
}
