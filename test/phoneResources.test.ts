// test/phoneResources.test.ts — plan 16, P1: a paired phone reads the desktop's Library, Cloud sync and
// Projects through the Mac (server/mobile/phoneResources.ts + phoneResourcesRouter.ts).
//
// What it must hold: project resources reach a phone only for a project with a shared session (the
// `/commands` rule); use counts cover the shared sessions only; paths cross as `~/…`; AASC Cloud and
// git are read at most every 10 s; a failed read keeps the last answer; only these GETs open to a phone.
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPhoneResources, displayPath, PHONE_RESOURCES_REFRESH_MIN_MS, PHONE_RESOURCES_SCANNING, PHONE_RESOURCES_TTL_MS,
  type PhoneResourcesDeps,
} from '../server/mobile/phoneResources.js';
import { createOpenProjects, redactSyncItem, visibleFilter } from '../server/mobile/phoneResourceRedact.js';
import { createPhoneResourcesRouter } from '../server/mobile/phoneResourcesRouter.js';
import { createPhoneProfile, phoneRuleFor } from '../server/mobile/phoneProfile.js';
import { PHONE_CLOUD_PROBLEMS } from '../server/mobile/phoneCloud.js';
import { CloudError, type CloudConnector, type CloudStatus } from '../server/cloud/types.js';
import { ResourceLookupError, type ResourceCatalogService } from '../server/resourceCatalog.js';
import type { ResourceCatalog, ResourceSummary } from '../src/types/resources.js';
import type { SyncItem } from '../src/types/cloudResources.js';
import type { TokenUse } from '../server/resourceUsage.js';

let home: string;
let shared: string;
let hidden: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-phone-resources-')));
  shared = join(home, 'code', 'shared-app');
  hidden = join(home, 'code', 'private-app');
  mkdirSync(shared, { recursive: true });
  mkdirSync(hidden, { recursive: true });
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const ID = (n: number) => n.toString(16).padStart(16, '0');
const CLOUD_ID = (n: number) => `0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b${String(n).padStart(2, '0')}`;
const PROJ = '3e9bad6f-4c5a-4b8d-8ebf-a09b8c7d6e5f';

function summary(n: number, over: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: ID(n), name: `skill-${n}`, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown',
    path: `~/.claude/skills/skill-${n}`, fileCount: 1, bytes: 10, mtimeMs: 0, repo: { status: 'not-tracked' },
    variantIds: [], findingCodes: [], ...over,
  };
}

function catalogOf(): ResourceCatalog {
  return {
    state: 'ready',
    scannedAt: 1_000,
    roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: null },
    projects: [
      { id: 'p-shared', name: 'shared-app', path: '~/code/shared-app', exists: true, evidence: ['aasc-session'], counts: {} },
      { id: 'p-hidden', name: 'private-app', path: '~/code/private-app', exists: true, evidence: ['aasc-session'], counts: {} },
    ],
    resources: [
      summary(1, { name: 'rar' }),
      summary(2, { name: 'deploy', scope: 'project', projectId: 'p-shared', path: '~/code/shared-app/.claude/skills/deploy' }),
      summary(3, { name: 'secret-plan', scope: 'project', projectId: 'p-hidden', path: '~/code/private-app/.claude/skills/secret-plan' }),
      summary(4, { name: 'MEMORY.md', type: 'memory', projectId: 'p-hidden', path: '~/.claude/projects/x/memory/MEMORY.md' }),
    ],
    findings: [],
    coverage: [],
  };
}

function fakeCatalog(catalog = catalogOf()): ResourceCatalogService & { started: number } {
  const service = {
    started: 0,
    getCatalog: () => catalog,
    getOrStartCatalog: () => {
      service.started++;
      return catalog;
    },
    getDetail: async (id: string) => ({ summary: catalog.resources.find((r) => r.id === id)!, body: `body of ${id}`, findings: [] }),
    getFile: async (id: string, path: string) => ({ path, bytes: 4, content: `${id}:${path}` }),
  };
  return service as unknown as ResourceCatalogService & { started: number };
}

function fakeUsage() {
  const counts = vi.fn((_ids?: readonly string[] | null): ReadonlyMap<string, TokenUse> | null =>
    new Map([['/rar', { typed: 3, agent: 1, lastAt: 500 }], ['/deploy', { typed: 2, agent: 0, lastAt: 400 }]]),
  );
  return { counts };
}

function fakeCloud(state: CloudStatus['state'] = 'connected'): CloudConnector {
  const status: CloudStatus = {
    connection: { backendOrigin: 'https://api.example.test', accountId: '5bce2a9c-7f8d-4ebc-9bec-d3cebfa00001', deviceId: 'd', deviceName: 'Mac', generation: 2 },
    state,
    lastError: null,
  };
  return { status: () => status } as unknown as CloudConnector;
}

function item(n: number, over: Partial<SyncItem> = {}): SyncItem {
  return {
    resourceId: CLOUD_ID(n), catalogId: ID(n), name: `skill-${n}`, agent: 'claude', kind: 'skill', scope: 'global',
    state: 'synced', cloudVersion: 2, syncedVersion: 2, memory: false, ...over,
  };
}

function deps(over: Partial<PhoneResourcesDeps> = {}): PhoneResourcesDeps {
  return {
    catalog: () => fakeCatalog(),
    usage: fakeUsage(),
    sharedSessionIds: () => ['s-1'],
    sharedProjectPaths: () => [shared],
    cloud: null,
    cloudJobs: () => null,
    cloudProjects: () => null,
    home,
    ...over,
  };
}

const PHONE = { local: false };
const MAC = { local: true };

describe('displayPath', () => {
  it('writes a path under home as ~/…, home as ~, and only the last segment of anything else', () => {
    expect(displayPath(join(home, 'code', 'app'), home)).toBe('~/code/app');
    expect(displayPath(home, home)).toBe('~');
    expect(displayPath('/Volumes/Work/app', home)).toBe('app');
  });
});

describe('visibleFilter', () => {
  it('shows a phone global resources and a shared project’s, never another project’s; the Mac sees all', () => {
    const catalog = catalogOf();
    const phone = visibleFilter(PHONE, catalog, [shared], home);
    expect(catalog.resources.filter(phone).map((r) => r.name)).toEqual(['rar', 'deploy']);
    expect(catalog.resources.filter(visibleFilter(MAC, catalog, [], home))).toHaveLength(4);
    expect(catalog.resources.filter(visibleFilter(PHONE, catalog, [], home)).map((r) => r.name)).toEqual(['rar']);
  });
});

describe('library', () => {
  it('lists what the phone may see, with uses counted over the shared sessions only', () => {
    const usage = fakeUsage();
    const lib = createPhoneResources(deps({ usage })).library(PHONE);
    expect(lib.resources.map((r) => r.name)).toEqual(['rar', 'deploy']);
    expect(lib.projects).toEqual([{ id: 'p-shared', name: 'shared-app', path: '~/code/shared-app' }]);
    expect(usage.counts).toHaveBeenCalledWith(['s-1']);
    expect(lib.usage?.scope).toBe('shared');
    expect(lib.usage?.windowDays).toBe(90);
    expect(Object.keys(lib.usage?.byId ?? {}).sort()).toEqual([ID(1), ID(2)]);
  });

  it('gives the Mac itself every resource and every session’s uses', () => {
    const usage = fakeUsage();
    const lib = createPhoneResources(deps({ usage })).library(MAC);
    expect(lib.resources).toHaveLength(4);
    expect(usage.counts).toHaveBeenCalledWith(null);
    expect(lib.usage?.scope).toBe('all');
  });

  it('starts a scan like the desktop’s tab, and says “unknown”, not zero, before it lands or when counting fails', () => {
    const fresh = fakeCatalog({ ...catalogOf(), state: 'scanning', scannedAt: undefined });
    const usage = fakeUsage();
    const lib = createPhoneResources(deps({ catalog: () => fresh, usage })).library(PHONE);
    expect(fresh.started).toBe(1);
    expect(lib.usage).toBeNull();
    expect(usage.counts).not.toHaveBeenCalled();
    const failing = { counts: vi.fn(() => null) };
    expect(createPhoneResources(deps({ usage: failing })).library(PHONE).usage).toBeNull();
  });
});

describe('item and file', () => {
  it('reads a resource the phone may see, and nothing of one it may not', async () => {
    const service = createPhoneResources(deps());
    expect((await service.item(PHONE, ID(2)))?.body).toBe(`body of ${ID(2)}`);
    expect(await service.item(PHONE, ID(3))).toBeNull();
    expect(await service.item(PHONE, ID(4))).toBeNull();
    expect(await service.item(PHONE, ID(99))).toBeNull();
    expect((await service.file(PHONE, ID(1), 'SKILL.md'))?.content).toBe(`${ID(1)}:SKILL.md`);
    expect(await service.file(PHONE, ID(3), 'SKILL.md')).toBeNull();
    expect((await service.item(MAC, ID(3)))?.body).toBe(`body of ${ID(3)}`);
  });
});

describe('sync', () => {
  it('says “not connected” with no list and no cloud read when the Mac has no connection', async () => {
    const jobs = vi.fn();
    const answer = await createPhoneResources(deps({ cloudJobs: jobs })).sync(PHONE);
    expect(answer).toEqual({ connected: false, state: 'not-connected', problem: null, readAt: null, items: [] });
    expect(jobs).not.toHaveBeenCalled();
    const revoked = await createPhoneResources(deps({ cloud: fakeCloud('revoked') })).sync(PHONE);
    expect(revoked).toMatchObject({ connected: false, state: 'revoked', problem: PHONE_CLOUD_PROBLEMS.revoked });
  });

  it('lists each saved resource’s state, leaving out local ones the phone may not see', async () => {
    const syncStatus = vi.fn(async () => ({
      items: [item(1), item(3, { scope: 'project' }), item(5, { catalogId: null, state: 'cloud-only', syncedVersion: null })],
      waiting: 1,
    }));
    const service = createPhoneResources(deps({
      cloud: fakeCloud(),
      cloudJobs: () => Promise.resolve({ syncStatus } as never),
      now: () => 10_000,
    }));
    const answer = await service.sync(PHONE);
    expect(answer.connected).toBe(true);
    expect(answer.state).toBe('connected');
    expect(answer.items.map((i) => i.name)).toEqual(['skill-1', 'skill-5']);
    expect(answer.readAt).toBe(new Date(10_000).toISOString());
    expect(syncStatus).toHaveBeenCalledWith({ backendOrigin: 'https://api.example.test', accountId: '5bce2a9c-7f8d-4ebc-9bec-d3cebfa00001', generation: 2 });
    expect((await service.sync(MAC)).items).toHaveLength(3);
  });

  it('reads the cloud at most every 10 s, keeps an answer a minute, and keeps the last one when a read fails', async () => {
    let t = 0;
    let fail = false;
    const syncStatus = vi.fn(async () => {
      if (fail) throw new CloudError('rate_limited', 'slow down', 429);
      return { items: [item(1)], waiting: 0 };
    });
    const service = createPhoneResources(deps({ cloud: fakeCloud(), cloudJobs: () => Promise.resolve({ syncStatus } as never), now: () => t }));
    await service.sync(PHONE);
    t = PHONE_RESOURCES_REFRESH_MIN_MS - 1;
    await service.sync(PHONE, { refresh: true });
    expect(syncStatus).toHaveBeenCalledTimes(1);
    t = PHONE_RESOURCES_REFRESH_MIN_MS;
    fail = true;
    const failed = await service.sync(PHONE, { refresh: true });
    expect(syncStatus).toHaveBeenCalledTimes(2);
    expect(failed.items.map((i) => i.name)).toEqual(['skill-1']);
    expect(failed.problem).toBe(PHONE_CLOUD_PROBLEMS.busy);
    t += 1;
    await service.sync(PHONE, { refresh: true });
    expect(syncStatus).toHaveBeenCalledTimes(2);
    fail = false;
    t = PHONE_RESOURCES_TTL_MS + PHONE_RESOURCES_REFRESH_MIN_MS;
    const healed = await service.sync(PHONE);
    expect(syncStatus).toHaveBeenCalledTimes(3);
    expect(healed.problem).toBeNull();
  });
});

describe('projects', () => {
  it('lists saved projects with their checkout on the Mac as ~/…, and the GitHub accounts', async () => {
    const record = {
      id: PROJ, version: 1, name: 'agent-manager', description: '', resources: [], deleted: false,
      repository: { provider: 'github', owner: 'kason', name: 'agent-manager', url: 'https://github.com/kason/agent-manager', branch: 'main' },
    };
    const jobs = {
      listProjects: vi.fn(async () => ({ items: [record, { ...record, id: CLOUD_ID(9), name: 'gone', deleted: true }], nextCursor: null })),
      githubAccounts: vi.fn(async () => ({ installed: true, accounts: [{ login: 'kason', active: true, ok: true }] })),
      localProject: vi.fn(async () => ({
        state: 'ahead', branch: 'main', openUrl: '/project-browser?path=x', localProjectId: 'agent-manager-1234',
        path: join(home, 'code', 'agent-manager'), ahead: 2, behind: 0, account: 'kason',
      })),
    };
    const answer = await createPhoneResources(deps({ cloud: fakeCloud(), cloudProjects: () => Promise.resolve(jobs as never) })).projects();
    expect(answer.accounts.accounts.map((a) => a.login)).toEqual(['kason']);
    expect(answer.projects).toEqual([{
      id: PROJ, name: 'agent-manager', owner: 'kason', repo: 'agent-manager', branch: 'main',
      local: { state: 'ahead', branch: 'main', path: '~/code/agent-manager', ahead: 2, behind: 0, account: 'kason' },
    }]);
    expect(answer.truncated).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(home);
  });
});

// Review findings (Oct 24 2026): what a visible resource could still say about a hidden project.
describe('nothing inside a visible resource names a closed project', () => {
  function withSettings(): ResourceCatalog {
    const base = catalogOf();
    return {
      ...base,
      resources: [
        ...base.resources,
        summary(9, { name: '.claude.json', type: 'settings', format: 'config', path: '~/.claude.json' }),
        summary(10, { name: 'linked', linkTarget: '~/code/private-app/skills/linked', findingCodes: ['linked-outside'] }),
      ],
    };
  }
  function service(catalog: ResourceCatalog, over: Partial<PhoneResourcesDeps> = {}) {
    const svc = fakeCatalog(catalog);
    svc.getDetail = (async (id: string) => ({
      summary: catalog.resources.find((r) => r.id === id)!,
      findings: [{ code: 'duplicate-name', severity: 'warning', resourceId: id, message: 'Same name as ~/code/private-app/.claude/skills/deploy' }],
      fields: id === ID(9) ? [
        { key: 'projects["~/code/private-app"].allowedTools[0]', value: '******', masked: true, kind: 'string' },
        { key: 'projects["~/code/shared-app"].hasTrustDialogAccepted', value: 'true', masked: false, kind: 'boolean' },
        { key: 'projects["/Volumes/Work/secret"].lastCost', value: '1.5', masked: false, kind: 'number' },
        { key: 'mcpServers.tool.command', value: '~/code/private-app/bin/run', masked: false, kind: 'string' },
        { key: 'hooks.Stop[0].hooks[0].command', value: 'bash ~/.claude/hooks/dashboard-hook.sh', masked: false, kind: 'string' },
        { key: 'theme', value: 'dark', masked: false, kind: 'string' },
      ] : undefined,
    })) as ResourceCatalogService['getDetail'];
    return createPhoneResources(deps({ catalog: () => svc, ...over }));
  }

  it('drops config fields keyed by a closed project, masks values naming one, keeps the rest', async () => {
    const detail = await service(withSettings()).item(PHONE, ID(9));
    expect(detail?.fields?.map((f) => [f.key, f.value])).toEqual([
      ['projects["~/code/shared-app"].hasTrustDialogAccepted', 'true'],
      ['mcpServers.tool.command', '******'],
      ['hooks.Stop[0].hooks[0].command', 'bash ~/.claude/hooks/dashboard-hook.sh'],
      ['theme', 'dark'],
    ]);
    expect(JSON.stringify(detail)).not.toContain('private-app');
    expect((await service(withSettings()).item(MAC, ID(9)))?.fields).toHaveLength(6);
  });

  it('leaves out findings and symlink targets for a phone, not for the Mac', async () => {
    const svc = service(withSettings());
    const detail = await svc.item(PHONE, ID(10));
    expect(detail?.findings).toEqual([]);
    expect(detail?.summary.linkTarget).toBeUndefined();
    expect(svc.library(PHONE).resources.find((r) => r.id === ID(10))?.linkTarget).toBeUndefined();
    expect(svc.library(MAC).resources.find((r) => r.id === ID(10))?.linkTarget).toBe('~/code/private-app/skills/linked');
    expect((await svc.item(MAC, ID(10)))?.findings).toHaveLength(1);
  });

  it('names a cloud-only sync row by its last segment, with a reason only about a resource the phone may see', () => {
    const row = item(11, { catalogId: null, scope: 'project', kind: 'instruction', name: 'packages/api/CLAUDE.md', state: 'blocked', reason: 'Something else is already at this location on this device' });
    expect(redactSyncItem(row, false)).toEqual({ ...row, name: 'CLAUDE.md', reason: undefined });
    expect('reason' in redactSyncItem(row, false)).toBe(false);
    expect(redactSyncItem(row, true).reason).toBe(row.reason);
  });

  it('works out the open projects once per scan and shared set', () => {
    let t = 0;
    const open = createOpenProjects(() => t);
    const catalog = catalogOf();
    const first = open(catalog, [shared], home);
    expect([...first]).toEqual(['p-shared']);
    expect(open(catalog, [shared], home)).toBe(first);
    expect(open(catalog, [shared, hidden], home)).not.toBe(first);
    expect([...open(catalog, [shared, hidden], home)].sort()).toEqual(['p-hidden', 'p-shared']);
    t = 20_000;
    expect(open(catalog, [shared], home)).not.toBe(first);
  });
});

describe('sync while the Mac scans', () => {
  it('says the Mac is reading its resources, keeps the last list, and never calls it offline', async () => {
    let state: ResourceCatalog['state'] = 'ready';
    let failNext = false;
    const catalog = catalogOf();
    const svc = fakeCatalog(catalog);
    svc.getOrStartCatalog = () => ({ ...catalog, state });
    svc.getCatalog = () => ({ ...catalog, state });
    const syncStatus = vi.fn(async () => {
      if (failNext) throw new ResourceLookupError('The resources are being scanned', 409);
      return { items: [item(1)], waiting: 0 };
    });
    let t = 0;
    const phone = createPhoneResources(deps({ catalog: () => svc, cloud: fakeCloud(), cloudJobs: () => Promise.resolve({ syncStatus } as never), now: () => t }));
    expect((await phone.sync(PHONE)).items).toHaveLength(1);
    state = 'scanning';
    t = PHONE_RESOURCES_TTL_MS + 1;
    const during = await phone.sync(PHONE, { refresh: true });
    expect(syncStatus).toHaveBeenCalledTimes(1);
    expect(during.problem).toBe(PHONE_RESOURCES_SCANNING);
    expect(during.items.map((i) => i.name)).toEqual(['skill-1']);
    // A scan that starts under the read: the same words, not "can't reach AASC Cloud".
    state = 'ready';
    failNext = true;
    expect((await phone.sync(PHONE, { refresh: true })).problem).toBe(PHONE_RESOURCES_SCANNING);
  });
});

// ── Routes, behind the phone profile ─────────────────────────────────────────

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

async function serve(over: Partial<PhoneResourcesDeps> = {}): Promise<string> {
  const app = express();
  const profile = createPhoneProfile({
    phoneOf: (req) => (req.get('x-phone') ? 'phone-1234567890' : null),
    sharedProjectPaths: () => [shared],
    knownProjectPaths: () => [],
    isOpsTerminal: () => false,
    isSharedSession: () => false,
    sessionOfTerminal: () => null,
    terminalOfSession: () => null,
    foregroundProcess: () => null,
  });
  app.use('/api', profile, createPhoneResourcesRouter(createPhoneResources(deps(over)), (req) => !req.get('x-phone')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  server = createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const phone = { headers: { 'x-phone': '1' } };

describe('GET /api/phone-resources/* from a paired phone', () => {
  it('answers the library, a resource and a file, never cached; a hidden resource is a plain 404', async () => {
    const base = await serve();
    const lib = await fetch(`${base}/api/phone-resources/library`, phone);
    expect(lib.status).toBe(200);
    expect(lib.headers.get('cache-control')).toBe('no-store');
    expect(((await lib.json()) as { resources: unknown[] }).resources).toHaveLength(2);
    expect((await fetch(`${base}/api/phone-resources/item/${ID(1)}`, phone)).status).toBe(200);
    const file = await fetch(`${base}/api/phone-resources/item/${ID(2)}/file?path=SKILL.md`, phone);
    expect(await file.json()).toEqual({ path: 'SKILL.md', bytes: 4, content: `${ID(2)}:SKILL.md` });
    for (const path of [`/item/${ID(3)}`, `/item/${ID(3)}/file?path=SKILL.md`, `/item/${ID(99)}`]) {
      const res = await fetch(`${base}/api/phone-resources${path}`, phone);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: 'Not found' });
    }
  });

  it('answers sync and projects without a connection as “not connected”, never an error page', async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/phone-resources/sync`, phone)).json()).toEqual({
      connected: false, state: 'not-connected', problem: null, readAt: null, items: [],
    });
    expect(await (await fetch(`${base}/api/phone-resources/projects?refresh=1`, phone)).json()).toEqual({
      connected: false, state: 'not-connected', problem: null, readAt: null,
      accounts: { installed: false, accounts: [] }, projects: [], truncated: false,
    });
  });

  it('validates its inputs', async () => {
    const base = await serve();
    for (const path of ['/library?x=1', '/sync?refresh=yes', '/projects?cursor=x', `/item/${ID(1)}/file`, `/item/${ID(1)}?x=1`]) {
      const res = await fetch(`${base}/api/phone-resources${path}`, phone);
      expect(res.status, path).toBe(400);
    }
  });

  it('is GET-only for a phone, and nothing else under /phone-resources opens', async () => {
    const base = await serve();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/phone-resources/library`, { method, headers: { 'x-phone': '1' } });
      expect(res.status, method).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe('PHONE_NOT_ALLOWED');
    }
    for (const path of ['/phone-resources', '/phone-resources/item', `/phone-resources/item/${ID(1)}/compare`, '/phone-resources/item/XYZ', '/resources', '/resources/usage']) {
      expect(phoneRuleFor('GET', path), path).toBeNull();
    }
    expect(phoneRuleFor('GET', '/phone-resources/library')).toBe('allow');
    expect(phoneRuleFor('GET', `/phone-resources/item/${ID(1)}/file`)).toBe('allow');
  });
});
