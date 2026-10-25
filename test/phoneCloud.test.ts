// test/phoneCloud.test.ts — AASC-51: a phone browses AASC Cloud read-only, through the Mac's own connection.
//
// The phone holds no cloud credential that reads resources or projects (PHONE_BACKEND_SCOPES is push:register and mac-paths:read),
// and every desktop cloud route sits behind the RESOURCES local gate. So the Mac reads the account's resources
// and projects for it, keeps the answer a minute, and hands over names, kinds, versions, dates and sizes:
// never a path, a hash, a description, the backend origin, the account, a device id or a token.
import { createServer, type Server } from 'node:http';
import express from 'express';
import { describe, it, expect, afterEach } from 'vitest';
import {
  createPhoneCloud,
  createPhoneCloudRouter,
  PhoneCloudBusyError,
  PHONE_CLOUD_TTL_MS,
  PHONE_CLOUD_REFRESH_MIN_MS,
  PHONE_CLOUD_FAILURE_COOLDOWN_MS,
  PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE,
  PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE,
  PHONE_CLOUD_VERSIONS_LIMIT,
  PHONE_CLOUD_PROBLEMS,
} from '../server/mobile/phoneCloud.js';
import { createCloudReadLog } from '../server/mobile/cloudReadLog.js';
import { createPhoneProfile } from '../server/mobile/phoneProfile.js';
import { CloudError, type CloudConnector, type CloudStatus } from '../server/cloud/types.js';

const RES_A = '0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c';
const RES_B = '1c7f8b4d-2a3e-4f6b-8c9d-8e7f6a5b4c3d';
const RES_C = '2d8a9c5e-3b4f-4a7c-9dae-9f8a7b6c5d4e';
const PROJ_1 = '3e9bad6f-4c5a-4b8d-8ebf-a09b8c7d6e5f';
const PROJ_2 = '4fac0e7a-5d6b-4c9e-9fca-b1ac9d8e7f6a';
const SHA = (n: number) => String(n).padStart(64, 'a').slice(-64).replace(/[^a-f0-9]/g, 'a');
const uuid = (n: number) => `6bce2a9c-7f8d-4ebc-9bec-d3cebfa0${String(n).padStart(4, '0')}`;
/** `count` pages chained by cursor, each holding what `items(i)` returns. */
const chained = (count: number, items: (i: number) => unknown[]) =>
  Array.from({ length: count }, (_, i) => ({ items: items(i), nextCursor: i + 1 < count ? uuid(9000 + i) : null }));

function version(resourceId: string, v: number, over: { name?: string; kind?: string; createdAt?: string; files?: number[] } = {}) {
  const files = (over.files ?? [100, 2400]).map((bytes, i) => ({ path: `skills/secret-dir/file-${i}.md`, sha256: SHA(i + v), bytes, mode: 0o644 }));
  return {
    manifest: {
      resourceId, agent: 'claude', kind: over.kind ?? 'skill', name: over.name ?? 'retouch', scope: 'global', projectId: null,
      files, dependencies: [],
    },
    version: v,
    digest: SHA(900 + v),
    createdAt: over.createdAt ?? `2026-10-${String(Math.min(28, v)).padStart(2, '0')}T08:00:00.000Z`,
  };
}

function project(id: string, name: string, over: { deleted?: boolean; branch?: string } = {}) {
  const owner = 'kason';
  const repo = name.toLowerCase().replace(/\s+/g, '-');
  return {
    id, version: 3, name,
    repository: { provider: 'github', owner, name: repo, url: `https://github.com/${owner}/${repo}`, branch: over.branch ?? 'main' },
    description: 'private notes about the project',
    resources: [{ resourceId: RES_A, version: 2 }],
    deleted: over.deleted ?? false,
  };
}

interface FakeCloud extends CloudConnector {
  calls: string[];
  state: CloudStatus['state'];
  lastError: string | null;
  account: string;
  fail: CloudError | null;
  /** Deleted versions answer not_found. */
  gone: Set<string>;
  resourcePages: unknown[];
  projectPages: unknown[];
  heads: Map<string, number>;
}

function fakeCloud(): FakeCloud {
  const cloud = {
    calls: [] as string[],
    state: 'connected' as CloudStatus['state'],
    lastError: null as string | null,
    account: 'acct-1',
    fail: null as CloudError | null,
    gone: new Set<string>(),
    resourcePages: [
      { items: [version(RES_A, 2, { name: 'retouch', createdAt: '2026-10-10T08:00:00.000Z' }), version(RES_B, 1, { name: 'deploy', kind: 'command', createdAt: '2026-10-14T08:00:00.000Z', files: [10] })], nextCursor: RES_B },
      { items: [version(RES_C, 12, { name: 'house rules', kind: 'rule', createdAt: '2026-10-12T08:00:00.000Z' }), { manifest: { bogus: true }, version: 1 }], nextCursor: null },
    ],
    projectPages: [
      { items: [project(PROJ_1, 'Website'), project(PROJ_2, 'Agent Manager', { branch: 'release/2.10' }), project('5abd1f8b-6e7c-4dab-8adb-c2bdae9f8a7b', 'Old', { deleted: true })], nextCursor: null },
    ],
    heads: new Map([[RES_A, 2], [RES_B, 1], [RES_C, 12]]),
    client: {
      async request<T>(method: string, path: string): Promise<T> {
        cloud.calls.push(`${method} ${path}`);
        if (cloud.fail) throw cloud.fail;
        const url = new URL(path, 'http://x');
        const cursor = url.searchParams.get('cursor');
        // The page after the one whose nextCursor this is.
        const page = (pages: unknown[]) =>
          (cursor ? pages.find((_, i) => i > 0 && (pages[i - 1] as { nextCursor: string | null }).nextCursor === cursor) : pages[0]) as T;
        if (url.pathname === '/v1/resources') return page(cloud.resourcePages);
        if (url.pathname === '/v1/projects') return page(cloud.projectPages);
        const m = /^\/v1\/resources\/([0-9a-f-]+)\/versions\/(\d+)$/.exec(url.pathname);
        if (m) {
          if (cloud.gone.has(`${m[1]}@${m[2]}`)) throw new CloudError('not_found', 'Cloud resource was not found.', 404);
          return version(m[1], Number(m[2]), { name: 'house rules', kind: 'rule', files: [1000 * Number(m[2])] }) as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
    status(): CloudStatus {
      return {
        state: cloud.state,
        lastError: cloud.lastError,
        connection: cloud.state === 'disconnected' ? null : {
          backendOrigin: 'https://be.example', accountId: cloud.account, deviceId: 'mac-device-secret', deviceName: 'Mac', generation: 1,
        },
      };
    },
  } as unknown as FakeCloud;
  return cloud;
}

const LEAKS = ['be.example', 'acct-1', 'mac-device-secret', 'secret-dir', 'sha256', 'digest', 'private notes', 'github.com/kason', 'aaaa', 'token', 'description', 'url'];

describe('status', () => {
  it('without a cloud connection: not connected, nothing read', async () => {
    const none = createPhoneCloud({ cloud: null });
    expect(none.status()).toEqual({ connected: false, state: 'not-connected', lastSyncAt: null, problem: null });
    const cloud = fakeCloud();
    cloud.state = 'disconnected';
    const phoneCloud = createPhoneCloud({ cloud });
    expect(await phoneCloud.browse()).toEqual({
      connected: false, state: 'not-connected', lastSyncAt: null, problem: null, resources: [], projects: [], truncated: false,
    });
    expect((await phoneCloud.versions(RES_A)).versions).toEqual([]);
    expect(cloud.calls).toEqual([]);
  });

  it('a revoked Mac says so in plain words and reads nothing', async () => {
    const cloud = fakeCloud();
    cloud.state = 'revoked';
    const phoneCloud = createPhoneCloud({ cloud });
    const browse = await phoneCloud.browse();
    expect(browse).toMatchObject({ connected: false, state: 'revoked', problem: PHONE_CLOUD_PROBLEMS.revoked, resources: [], projects: [] });
    expect(browse.problem).toMatch(/RESOURCES → Cloud → Connection/);
    expect(cloud.calls).toEqual([]);
  });

  it('a saved connection nothing has checked since the Mac started is “unchecked”, and status never calls the backend', () => {
    const cloud = fakeCloud();
    cloud.state = 'offline';
    expect(createPhoneCloud({ cloud }).status()).toEqual({ connected: true, state: 'unchecked', lastSyncAt: null, problem: null });
    cloud.lastError = 'Cloud is offline. Check the connection and try again.';
    // The connector's own message never crosses: the phone gets AASC's fixed words.
    expect(createPhoneCloud({ cloud }).status()).toEqual({ connected: true, state: 'offline', lastSyncAt: null, problem: PHONE_CLOUD_PROBLEMS.offline });
    expect(cloud.calls).toEqual([]);
  });
});

describe('browse', () => {
  it('reads every page of resources and projects, in the narrowest shape', async () => {
    let t = Date.parse('2026-10-16T09:00:00.000Z');
    const cloud = fakeCloud();
    const phoneCloud = createPhoneCloud({ cloud, now: () => t });
    const browse = await phoneCloud.browse();
    // Resources and projects are read side by side.
    expect([...cloud.calls].sort()).toEqual([
      'GET /v1/projects?limit=100', 'GET /v1/resources?limit=100', `GET /v1/resources?limit=100&cursor=${RES_B}`,
    ]);
    expect(browse).toMatchObject({ connected: true, state: 'connected', lastSyncAt: '2026-10-16T09:00:00.000Z', problem: null, truncated: false });
    // Newest first; the malformed item is dropped.
    expect(browse.resources).toEqual([
      { id: RES_B, name: 'deploy', kind: 'command', agent: 'claude', scope: 'global', version: 1, updatedAt: '2026-10-14T08:00:00.000Z', bytes: 10, files: 1 },
      { id: RES_C, name: 'house rules', kind: 'rule', agent: 'claude', scope: 'global', version: 12, updatedAt: '2026-10-12T08:00:00.000Z', bytes: 2500, files: 2 },
      { id: RES_A, name: 'retouch', kind: 'skill', agent: 'claude', scope: 'global', version: 2, updatedAt: '2026-10-10T08:00:00.000Z', bytes: 2500, files: 2 },
    ]);
    // A–Z, deleted ones left out; GitHub host, owner, repository name and default branch only.
    expect(browse.projects).toEqual([
      { id: PROJ_2, name: 'Agent Manager', host: 'github.com', owner: 'kason', repo: 'agent-manager', branch: 'release/2.10', resources: 1 },
      { id: PROJ_1, name: 'Website', host: 'github.com', owner: 'kason', repo: 'website', branch: 'main', resources: 1 },
    ]);
    const text = JSON.stringify(browse);
    for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
    t += 1;
  });

  it('a resource named by a path inside a project reaches the phone as its file name only', async () => {
    const cloud = fakeCloud();
    const nested = (n: number, name: string) => {
      const v = version(uuid(n), 1, { name, kind: 'instruction' });
      return { ...v, manifest: { ...v.manifest, scope: 'project', projectId: PROJ_1 } };
    };
    cloud.resourcePages = [{
      items: [nested(1, 'packages/api/CLAUDE.md'), nested(2, '.claude/CLAUDE.md'), nested(3, 'services\\billing\\AGENTS.md'), nested(4, 'CLAUDE.md'), version(RES_A, 2)],
      nextCursor: null,
    }];
    const phoneCloud = createPhoneCloud({ cloud });
    const browse = await phoneCloud.browse();
    expect(browse.resources.map((r) => r.name).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'CLAUDE.md', 'CLAUDE.md', 'retouch']);
    const versions = await phoneCloud.versions(uuid(1));
    expect(versions.resource).toMatchObject({ name: 'CLAUDE.md', kind: 'instruction', scope: 'project' });
    for (const name of [...browse.resources, versions.resource!].map((r) => r.name)) expect(name).not.toMatch(/[/\\]/);
    for (const leak of ['packages', 'api/', 'services', 'billing', '.claude']) expect(JSON.stringify({ browse, versions }), leak).not.toContain(leak);
  });

  it('answers from one read for a minute; a refresh reads again at most every 10 s; callers share a read', async () => {
    let t = 1_000_000;
    const cloud = fakeCloud();
    const phoneCloud = createPhoneCloud({ cloud, now: () => t });
    await Promise.all([phoneCloud.browse(), phoneCloud.browse()]);
    expect(cloud.calls).toHaveLength(3);
    t += PHONE_CLOUD_REFRESH_MIN_MS - 1;
    await phoneCloud.browse({ refresh: true });
    expect(cloud.calls).toHaveLength(3);
    t += 2;
    await phoneCloud.browse({ refresh: true });
    expect(cloud.calls).toHaveLength(6);
    t += PHONE_CLOUD_TTL_MS - 1;
    await phoneCloud.browse();
    expect(cloud.calls).toHaveLength(6);
    t += 2;
    await phoneCloud.browse();
    expect(cloud.calls).toHaveLength(9);
  });

  it('reads a saved connection nothing has checked yet, and then reports it connected', async () => {
    const cloud = fakeCloud();
    cloud.state = 'offline';
    const phoneCloud = createPhoneCloud({ cloud });
    const browse = await phoneCloud.browse();
    expect(browse.resources).toHaveLength(3);
    expect(browse.lastSyncAt).not.toBeNull();
  });

  it('a failed read says what went wrong, keeps the last good answer, and waits before trying again', async () => {
    let t = 5_000_000;
    const cloud = fakeCloud();
    const phoneCloud = createPhoneCloud({ cloud, now: () => t });
    await phoneCloud.browse();
    const synced = phoneCloud.status().lastSyncAt;
    t += PHONE_CLOUD_TTL_MS + 1;
    cloud.fail = new CloudError('forbidden', 'This device does not have permission for this cloud action.', 403);
    const failed = await phoneCloud.browse();
    expect(failed.resources).toHaveLength(3);
    expect(failed.problem).toBe(PHONE_CLOUD_PROBLEMS.forbidden);
    expect(failed.lastSyncAt).toBe(synced);
    const calls = cloud.calls.length;
    t += PHONE_CLOUD_FAILURE_COOLDOWN_MS - 1;
    await phoneCloud.browse();
    expect(cloud.calls).toHaveLength(calls);
    t += 2;
    cloud.fail = null;
    const back = await phoneCloud.browse();
    expect(cloud.calls.length).toBeGreaterThan(calls);
    expect(back.problem).toBeNull();
  });

  it('maps each failure to AASC’s own words, never the backend’s', async () => {
    for (const [error, words] of [
      [new CloudError('offline', 'Cloud is offline. Check the connection and try again.'), PHONE_CLOUD_PROBLEMS.offline],
      [new CloudError('rate_limited', 'Cloud rate limit reached.', 429), PHONE_CLOUD_PROBLEMS.busy],
      [new CloudError('cancelled', 'Cloud request cancelled or timed out.'), PHONE_CLOUD_PROBLEMS.slow],
      [new CloudError('backend_error', 'Cloud request failed.'), PHONE_CLOUD_PROBLEMS.backend],
      [new Error('ECONNRESET at https://be.example/v1/resources'), PHONE_CLOUD_PROBLEMS.offline],
    ] as const) {
      const cloud = fakeCloud();
      cloud.fail = error;
      const browse = await createPhoneCloud({ cloud }).browse();
      expect(browse.problem, error.message).toBe(words);
      expect(JSON.stringify(browse)).not.toContain('be.example');
    }
  });

  it('never shows one account’s cloud to another', async () => {
    const cloud = fakeCloud();
    const phoneCloud = createPhoneCloud({ cloud });
    expect((await phoneCloud.browse()).resources).toHaveLength(3);
    cloud.account = 'acct-2';
    cloud.fail = new CloudError('offline', 'x');
    const other = await phoneCloud.browse();
    expect(other.resources).toEqual([]);
    expect(other.lastSyncAt).toBeNull();
  });

  it(`a listing costs one backend request per page: at most ${PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE} a minute, then the last answer`, async () => {
    let t = 9_000_000;
    const cloud = fakeCloud();
    // 8 pages of resources and 7 of projects: every listing is 15 backend requests.
    cloud.resourcePages = chained(8, (i) => [version(uuid(i), 1)]);
    cloud.projectPages = chained(7, (i) => [project(uuid(100 + i), `Project ${i}`)]);
    const phoneCloud = createPhoneCloud({ cloud, now: () => t });
    expect((await phoneCloud.browse()).resources).toHaveLength(8);
    expect(cloud.calls).toHaveLength(15);
    // A refresh every 10 s for the rest of the minute: never more requests than the budget,
    // and a listing the budget stops part-way changes nothing and is no failure.
    for (let i = 0; i < 5; i++) {
      t += PHONE_CLOUD_REFRESH_MIN_MS + 1;
      const browse = await phoneCloud.browse({ refresh: true });
      expect(browse.resources).toHaveLength(8);
      expect(browse.problem).toBeNull();
    }
    expect(cloud.calls).toHaveLength(PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE);
    // Another account, with nothing read before: asked to wait.
    cloud.account = 'acct-2';
    await expect(phoneCloud.browse()).rejects.toBeInstanceOf(PhoneCloudBusyError);
    expect(cloud.calls).toHaveLength(PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE);
    // The next minute reads at once (no failure cooldown).
    t += 60_000;
    expect((await phoneCloud.browse()).resources).toHaveLength(8);
    expect(cloud.calls).toHaveLength(PHONE_CLOUD_LIST_REQUESTS_PER_MINUTE + 15);
  });

  it(`version reads have their own budget, one per version read: at most ${PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE} a minute`, async () => {
    let t = 9_000_000;
    const cloud = fakeCloud();
    const histories = PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE / PHONE_CLOUD_VERSIONS_LIMIT;
    const ids = Array.from({ length: histories + 1 }, (_, i) => uuid(i));
    cloud.resourcePages = [{ items: ids.map((id) => version(id, 12)), nextCursor: null }];
    const phoneCloud = createPhoneCloud({ cloud, now: () => t });
    await phoneCloud.browse();
    const listing = cloud.calls.length;
    for (const id of ids.slice(0, histories)) expect((await phoneCloud.versions(id)).versions).toHaveLength(PHONE_CLOUD_VERSIONS_LIMIT);
    const versionCalls = () => cloud.calls.filter((c) => c.includes('/versions/')).length;
    expect(versionCalls()).toBe(PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE);
    await expect(phoneCloud.versions(ids.at(-1)!)).rejects.toBeInstanceOf(PhoneCloudBusyError);
    expect(versionCalls()).toBe(PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE);
    // Version reads spent nothing of the listing's budget.
    t += PHONE_CLOUD_REFRESH_MIN_MS + 1;
    await phoneCloud.browse({ refresh: true });
    expect(cloud.calls.length - versionCalls()).toBe(listing * 2);
    t += 60_000;
    expect((await phoneCloud.versions(ids.at(-1)!)).versions).toHaveLength(PHONE_CLOUD_VERSIONS_LIMIT);
  });
});

describe('versions', () => {
  it(`reads the latest ${PHONE_CLOUD_VERSIONS_LIMIT} versions newest first, skipping deleted ones`, async () => {
    const cloud = fakeCloud();
    cloud.gone.add(`${RES_C}@7`);
    const phoneCloud = createPhoneCloud({ cloud });
    const answer = await phoneCloud.versions(RES_C);
    const reads = cloud.calls.filter((c) => c.includes('/versions/'));
    expect(reads).toHaveLength(PHONE_CLOUD_VERSIONS_LIMIT);
    expect(reads[0]).toBe(`GET /v1/resources/${RES_C}/versions/12`);
    expect(reads.at(-1)).toBe(`GET /v1/resources/${RES_C}/versions/3`);
    expect(answer.resource).toMatchObject({ id: RES_C, name: 'house rules', version: 12 });
    expect(answer.versions.map((v) => v.version)).toEqual([12, 11, 10, 9, 8, 6, 5, 4, 3]);
    expect(answer.versions[0]).toEqual({ version: 12, createdAt: '2026-10-12T08:00:00.000Z', bytes: 12000, files: 1 });
    expect(answer.truncated).toBe(true);
    for (const leak of LEAKS) expect(JSON.stringify(answer), leak).not.toContain(leak);
    // Kept for a minute.
    const before = cloud.calls.length;
    await phoneCloud.versions(RES_C);
    expect(cloud.calls).toHaveLength(before);
  });

  it('a short history is complete; a resource not in the listing reads nothing', async () => {
    const cloud = fakeCloud();
    const phoneCloud = createPhoneCloud({ cloud });
    const a = await phoneCloud.versions(RES_A);
    expect(a.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(a.truncated).toBe(false);
    const before = cloud.calls.length;
    const unknown = await phoneCloud.versions('7cdf3bad-8a9e-4fcd-8cfd-e4dfc0b1c2d3');
    expect(unknown).toMatchObject({ resource: null, versions: [], truncated: false });
    expect(cloud.calls).toHaveLength(before);
  });
});

describe('last sync, shared with the skill-note favourites', () => {
  it('a favourites read through the same connection counts as a sync, and its failure as the problem', () => {
    let t = Date.parse('2026-10-16T10:00:00.000Z');
    const cloud = fakeCloud();
    const reads = createCloudReadLog(() => t);
    const phoneCloud = createPhoneCloud({ cloud, reads, now: () => t });
    const identity = JSON.stringify(['https://be.example', 'acct-1', 1]);
    reads.succeeded(identity);
    expect(phoneCloud.status().lastSyncAt).toBe('2026-10-16T10:00:00.000Z');
    t += 1000;
    reads.failed(identity, 'offline');
    expect(phoneCloud.status()).toMatchObject({ state: 'connected', problem: PHONE_CLOUD_PROBLEMS.offline, lastSyncAt: '2026-10-16T10:00:00.000Z' });
  });
});

// ── The routes, through the phone profile ────────────────────────────────────────────────────────────────

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(cloud: CloudConnector | null): Promise<string> {
  const app = express();
  const profile = createPhoneProfile({
    phoneOf: (req) => (req.get('x-phone') ? 'phone-1234567890' : null),
    sharedProjectPaths: () => [],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    foregroundProcess: () => null,
  });
  app.use('/api', profile, createPhoneCloudRouter(createPhoneCloud({ cloud })));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const phone = { headers: { 'x-phone': '1' } };

describe('GET /api/phone-cloud/* from a paired phone', () => {
  it('status, browse and a resource’s versions, read-only and never cached by the phone', async () => {
    const cloud = fakeCloud();
    const base = await serve(cloud);
    const status = await fetch(`${base}/api/phone-cloud/status`, phone);
    expect(status.status).toBe(200);
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toEqual({ connected: true, state: 'connected', lastSyncAt: null, problem: null });
    expect(cloud.calls).toEqual([]);

    const browse = await fetch(`${base}/api/phone-cloud/browse`, phone);
    expect(browse.status).toBe(200);
    const body = (await browse.json()) as { resources: unknown[]; projects: unknown[] };
    expect(Object.keys(body).sort()).toEqual(['connected', 'lastSyncAt', 'problem', 'projects', 'resources', 'state', 'truncated']);
    expect(body.resources).toHaveLength(3);
    expect(body.projects).toHaveLength(2);

    const versions = await fetch(`${base}/api/phone-cloud/resources/${RES_A}/versions`, phone);
    expect(versions.status).toBe(200);
    expect(((await versions.json()) as { versions: unknown[] }).versions).toHaveLength(2);

    for (const res of [browse, versions]) expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers “not connected” and empty lists, never an error page, without a cloud connection', async () => {
    const base = await serve(null);
    expect(await (await fetch(`${base}/api/phone-cloud/browse`, phone)).json()).toEqual({
      connected: false, state: 'not-connected', lastSyncAt: null, problem: null, resources: [], projects: [], truncated: false,
    });
    expect(await (await fetch(`${base}/api/phone-cloud/resources/${RES_A}/versions`, phone)).json()).toEqual({
      connected: false, state: 'not-connected', lastSyncAt: null, problem: null, resource: null, versions: [], truncated: false,
    });
  });

  it('validates its inputs: a resource id is a canonical uuid, the only query is refresh=1', async () => {
    const base = await serve(fakeCloud());
    for (const path of [
      '/phone-cloud/resources/not-a-uuid/versions',
      `/phone-cloud/resources/${RES_A.toUpperCase()}/versions`,
      '/phone-cloud/browse?refresh=yes',
      '/phone-cloud/browse?cursor=x',
      '/phone-cloud/status?x=1',
    ]) {
      const res = await fetch(`${base}/api${path}`, phone);
      expect(res.status, path).toBe(400);
    }
    expect((await fetch(`${base}/api/phone-cloud/browse?refresh=1`, phone)).status).toBe(200);
  });

  it('is GET-only for a phone, and nothing else under /phone-cloud opens', async () => {
    const base = await serve(fakeCloud());
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/phone-cloud/status', '/phone-cloud/browse', `/phone-cloud/resources/${RES_A}/versions`]) {
        const res = await fetch(`${base}/api${path}`, { method, headers: { 'x-phone': '1' } });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(((await res.json()) as { code?: string }).code).toBe('PHONE_NOT_ALLOWED');
      }
    }
    for (const path of ['/phone-cloud', '/phone-cloud/resources', `/phone-cloud/resources/${RES_A}`, `/phone-cloud/resources/${RES_A}/versions/2`]) {
      const res = await fetch(`${base}/api${path}`, phone);
      expect(res.status, path).toBe(404);
    }
  });

  it('asks the phone to wait when the backend has been read too often, with a retry time', async () => {
    let t = 0;
    const cloud = fakeCloud();
    const ids = Array.from({ length: PHONE_CLOUD_VERSION_REQUESTS_PER_MINUTE / PHONE_CLOUD_VERSIONS_LIMIT + 1 }, (_, i) => uuid(i));
    cloud.resourcePages = [{ items: ids.map((id) => version(id, 12)), nextCursor: null }];
    const app = express();
    app.use('/api', createPhoneCloudRouter(createPhoneCloud({ cloud, now: () => t })));
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    await fetch(`${base}/api/phone-cloud/browse`);
    for (const id of ids.slice(0, -1)) await fetch(`${base}/api/phone-cloud/resources/${id}/versions`);
    t += 1000;
    const res = await fetch(`${base}/api/phone-cloud/resources/${ids.at(-1)}/versions`);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { code: string; retryAfter: number; error: string };
    expect(body.code).toBe('PHONE_CLOUD_LIMIT');
    expect(body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(body.retryAfter).toBeLessThanOrEqual(60);
  });
});
