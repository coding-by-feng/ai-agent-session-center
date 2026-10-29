// AASC-63: a cloud project is only its GitHub repository. Saved from a folder on this device (or a
// link), linked by itself on any device that already has the checkout, removed without touching a
// folder, and cloned/pulled/pushed with the GitHub account chosen for it here. Mocked Git.
import { expect, vi } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectFixture } from './cloudProjectsFixture.js';
import { sqliteIt } from './helpers/nativeSqlite.js';
import type { GithubAccountsService } from '../server/cloud/githubAccounts.js';

const origin = {
  url: 'https://github.com/fixture/repo',
  owner: 'fixture',
  name: 'repo',
  branch: 'main',
};
function signedIn(...logins: string[]): GithubAccountsService {
  return {
    list: vi.fn(async () => ({
      installed: true,
      accounts: logins.map((login, i) => ({ login, active: i === 0, ok: true })),
    })),
    account: vi.fn(async (login: string) => {
      if (!logins.includes(login))
        throw Object.assign(new Error('missing'), { code: 'github_account_missing' });
      return { helper: '/opt/homebrew/bin/gh', login };
    }),
  } as unknown as GithubAccountsService;
}
/** The cloud lists these projects from now on (the fixture's lists its own project). */
function cloudLists(f: { cloud: { client: { request: unknown } } }, items: unknown[]) {
  const request = vi.mocked(
    f.cloud.client.request as (method: string, path: string, body?: unknown) => Promise<unknown>,
  );
  const answer = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, path: string, body?: unknown) =>
    method === 'GET' && (path === '/v1/projects' || path.startsWith('/v1/projects?'))
      ? { items, nextCursor: null }
      : answer(method, path, body),
  );
}
async function withFolder(accounts = signedIn('octo', 'work-me')) {
  let paths: string[] = [];
  const f = await projectFixture(undefined, { candidatePaths: () => paths, accounts });
  const folder = join(f.home, 'code', 'repo');
  await mkdir(folder, { recursive: true });
  paths = [folder, join(f.home, 'code', 'missing'), '/outside/home'];
  f.git.readOrigin.mockImplementation(async (path: string) => (path === folder ? origin : null));
  return { ...f, folder, accounts };
}

sqliteIt("offers this device's GitHub folders and marks the one already saved", async () => {
  const f = await withFolder();
  const before = await f.service.candidates(f.binding);
  expect(before.items).toEqual([
    {
      path: f.folder,
      repository: { provider: 'github', ...origin },
      projectId: null,
    },
  ]);
  await f.service.listProjects({}, f.binding); // the cloud already has this repository
  expect((await f.service.candidates(f.binding)).items[0].projectId).toBe(f.project.id);
});

sqliteIt('saving from a folder sends only the repository and links the folder here', async () => {
  const f = await withFolder();
  cloudLists(f, []); // nothing saved with this repository yet
  const id = randomUUID();
  const saved = await f.service.saveProject(
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
        repository: { provider: 'github', ...origin },
      },
    },
    f.binding,
    { path: f.folder },
  );
  expect(saved.id).toBe(id);
  const sent = f.calls.find((c) => (c as { method: string }).method === 'POST') as {
    body: unknown;
  };
  expect(JSON.stringify(sent.body)).not.toContain(f.folder);
  expect(await f.service.localProject(id, f.binding)).toMatchObject({
    state: 'ready',
    path: f.folder,
    ahead: 0,
    behind: 0,
    account: null,
  });
});

sqliteIt(
  'another device with the same checkout is linked by itself, with no folder picking',
  async () => {
    const f = await withFolder();
    await f.service.listProjects({}, f.binding);
    expect(await f.service.localProject(f.project.id, f.binding)).toMatchObject({
      state: 'ready',
      path: f.folder,
    });
    // A folder on another branch is not this project's checkout.
    const g = await withFolder();
    g.git.readOrigin.mockImplementation(async () => ({ ...origin, branch: 'feature' }));
    await g.service.listProjects({}, g.binding);
    expect(await g.service.localProject(g.project.id, g.binding)).toMatchObject({
      state: 'missing',
      path: null,
    });
  },
);

sqliteIt(
  'removing a project deletes only the cloud record; no folder or Git is touched',
  async () => {
    const f = await withFolder();
    await f.service.listProjects({}, f.binding);
    await f.service.localProject(f.project.id, f.binding); // linked here
    const removed = await f.service.removeProject(f.project.id, f.binding);
    expect(removed).toMatchObject({ id: f.project.id, deleted: true });
    const del = f.calls.find((c) => (c as { method: string }).method === 'DELETE') as {
      path: string;
      body: { baseVersion: number; mutationId: string };
    };
    expect(del.path).toBe(`/v1/projects/${f.project.id}`);
    expect(del.body).toEqual({ baseVersion: 1, mutationId: expect.any(String) });
    expect(f.git.clone).not.toHaveBeenCalled();
    expect(f.git.pull).not.toHaveBeenCalled();
    expect(f.git.push).not.toHaveBeenCalled();
  },
);

sqliteIt('the account chosen for a project is used to clone, check, pull and push it', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await expect(f.service.setAccount(f.project.id, 'nobody-here', f.binding)).rejects.toMatchObject({
    code: 'github_account_missing',
  });
  expect(await f.service.setAccount(f.project.id, 'work-me', f.binding)).toMatchObject({
    account: 'work-me',
  });
  const account = { helper: '/opt/homebrew/bin/gh', login: 'work-me' };
  await f.service.checkProject(f.project.id, f.binding);
  expect(f.git.fetch).toHaveBeenCalledWith(
    f.folder,
    expect.anything(),
    expect.any(AbortSignal),
    account,
  );
  f.git.inspectCheckout.mockResolvedValue({ state: 'ahead', branch: 'main', ahead: 2, behind: 0 });
  const push = await f.service.pushProject(f.project.id, f.binding);
  expect(push.kind).toBe('push-project');
  expect((await f.service.wait(push.id)).state).toBe('complete');
  expect(f.git.push).toHaveBeenCalledWith(
    f.folder,
    expect.anything(),
    expect.any(AbortSignal),
    expect.any(Function),
    account,
  );
  f.git.inspectCheckout.mockResolvedValue({ state: 'ready', branch: 'main', ahead: 0, behind: 1 });
  const pull = await f.service.pullProject(f.project.id, f.binding);
  await f.service.wait(pull.id);
  expect(f.git.pull.mock.calls[0][5]).toEqual(account);
  // Back to this Mac's own Git sign-in.
  expect(await f.service.setAccount(f.project.id, null, f.binding)).toMatchObject({
    account: null,
  });
});

sqliteIt(
  'Clone uses the chosen account over HTTPS, with no transport or resource choice',
  async () => {
    const f = await withFolder();
    f.git.readOrigin.mockResolvedValue(null);
    await f.service.listProjects({}, f.binding);
    await f.service.setAccount(f.project.id, 'octo', f.binding);
    const job = await f.service.getProject(
      f.project.id,
      { parentPath: f.home, directoryName: 'repo-copy' },
      f.binding,
    );
    expect(job.steps.map((s) => s.id)).toEqual(['git']);
    await f.service.wait(job.id);
    const [path, , transport, , , , account] = f.git.clone.mock.calls[0];
    expect(path).toBe(join(f.home, 'repo-copy'));
    expect(transport).toBe('https');
    expect(account).toEqual({ helper: '/opt/homebrew/bin/gh', login: 'octo' });
  },
);

// Oct 26 2026: saving a project's basic information from a folder an agent is working in.
sqliteIt('a save from a folder asks for a link check that ignores live agents, and links it', async () => {
  const f = await withFolder();
  cloudLists(f, []); // nothing saved with this repository yet
  const value = {
    id: randomUUID(),
    version: 1,
    name: 'repo',
    description: '',
    resources: [],
    deleted: false,
    repository: { provider: 'github' as const, ...origin },
  };
  await f.service.saveProject({ mutationId: randomUUID(), baseVersion: null, value }, f.binding, {
    path: f.folder,
  });
  expect(f.git.inspectCheckout.mock.calls.length).toBeGreaterThan(0);
  for (const call of f.git.inspectCheckout.mock.calls as unknown[][])
    expect(call[2]).toEqual({ ignoreAgents: true });
  expect((await f.service.localProject(value.id, f.binding)).path).toBe(f.folder);
});

sqliteIt.each([
  ['detached', /not on a branch/],
  ['wrong-remote', /GitHub remote or branch/],
  ['missing', /no longer on this Mac/],
  ['busy', /Git operation/],
] as const)('a refused folder (%s) says why in its own words', async (state, message) => {
  const f = await withFolder();
  const value = {
    id: randomUUID(),
    version: 1,
    name: 'repo',
    description: '',
    resources: [],
    deleted: false,
    repository: { provider: 'github' as const, ...origin },
  };
  f.git.inspectCheckout.mockResolvedValueOnce({ state, branch: null, ahead: null, behind: null });
  await expect(
    f.service.saveProject({ mutationId: randomUUID(), baseVersion: null, value }, f.binding, {
      path: f.folder,
    }),
  ).rejects.toMatchObject({ code: 'checkout_mismatch', message: expect.stringMatching(message) });
});

// Security review (Oct 23 2026): a folder that can't be linked refuses the save before any
// record reaches the cloud.
sqliteIt('a save from a folder that cannot be linked creates no cloud record', async () => {
  const f = await withFolder();
  const value = {
    id: randomUUID(),
    version: 1,
    name: 'repo',
    description: '',
    resources: [],
    deleted: false,
    repository: { provider: 'github' as const, ...origin },
  };
  const save = (path: string) =>
    f.service.saveProject({ mutationId: randomUUID(), baseVersion: null, value }, f.binding, {
      path,
    });
  // An existing folder outside home (the temporary home's parent).
  await expect(save(dirname(f.home))).rejects.toMatchObject({ code: 'path_not_allowed' });
  expect(f.calls.filter((c) => (c as { method: string }).method === 'POST')).toEqual([]);
  f.git.inspectCheckout.mockResolvedValueOnce({
    state: 'wrong-remote',
    branch: 'main',
    ahead: null,
    behind: null,
  });
  await expect(save(f.folder)).rejects.toMatchObject({ code: 'checkout_mismatch' });
  expect(f.calls.filter((c) => (c as { method: string }).method === 'POST')).toEqual([]);
});

const recordFor = (id: string, branch = 'main') => ({
  id,
  version: 1,
  name: 'repo',
  description: '',
  resources: [],
  deleted: false,
  repository: { provider: 'github' as const, ...origin, branch },
});
const posts = (f: { calls: unknown[] }) =>
  f.calls.filter((c) => (c as { method: string }).method === 'POST');

// Code review, Oct 29 2026: Remove, then Save on the same folder, made a new cloud record on every
// click, each refused at the link; a project removed on another device left the folder stuck too.
sqliteIt('after Remove, saving the folder again links it with one new record', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await f.service.localProject(f.project.id, f.binding); // linked here
  await f.service.removeProject(f.project.id, f.binding);
  cloudLists(f, []); // the cloud lists it no more
  const id = randomUUID();
  await f.service.saveProject(
    { mutationId: randomUUID(), baseVersion: null, value: recordFor(id) },
    f.binding,
    { path: f.folder },
  );
  expect(posts(f)).toHaveLength(1);
  expect(await f.service.localProject(id, f.binding)).toMatchObject({
    state: 'ready',
    path: f.folder,
  });
});

sqliteIt('a folder linked to a project removed on another device saves again', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await f.service.localProject(f.project.id, f.binding); // linked here
  cloudLists(f, []); // another device removed it: the cloud has no record of it now
  const id = randomUUID();
  await f.service.saveProject(
    { mutationId: randomUUID(), baseVersion: null, value: recordFor(id) },
    f.binding,
    { path: f.folder },
  );
  expect(await f.service.localProject(id, f.binding)).toMatchObject({ path: f.folder });
});

sqliteIt('a folder still linked to a live project is refused before any record is made', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await f.service.localProject(f.project.id, f.binding); // linked here
  await expect(
    f.service.saveProject(
      { mutationId: randomUUID(), baseVersion: null, value: recordFor(randomUUID(), 'dev') },
      f.binding,
      { path: f.folder },
    ),
  ).rejects.toMatchObject({ code: 'association_conflict' });
  expect(posts(f)).toHaveLength(0);
});

sqliteIt('saving a repository and branch already saved is refused, with no record made', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding); // the cloud has fixture/repo on main
  await expect(
    f.service.saveProject(
      { mutationId: randomUUID(), baseVersion: null, value: recordFor(randomUUID()) },
      f.binding,
    ),
  ).rejects.toMatchObject({ code: 'already_saved' });
  expect(posts(f)).toHaveLength(0);
});

// A checkout moved or deleted on this Mac no longer holds the project: the one folder left with its
// repository links by itself, and Clone is open again when there is none.
sqliteIt('a project whose folder is gone links to the other clone, or clones again', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await f.service.localProject(f.project.id, f.binding); // linked to f.folder
  const moved = join(dirname(f.folder), 'repo-2');
  await mkdir(moved);
  const { rm } = await import('node:fs/promises');
  await rm(f.folder, { recursive: true });
  f.git.readOrigin.mockImplementation(async (path: string) => (path === moved ? origin : null));
  f.git.inspectCheckout.mockImplementation(async (root: string) => ({
    state: root === f.folder ? 'missing' : 'ready',
    branch: 'main',
    ahead: 0,
    behind: 0,
  }));
  expect(await f.service.associateProject(f.project.id, moved, f.binding)).toMatchObject({
    state: 'ready',
    path: moved,
  });
  await rm(moved, { recursive: true });
  expect(await f.service.localProject(f.project.id, f.binding)).toMatchObject({
    state: 'missing',
    path: null,
  });
  const job = await f.service.getProject(
    f.project.id,
    { parentPath: dirname(f.folder), directoryName: 'again' },
    f.binding,
  );
  await f.service.wait(job.id);
  expect(await f.service.localProject(f.project.id, f.binding)).toMatchObject({
    path: join(dirname(f.folder), 'again'),
  });
});

// The catalog's first scan after a start lists no project folders until it ends.
sqliteIt('the folders list waits for the catalog’s first scan', async () => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  let paths: string[] = [];
  const f = await projectFixture(undefined, {
    candidatePaths: () => paths,
    candidatesReady: () => ready,
  });
  const folder = join(f.home, 'code', 'repo');
  await mkdir(folder, { recursive: true });
  const listed = f.service.folders(f.binding);
  paths = [folder];
  release();
  expect((await listed).items.map((i) => i.path)).toEqual([folder]);
});

// Every visit to the tab read every folder again; one scan now serves for 30 seconds, and a change
// to a link (save, link, remove, clone) reads them again.
sqliteIt('one folder scan serves the list for 30 seconds; a save reads them again', async () => {
  const f = await withFolder();
  await f.service.listProjects({}, f.binding);
  await f.service.folders(f.binding);
  const once = f.git.readOrigin.mock.calls.length;
  await f.service.folders(f.binding);
  expect(f.git.readOrigin.mock.calls.length).toBe(once);
  await f.service.removeProject(f.project.id, f.binding);
  await f.service.folders(f.binding);
  expect(f.git.readOrigin.mock.calls.length).toBeGreaterThan(once);
});
