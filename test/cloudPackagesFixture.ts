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
/** One fake backend account, shareable by two fixture devices (AASC-62 sync tests). */
export interface FixtureBackend {
  versions: Map<string, ResourceVersion>;
  uploads: Map<
    string,
    { manifest: PackageManifest; baseVersion: number | null; mutationId: string }
  >;
  blobs: Map<string, Buffer>;
  committed: Map<string, ResourceVersion>;
  /** `<resourceId>:<version>` pairs another resource or a project still pins: DELETE refuses them. */
  inUse?: Set<string>;
  /**
   * Resources whose every version was deleted, with their highest version. Like the real backend,
   * the row stays: its head answers `{ headVersion, deleted: true }`, never a 404.
   */
  deletedHeads?: Map<string, number>;
}
export async function cloudFixture(
  opts: {
    /** Join another device's backend (and pass its `binding`: the same account). */
    backend?: FixtureBackend;
    binding?: { backendOrigin: string; accountId: string; generation: number };
    /** Claude skills to create in the temporary home; default one `demo` skill. */
    skills?: Record<string, string>;
  } = {},
) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-packages-')));
  for (const [name, content] of Object.entries(
    opts.skills ?? { demo: '---\nname: demo\ndescription: test\n---\nHello' },
  )) {
    await mkdir(join(home, '.claude', 'skills', name), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', name, 'SKILL.md'), content);
  }
  let scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
  const binding = opts.binding ?? {
    backendOrigin: 'https://cloud.example',
    accountId: randomUUID(),
    generation: 1,
  };
  let current = { ...binding };
  const calls: { method: string; path: string; body: unknown }[] = [];
  const backend: FixtureBackend = opts.backend ?? {
    versions: new Map(),
    uploads: new Map(),
    blobs: new Map(),
    committed: new Map(),
  };
  const { versions, uploads, blobs, committed } = backend;
  let hook: ((path: string) => void) | undefined;
  let limits = 0;
  // Writes per window, like the backend's per-device minute: past it a DELETE is refused with 429
  // and the window starts again once the client has waited.
  let deleteWindow = 0,
    deletesInWindow = 0;
  let loseCommitResponse = false;
  let catalogReady = true;
  const aliasRetries: string[] = [];
  const client = {
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push({ method, path, body });
      hook?.(path);
      if (limits > 0 && method === 'PUT') {
        limits--;
        throw new CloudError('rate_limited', 'Rate limit', 429, undefined, 2000);
      }
      if (method === 'GET' && /^\/v1\/resources(?:\?|$)/.test(path)) {
        // The backend's catalog page: one latest version per resource, ordered by id.
        const query = new URLSearchParams(path.split('?')[1] ?? '');
        const limit = Number(query.get('limit') ?? 50),
          cursor = query.get('cursor') ?? '';
        const latest = new Map<string, ResourceVersion>();
        for (const v of versions.values())
          if (v.version > (latest.get(v.manifest.resourceId)?.version ?? 0))
            latest.set(v.manifest.resourceId, v);
        const sorted = [...latest.values()]
          .filter((v) => v.manifest.resourceId > cursor)
          .sort((a, b) => a.manifest.resourceId.localeCompare(b.manifest.resourceId));
        const items = sorted.slice(0, limit);
        return {
          items,
          nextCursor: sorted.length > limit ? items[items.length - 1].manifest.resourceId : null,
        } as T;
      }
      if (path.endsWith('/head')) {
        const id = path.split('/')[3];
        const entries = [...versions.values()].filter((v) => v.manifest.resourceId === id);
        const gone = backend.deletedHeads?.get(id);
        if (!entries.length && gone)
          return { resourceId: id, headVersion: gone, deleted: true } as T;
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
      if (method === 'DELETE' && path.includes('/versions/')) {
        // The backend's DELETE /v1/resources/<id>/versions/<n>: counted before it is looked at,
        // refused while pinned elsewhere; the last one marks the resource deleted.
        if (deleteWindow > 0 && deletesInWindow >= deleteWindow) {
          deletesInWindow = 0;
          throw new CloudError('rate_limited', 'Rate limit', 429, undefined, 1000);
        }
        deletesInWindow++;
        const parts = path.split('/');
        const key = `${parts[3]}:${parts[5]}`;
        if (!versions.has(key))
          throw new CloudError('not_found', 'Cloud resource was not found.', 404);
        if (backend.inUse?.has(key))
          throw new CloudError('version_in_use', 'This exact version is still referenced.', 409);
        const high = Math.max(
          ...[...versions.values()]
            .filter((v) => v.manifest.resourceId === parts[3])
            .map((v) => v.version),
        );
        versions.delete(key);
        if (![...versions.values()].some((v) => v.manifest.resourceId === parts[3]))
          (backend.deletedHeads ??= new Map()).set(parts[3], high);
        return { deleted: true } as T;
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
    backend,
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
    /** At most `n` DELETEs per window; the next one is refused with 429 (`retryAfterMs` 1000). */
    limitDeletes(n: number) {
      deleteWindow = n;
      deletesInWindow = 0;
    },
    async cleanup() {
      await jobs.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
