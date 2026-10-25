import { afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cloudFixture } from './cloudPackagesFixture.js';
import { createProjectJobs } from '../server/cloud/projectJobs.js';
import type { CloudConnector } from '../server/cloud/types.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
export async function projectFixture(
  actualGit?: import('../server/cloud/git.js').GitOperations,
  extra: {
    /** Folders "Save a project" offers (AASC-63). */
    candidatePaths?: () => string[];
    accounts?: import('../server/cloud/githubAccounts.js').GithubAccountsService;
  } = {},
) {
  const f = await cloudFixture();
  cleanups.push(() => f.cleanup());
  const project = {
    id: randomUUID(),
    version: 1,
    name: 'Repo',
    description: '',
    deleted: false,
    resources: [],
    repository: {
      provider: 'github' as const,
      owner: 'fixture',
      name: 'repo',
      url: 'https://github.com/fixture/repo',
      branch: 'main',
    },
  };
  let current = { ...f.binding };
  const calls: unknown[] = [];
  const cloud = {
    status: () => ({
      connection: { ...current, deviceId: randomUUID(), deviceName: 'fixture' },
      state: 'connected',
      lastError: null,
    }),
    onStop: () => () => {},
    client: {
      request: vi.fn(async (method: string, path: string, body?: any) => {
        calls.push({ method, path, body });
        if (method === 'DELETE')
          return { ...project, version: body.baseVersion + 1, deleted: true, resources: [] };
        return method === 'GET'
          ? { items: [project], nextCursor: null }
          : { ...body.value, version: (body.baseVersion ?? 0) + 1 };
      }),
    },
  } as unknown as CloudConnector;
  const git = {
    recoverPublishedClone: vi.fn(async () => {}),
    clone: vi.fn(async (path: string) => {
      await mkdir(path);
      await writeFile(join(path, 'kept'), 'clone');
    }),
    inspectCheckout: vi.fn(async () => ({
      state: 'ready' as import('../src/types/cloudProjects.js').CheckoutState,
      branch: 'main' as string | null,
      ahead: 0 as number | null,
      behind: 0 as number | null,
    })),
    pull: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    push: vi.fn(async () => {}),
    readOrigin: vi.fn(
      async (_path: string): Promise<import('../server/cloud/git.js').GithubOrigin | null> => null,
    ),
  };
  const service = await createProjectJobs({
    cloud,
    resources: f.jobs,
    git: actualGit ?? git,
    home: f.home,
    candidatePaths: extra.candidatePaths,
    accounts: extra.accounts,
  });
  return {
    ...f,
    get jobs() {
      return f.jobs;
    },
    service,
    project,
    git,
    cloud,
    calls,
    switchProjectAccount() {
      current = { ...current, accountId: randomUUID(), generation: 2 };
    },
  };
}
