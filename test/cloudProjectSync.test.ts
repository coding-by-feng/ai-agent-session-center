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
