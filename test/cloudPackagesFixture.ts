import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanResources } from '../server/resourceScanner.js';
import { createResourceJobs } from '../server/cloud/resourceJobs.js';
import { CloudError, type CloudConnector } from '../server/cloud/types.js';
import { canonicalManifest } from '../server/cloud/packageFiles.js';
import { sha256 } from '../server/cloud/installFs.js';
import type { PackageManifest, ResourceVersion } from '../src/types/cloudResources.js';
export async function cloudFixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-packages-')));
  await mkdir(join(home, '.claude', 'skills', 'demo'), { recursive: true });
  await writeFile(
    join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: test\n---\nHello',
  );
  let scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
  const binding = {
    backendOrigin: 'https://cloud.example',
    accountId: randomUUID(),
    generation: 1,
  };
  let current = { ...binding };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const versions = new Map<string, ResourceVersion>(),
    uploads = new Map<
      string,
      { manifest: PackageManifest; baseVersion: number | null; mutationId: string }
    >(),
    blobs = new Map<string, Buffer>();
  let hook: ((path: string) => void) | undefined;
  let limits = 0;
  let loseCommitResponse = false;
  let catalogReady = true;
  const committed = new Map<string, ResourceVersion>();
  const aliasRetries: string[] = [];
  const client = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      hook?.(path);
      if (limits > 0 && method === 'PUT') {
        limits--;
        throw new CloudError('rate_limited', 'Rate limit', 429, undefined, 2000);
      }
      if (path.endsWith('/head')) {
        const id = path.split('/')[3];
        const entries = [...versions.values()].filter((v) => v.manifest.resourceId === id);
        if (!entries.length) throw new CloudError('not_found', 'Missing', 404);
        return {
          resourceId: id,
          headVersion: Math.max(...entries.map((v) => v.version)),
          deleted: false,
        } as T;
      }
      if (path === '/v1/resources/uploads') {
        const b = body as {
          manifest: PackageManifest;
          baseVersion: number | null;
          mutationId: string;
        };
        const prior = [...uploads].find(([, u]) => u.mutationId === b.mutationId);
        const id = prior?.[0] ?? randomUUID();
        uploads.set(id, b);
        return {
          uploadId: id,
          missingHashes: b.manifest.files.map((f) => f.sha256),
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        } as T;
      }
      if (method === 'PUT') {
        if (committed.has(path.split('/')[4]))
          throw new CloudError('not_found', 'Cloud resource was not found.', 404);
        blobs.set(path.split('/').pop()!, body as Buffer);
        return {} as T;
      }
      if (path.endsWith('/commit')) {
        const uploadId = path.split('/')[4];
        if (committed.has(uploadId)) return committed.get(uploadId) as T;
        const u = uploads.get(uploadId)!;
        const manifest = canonicalManifest(u.manifest);
        const v = {
          manifest,
          version: (u.baseVersion ?? 0) + 1,
          digest: sha256(JSON.stringify(manifest)),
          createdAt: new Date().toISOString(),
        };
        versions.set(`${manifest.resourceId}:${v.version}`, v);
        committed.set(uploadId, v);
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new CloudError('offline', 'Response lost.', 503);
        }
        return v as T;
      }
      if (path.includes('/versions/')) {
        const parts = path.split('/');
        const v = versions.get(`${parts[3]}:${parts[5]}`);
        if (!v) throw new CloudError('not_found', 'Missing', 404);
        return v as T;
      }
      throw new Error('Unexpected fixture request ' + path);
    },
    async stream(path: string, consume: (body: ReadableStream<Uint8Array>) => Promise<void>) {
      calls.push({ method: 'GET', path, body: undefined });
      hook?.(path);
      const body = blobs.get(path.split('/').pop()!);
      if (!body) throw new CloudError('not_found', 'Missing', 404);
      await consume(
        new ReadableStream({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        }),
      );
    },
  };
  const cloud = {
    client,
    status: () => ({
      connection: { ...current, deviceId: randomUUID(), deviceName: 'fixture' },
      state: 'connected',
      lastError: null,
    }),
    onStop: () => () => {},
  } as unknown as CloudConnector;
  const catalog = {
    publicationInternals: () => [...scan.internals.values()],
    getCatalog: () => ({ ...scan, state: catalogReady ? 'ready' : 'error' }),
    startScan: () => {},
    whenIdle: async () => {
      if (catalogReady)
        scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
    },
  } as never;
  const options = {
    cloud,
    catalog,
    getCloudAliases: async () =>
      ({
        retryAcknowledgedTarget: async (key: string) => {
          aliasRetries.push(key);
          return [];
        },
      }) as never,
    roots: {
      claudeRoot: join(home, '.claude'),
      codexRoot: join(home, '.codex'),
      sharedRoot: join(home, '.agents'),
    },
    directory: join(home, 'private'),
    delay: async () => {},
  };
  let jobs = await createResourceJobs(options);
  return {
    home,
    binding,
    cloud,
    calls,
    versions,
    blobs,
    get jobs() {
      return jobs;
    },
    aliasRetries,
    loseNextCommitResponse() {
      loseCommitResponse = true;
    },
    setCatalogReady(ready: boolean) {
      catalogReady = ready;
    },
    async restartJobs() {
      await jobs.close();
      jobs = await createResourceJobs(options);
    },
    get scan() {
      return scan;
    },
    async rescan(extraRoots: string[] = []) {
      scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots });
    },
    get resource() {
      return [...scan.internals.values()].find((r) => r.summary.name === 'demo')!;
    },
    switchAccount() {
      current = { ...current, accountId: randomUUID(), generation: current.generation + 1 };
      return { ...current };
    },
    /** Pair the same account again: a new connection generation, the same backend+account. */
    reconnectSameAccount() {
      current = { ...current, generation: current.generation + 1 };
      return { ...current };
    },
    setHook(fn: (path: string) => void) {
      hook = fn;
    },
    rateLimit(n: number) {
      limits = n;
    },
    async cleanup() {
      await jobs.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
