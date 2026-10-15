/** Exact immutable versions and verified streaming blob cache; never extract ZIP input. */
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  PackageManifestSchema,
  ResourceVersionSchema,
  type ResourceVersion,
  type ResourceRef,
} from '../../src/types/cloudResources.js';
import type { CloudClient } from './types.js';
import { CloudError } from './types.js';
import { sha256, readSafeFile } from './installFs.js';
import { privateDirectory } from './secretStore.js';
import { retryRateLimit, type RetryDelay } from './binding.js';
export function canonicalManifest(input: unknown) {
  const m = PackageManifestSchema.parse(input);
  return {
    ...m,
    files: [...m.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    dependencies: [...m.dependencies].sort(
      (a, b) => a.resourceId.localeCompare(b.resourceId) || a.version - b.version,
    ),
  };
}
export function validatedVersion(input: unknown, ref: ResourceRef): ResourceVersion {
  const v = ResourceVersionSchema.parse(input);
  if (
    v.manifest.resourceId !== ref.resourceId ||
    v.version !== ref.version ||
    sha256(JSON.stringify(canonicalManifest(v.manifest))) !== v.digest
  )
    throw new CloudError('invalid_response', 'Cloud version integrity check failed.', 502);
  return v;
}
/** The most one install or download may declare across a resource and all its dependencies. */
export const MAX_CLOSURE_BYTES = 256 * 1024 * 1024;
export async function exactClosure(
  client: CloudClient,
  ref: ResourceRef | ResourceRef[],
  check: () => void,
  signal: AbortSignal,
): Promise<ResourceVersion[]> {
  const result: ResourceVersion[] = [],
    versions = new Map<string, number>(),
    visiting = new Set<string>();
  let totalBytes = 0;
  async function visit(pin: ResourceRef) {
    check();
    if (visiting.has(pin.resourceId))
      throw new CloudError('dependency_cycle', 'Dependency cycle is not supported.', 409);
    const prev = versions.get(pin.resourceId);
    if (prev !== undefined) {
      if (prev !== pin.version)
        throw new CloudError(
          'dependency_version_conflict',
          'Dependencies select incompatible exact versions.',
          409,
        );
      return;
    }
    if (versions.size >= 2000)
      throw new CloudError('package_limit', 'Dependency closure exceeds local limits.', 409);
    versions.set(pin.resourceId, pin.version);
    visiting.add(pin.resourceId);
    const value = validatedVersion(
      await client.request(
        'GET',
        `/v1/resources/${pin.resourceId}/versions/${pin.version}`,
        undefined,
        signal,
      ),
      pin,
    );
    check();
    // Only manifests have been read so far: refuse before any file is fetched or installed.
    totalBytes += value.manifest.files.reduce((n, f) => n + f.bytes, 0);
    if (totalBytes > MAX_CLOSURE_BYTES)
      throw new CloudError(
        'closure_too_large',
        `This resource and its dependencies exceed ${MAX_CLOSURE_BYTES / 1024 / 1024} MB in total, the most this Mac downloads or installs at once. Nothing was downloaded or installed.`,
        413,
      );
    for (const dep of value.manifest.dependencies) await visit(dep);
    visiting.delete(pin.resourceId);
    result.push(value);
  }
  for (const root of Array.isArray(ref) ? ref : [ref]) await visit(root);
  return result;
}
export async function cacheVersionFiles(options: {
  directory: string;
  version: ResourceVersion;
  client: CloudClient;
  check: () => void;
  signal: AbortSignal;
  delay?: RetryDelay;
}): Promise<Map<string, string>> {
  const { directory, version, client, check, signal } = options;
  await privateDirectory(directory);
  const result = new Map<string, string>();
  for (const f of version.manifest.files) {
    check();
    const path = join(directory, f.sha256);
    let existing: Buffer | null = null;
    try {
      existing = await readSafeFile(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (existing) {
      if (existing.length !== f.bytes || sha256(existing) !== f.sha256)
        throw new CloudError('hash_mismatch', 'Private package cache changed.', 409);
      result.set(f.sha256, path);
      continue;
    }
    if (!client.stream)
      throw new CloudError('unsupported_transport', 'Binary cloud transport is unavailable.', 503);
    await retryRateLimit(
      async () => {
        const tmp = join(directory, `.blob-${randomUUID()}`);
        const out = await open(
          tmp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        let size = 0;
        const hash = createHash('sha256');
        try {
          await client.stream!(
            `/v1/resources/${version.manifest.resourceId}/versions/${version.version}/files/${f.sha256}`,
            async (body) => {
              const reader = body.getReader();
              try {
                while (true) {
                  const part = await reader.read();
                  if (part.done) break;
                  check();
                  size += part.value.byteLength;
                  if (size > f.bytes || size > 16 * 1024 * 1024)
                    throw new CloudError('hash_mismatch', 'Cloud file exceeds declared size.', 409);
                  hash.update(part.value);
                  await out.writeFile(part.value);
                }
              } finally {
                await reader.cancel().catch(() => {});
              }
            },
            signal,
          );
          if (size !== f.bytes || hash.digest('hex') !== f.sha256)
            throw new CloudError('hash_mismatch', 'Cloud file integrity check failed.', 409);
          check();
          await out.sync();
          await out.close();
          await rename(tmp, path);
        } finally {
          await out.close().catch(() => {});
          await unlink(tmp).catch(() => {});
        }
      },
      check,
      signal,
      options.delay,
    );
    result.set(f.sha256, path);
  }
  return result;
}
