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
export async function projectFixture(actualGit?: import('../server/cloud/git.js').GitOperations) {
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
    inspectCheckout: vi.fn(async () => ({ state: 'ready' as const, branch: 'main' })),
    pull: vi.fn(async () => {}),
  };
  const service = await createProjectJobs({ cloud, resources: f.jobs, git: actualGit ?? git });
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
