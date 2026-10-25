// AASC-62/63 against the real backend code (AASC_TEST_BE_ROOT, else skipped): two Macs on one
// account sync a skill through the real resource API, and a project is saved and removed through
// the real project API (DELETE /v1/projects/<id>). Real job store, scanner, installer and HTTP.
import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backendRoot, backendFixture } from './cloudBackendFixture.js';
import { nativeSqlite } from './helpers/nativeSqlite.js';
import { createCloudTransport } from '../server/cloud/client.js';
import { scanResources } from '../server/resourceScanner.js';
import { createResourceJobs } from '../server/cloud/resourceJobs.js';
import { createProjectJobs } from '../server/cloud/projectJobs.js';
import type { CloudConnector } from '../server/cloud/types.js';

const realIt = backendRoot && nativeSqlite ? it : it.skip;
const SKILL = (body: string) => `---\nname: demo\ndescription: real backend\n---\n${body}`;

async function backendDevice(origin: string, token: string, accountId: string) {
  const transport = createCloudTransport({ timeoutMs: 10000 });
  const binding = { backendOrigin: origin, accountId, generation: 1 };
  const cloud = {
    client: {
      request: <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
        transport.send<T>(origin, method, path, body, token, signal),
      stream: (
        path: string,
        consume: (b: ReadableStream<Uint8Array>) => Promise<void>,
        signal?: AbortSignal,
      ) => transport.send<void>(origin, 'GET', path, undefined, token, signal, consume),
    },
    status: () => ({
      connection: { ...binding, deviceId: randomUUID(), deviceName: 'real backend test' },
      state: 'connected',
      lastError: null,
    }),
    onStop: () => () => {},
  } as unknown as CloudConnector;
  return { cloud, binding, transport };
}
async function mac(cloud: CloudConnector, skill?: string) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'aasc-real-sync-')));
  if (skill) {
    await mkdir(join(home, '.claude', 'skills', 'demo'), { recursive: true });
    await writeFile(join(home, '.claude', 'skills', 'demo', 'SKILL.md'), skill);
  }
  let scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
  const rescan = async () => {
    scan = await scanResources({ home, env: {}, sessionProjectPaths: [], extraRoots: [] });
  };
  const catalog = {
    publicationInternals: () => [...scan.internals.values()],
    getCatalog: () => ({ ...scan, state: 'ready' }),
    startScan: () => {},
    whenIdle: rescan,
  } as never;
  const jobs = await createResourceJobs({
    cloud,
    catalog,
    roots: {
      claudeRoot: join(home, '.claude'),
      codexRoot: join(home, '.codex'),
      sharedRoot: join(home, '.agents'),
    },
    directory: join(home, 'private'),
  });
  return {
    home,
    jobs,
    rescan,
    skillFile: join(home, '.claude', 'skills', 'demo', 'SKILL.md'),
    get demo() {
      return [...scan.internals.values()].find((r) => r.summary.name === 'demo')!;
    },
    async close() {
      await jobs.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

realIt(
  'two Macs sync a skill through the real resource API, and a project is saved and removed',
  async () => {
    const f = await backendFixture();
    const devices = await f.load('src/core/devices.ts');
    const service = devices.createDeviceService({ store: f.store, now: Date.now });
    const issued = await service.issuePairingCode({
      ownerId: f.ownerId,
      scopes: ['resources:read', 'resources:write', 'projects:read', 'projects:write'],
    });
    const paired = await service.pairDevice({ code: issued.code, name: 'AASC-62/63 test' });
    const { cloud, binding, transport } = await backendDevice(f.origin, paired.token, f.ownerId);
    const a = await mac(cloud, SKILL('One'));
    const b = await mac(cloud);
    try {
      // A saves the skill; B sees it as only in the cloud and brings it down.
      const plan = await a.jobs.buildPublicationPlan(
        [{ resourceId: a.demo.summary.id, include: true }],
        binding,
      );
      expect(plan.blocked).toEqual([]);
      expect((await a.jobs.wait((await a.jobs.publishPlan(plan.id, binding)).id)).state).toBe(
        'complete',
      );
      expect((await a.jobs.syncStatus(binding)).items.map((i) => i.state)).toEqual(['synced']);
      expect((await b.jobs.syncStatus(binding)).items.map((i) => i.state)).toEqual([
        'cloud-only',
      ]);
      for (const job of (await b.jobs.syncNow({}, binding)).jobs)
        expect((await b.jobs.wait(job.id)).state).toBe('complete');
      await b.rescan();
      expect(await readFile(b.skillFile, 'utf8')).toBe(SKILL('One'));
      expect((await b.jobs.syncStatus(binding)).items[0]).toMatchObject({
        state: 'synced',
        cloudVersion: 1,
      });
      // A edits and syncs; B reads Newer in cloud and gets version 2.
      await writeFile(a.skillFile, SKILL('Two'));
      await a.rescan();
      expect((await a.jobs.syncStatus(binding)).items[0].state).toBe('local-changed');
      for (const job of (await a.jobs.syncNow({}, binding)).jobs) await a.jobs.wait(job.id);
      expect((await b.jobs.syncStatus(binding)).items[0]).toMatchObject({
        state: 'cloud-newer',
        cloudVersion: 2,
        syncedVersion: 1,
      });
      for (const job of (await b.jobs.syncNow({}, binding)).jobs) await b.jobs.wait(job.id);
      await b.rescan();
      expect(await readFile(b.skillFile, 'utf8')).toBe(SKILL('Two'));

      // Projects: only the repository is saved; Remove deletes the record through the real API.
      const git = {
        inspectCheckout: vi.fn(),
        clone: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fetch: vi.fn(),
        recoverPublishedClone: vi.fn(),
        readOrigin: vi.fn(async () => null),
      };
      const projects = await createProjectJobs({
        cloud,
        resources: a.jobs,
        git: git as never,
        home: a.home,
        accounts: { list: vi.fn(), account: vi.fn() } as never,
      });
      const id = randomUUID();
      const saved = await projects.saveProject(
        {
          mutationId: randomUUID(),
          baseVersion: null,
          value: {
            id,
            version: 1,
            name: 'repo',
            description: '',
            resources: [],
            deleted: false,
            repository: {
              provider: 'github',
              owner: 'fixture',
              name: 'repo',
              url: 'https://github.com/fixture/repo',
              branch: 'main',
            },
          },
        },
        binding,
      );
      expect(saved).toMatchObject({ id, version: 1, deleted: false });
      const removed = await projects.removeProject(id, binding);
      expect(removed).toMatchObject({ id, version: 2, deleted: true });
      const listed = await projects.listProjects({}, binding);
      expect(listed.items.filter((p) => p.id === id && !p.deleted)).toEqual([]);
      await projects.close();
    } finally {
      await a.close();
      await b.close();
      transport.abort();
      await f.close();
    }
  },
  60000,
);
