import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { projectFixture } from './cloudProjectsFixture.js';
import { sqliteIt } from './helpers/nativeSqlite.js';
sqliteIt('metadata save acknowledges revision before exact private association and never uploads local path', async () => {
  const f = await projectFixture();
  const path = join(f.home, 'checkout');
  await mkdir(path);
  const saved = await f.service.saveProject(
    { mutationId: randomUUID(), baseVersion: null, value: f.project },
    f.binding,
    { path },
  );
  expect(saved.version).toBe(1);
  const local = await f.service.localProject(f.project.id, f.binding);
  expect(local.openUrl).toContain('/project-browser?path=');
  expect(JSON.stringify(f.calls)).not.toContain(f.home);
});
sqliteIt('stale browser rejects before any outbound or Git', async () => {
  const f = await projectFixture();
  f.switchProjectAccount();
  await expect(
    f.service.getProject(
      f.project.id,
      { parentPath: f.home, directoryName: 'checkout', transport: 'https', resourceVersions: [] },
      f.binding,
    ),
  ).rejects.toMatchObject({ code: 'connection_changed' });
  expect(f.calls).toHaveLength(0);
  expect(f.git.clone).not.toHaveBeenCalled();
});
sqliteIt('resource_failure_keeps_successful_checkout and shared job owner retry never reruns clone', async () => {
  const f = await projectFixture();
  const pin = { resourceId: randomUUID(), version: 1 };
  f.project.resources.push(pin as never);
  const job = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'checkout', transport: 'https', resourceVersions: [pin] },
    f.binding,
  );
  expect((await f.jobs.wait(job.id)).state).toBe('partial');
  expect(await readFile(join(f.home, 'checkout', 'kept'), 'utf8')).toBe('clone');
  expect((await f.service.localProject(f.project.id, f.binding)).openUrl).toBeTruthy();
  await f.service.retryResources(job.id, f.binding);
  await f.jobs.wait(job.id);
  expect(f.git.clone).toHaveBeenCalledTimes(1);
});
sqliteIt('combined project roots detect conflicting exact pins before any installation', async () => {
  const f = await projectFixture();
  const plan = await f.jobs.buildPublicationPlan(
    [{ resourceId: f.resource.summary.id, include: true }],
    f.binding,
  );
  const job = await f.jobs.publishPlan(plan.id, f.binding);
  await f.jobs.wait(job.id);
  const version = [...f.versions.values()][0];
  await expect(
    f.jobs.planInstallMany(
      {
        refs: [
          { resourceId: version.manifest.resourceId, version: 1 },
          { resourceId: version.manifest.resourceId, version: 2 },
        ],
      },
      f.binding,
    ),
  ).rejects.toMatchObject({ code: 'dependency_version_conflict' });
  expect(f.jobs.store.list('receipt')).toHaveLength(0);
});
sqliteIt('combined independent roots block overlapping destinations before writes', async () => {
  const f = await projectFixture();
  const p = await f.jobs.buildPublicationPlan(
    [{ resourceId: f.resource.summary.id, include: true }],
    f.binding,
  );
  await f.jobs.wait((await f.jobs.publishPlan(p.id, f.binding)).id);
  const first = [...f.versions.values()][0];
  const { canonicalManifest } = await import('../server/cloud/packageFiles.js');
  const { sha256 } = await import('../server/cloud/installFs.js');
  const manifest = canonicalManifest({ ...first.manifest, resourceId: randomUUID() });
  const second = { ...first, manifest, digest: sha256(JSON.stringify(manifest)) };
  f.versions.set(`${manifest.resourceId}:1`, second);
  const plan = await f.jobs.planInstallMany(
    { refs: [first, second].map((v) => ({ resourceId: v.manifest.resourceId, version: 1 })) },
    f.binding,
  );
  expect(plan.items.map((i) => i.action)).toEqual(['blocked', 'blocked']);
  await expect(f.jobs.runInstall(plan.id, {}, f.binding)).rejects.toMatchObject({
    code: 'installation_blocked',
  });
  expect(f.jobs.store.list('receipt')).toHaveLength(0);
});
sqliteIt('successful clone records mapping and ordinary shared cancel/history dispatch remains owned', async () => {
  const f = await projectFixture();
  const j = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'ready', transport: 'ssh', resourceVersions: [] },
    f.binding,
  );
  expect((await f.jobs.wait(j.id)).state).toBe('complete');
  expect(f.jobs.getJob(j.id).kind).toBe('get-project');
  expect(f.jobs.cancel(j.id).state).toBe('complete');
  expect(f.git.pull).not.toHaveBeenCalled();
  expect(f.git.clone).toHaveBeenCalledTimes(1);
  await expect(f.jobs.retry(j.id, f.binding)).rejects.toMatchObject({ code: 'review_required' });
});
sqliteIt('metadata is not locally associated when backend save fails', async () => {
  const f = await projectFixture();
  f.cloud.client.request = async () => {
    throw new Error('unavailable');
  };
  const path = join(f.home, 'checkout');
  await mkdir(path);
  await expect(
    f.service.saveProject(
      { mutationId: randomUUID(), baseVersion: null, value: f.project },
      f.binding,
      { path },
    ),
  ).rejects.toThrow();
  expect(f.jobs.store.list('checkout')).toHaveLength(0);
  expect(f.jobs.store.list('project')).toHaveLength(0);
});
sqliteIt('duplicate active project jobs are refused before a second clone', async () => {
  const f = await projectFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.git.clone.mockImplementation(async (path) => {
    await gate;
    await mkdir(path);
  });
  const first = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'one', transport: 'https', resourceVersions: [] },
    f.binding,
  );
  try {
    await expect(
      f.service.getProject(
        f.project.id,
        { parentPath: f.home, directoryName: 'two', transport: 'https', resourceVersions: [] },
        f.binding,
      ),
    ).rejects.toMatchObject({ code: 'busy' });
  } finally {
    release();
    await f.jobs.wait(first.id);
  }
  expect(f.git.clone).toHaveBeenCalledTimes(1);
});
sqliteIt('frozen generation is checked after metadata response before Git starts', async () => {
  const f = await projectFixture();
  const request = f.cloud.client.request;
  f.cloud.client.request = async (...args) => {
    const result = await request(...args);
    f.switchProjectAccount();
    return result;
  };
  await expect(
    f.service.getProject(
      f.project.id,
      { parentPath: f.home, directoryName: 'one', transport: 'https', resourceVersions: [] },
      f.binding,
    ),
  ).rejects.toMatchObject({ code: 'connection_changed' });
  expect(f.git.clone).not.toHaveBeenCalled();
  expect(f.jobs.store.list('checkout')).toHaveLength(0);
});
sqliteIt('pull persists fetched result independently when fast-forward is refused', async () => {
  const f = await projectFixture();
  const path = join(f.home, 'checkout');
  await mkdir(path);
  await f.service.associateProject(f.project.id, path, f.binding);
  f.git.pull.mockImplementation(async (_root, _project, _signal, _check, onFetched) => {
    onFetched?.();
    throw new Error('changed after fetch');
  });
  const j = await f.service.pullProject(f.project.id, f.binding);
  const done = await f.jobs.wait(j.id);
  expect(done.steps.find((s) => s.id === 'fetch')?.state).toBe('complete');
  expect(done.steps.find((s) => s.id === 'git')?.state).toBe('failed');
  expect(done.state).toBe('partial');
});
sqliteIt('real native Git checkout survives resource failure and opens through persisted mapping', async () => {
  const { gitFixture } = await import('./cloudGitFixture.js');
  const native = await gitFixture();
  const f = await projectFixture(native.ops);
  const pin = { resourceId: randomUUID(), version: 1 };
  f.project.resources.push(pin as never);
  const j = await f.service.getProject(
    f.project.id,
    {
      parentPath: f.home,
      directoryName: 'real-native-checkout',
      transport: 'ssh',
      resourceVersions: [pin],
    },
    f.binding,
  );
  const done = await f.jobs.wait(j.id);
  expect(done.state).toBe('partial');
  expect(await readFile(join(f.home, 'real-native-checkout', 'hello'), 'utf8')).toBe('one');
  expect((await f.service.localProject(f.project.id, f.binding)).openUrl).toContain(
    'real-native-checkout',
  );
  expect(f.jobs.store.list('checkout')).toHaveLength(1);
});
sqliteIt('durable publish intent recovers rename-before-ack after restart without cloning again', async () => {
  const { gitFixture } = await import('./cloudGitFixture.js');
  const native = await gitFixture({
    afterPublish: async () => {
      throw new Error('simulated process loss before mapping acknowledgment');
    },
  });
  const f = await projectFixture(native.ops);
  const j = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'published', transport: 'https', resourceVersions: [] },
    f.binding,
  );
  const interrupted = await f.jobs.wait(j.id);
  expect(interrupted.state).toBe('failed');
  expect(await readFile(join(f.home, 'published', 'hello'), 'utf8')).toBe('one');
  const record = f.jobs.store.getJob(j.id)!;
  record.job.state = 'running';
  f.jobs.store.saveJob(record.job, record.binding, record.private);
  await f.restartJobs();
  const { createProjectJobs } = await import('../server/cloud/projectJobs.js');
  const restarted = await createProjectJobs({
    cloud: f.cloud,
    resources: f.jobs,
    git: native.ops,
    home: f.home,
  });
  expect(f.jobs.getJob(j.id).state).toBe('interrupted');
  expect((await restarted.localProject(f.project.id, f.binding)).openUrl).toBe(null);
  await f.jobs.retry(j.id, f.binding);
  expect((await f.jobs.wait(j.id)).state).toBe('complete');
  expect((await restarted.localProject(f.project.id, f.binding)).openUrl).toContain('published');
});

sqliteIt.each(['running', 'complete'] as const)(
  'stale resource preview cannot overwrite a %s retry using its prior review',
  async (phase) => {
    const f = await projectFixture();
    const root = join(f.home, 'checkout');
    await mkdir(root);
    await f.service.associateProject(f.project.id, root, f.binding);
    const oldPlan = { id: randomUUID(), items: [] },
      newPlan = { id: randomUUID(), items: [] };
    const job = {
      id: randomUUID(),
      kind: 'get-project' as const,
      state: 'partial' as const,
      steps: [
        { id: 'git', label: 'Get checkout', state: 'complete' as const },
        { id: 'resources', label: 'Install resources', state: 'failed' as const },
      ],
    };
    f.jobs.store.put('install-plan', oldPlan.id, { public: oldPlan });
    f.jobs.store.saveJob(job, f.binding, {
      project: f.project,
      destination: root,
      transport: 'https',
      refs: [{ resourceId: randomUUID(), version: 1 }],
      resourcePlanId: oldPlan.id,
    });
    let releasePlan!: () => void, releaseChild!: () => void, notifyChild!: () => void;
    const planGate = new Promise<void>((r) => (releasePlan = r)),
      childGate = new Promise<void>((r) => (releaseChild = r)),
      childStarted = new Promise<void>((r) => (notifyChild = r));
    const planSpy = vi.spyOn(f.jobs, 'planInstallMany').mockImplementation(async () => {
      await planGate;
      return newPlan;
    });
    const childId = randomUUID();
    const installSpy = vi
      .spyOn(f.jobs, 'runInstall')
      .mockResolvedValue({ id: childId, kind: 'install', state: 'running', steps: [] });
    const waitSpy = vi.spyOn(f.jobs, 'wait').mockImplementation(async (id) => {
      expect(id).toBe(childId);
      notifyChild();
      await childGate;
      return { id, kind: 'install', state: 'complete', steps: [] };
    });
    const preview = f.service.resourcePlan(job.id, f.binding).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    try {
      await f.service.retryResources(job.id, f.binding, { planId: oldPlan.id, decisions: {} });
      await childStarted;
      expect(f.jobs.store.getJob(job.id)?.job.state).toBe('running');
      if (phase === 'complete') {
        releaseChild();
        await f.service.wait(job.id);
      }
      releasePlan();
      const result = await preview;
      expect(result.value).toBe(null);
      expect(result.error).toMatchObject({ code: 'review_required' });
      const active = f.jobs.store.getJob(job.id)!;
      expect(active.job.state).toBe(phase);
      expect(active.private).toMatchObject({ resourcePlanId: oldPlan.id, resourceJobId: childId });
    } finally {
      releasePlan();
      releaseChild();
      await preview;
      await f.service.wait(job.id);
      planSpy.mockRestore();
      installSpy.mockRestore();
      waitSpy.mockRestore();
    }
    const done = f.jobs.store.getJob(job.id)!;
    expect(done.job.state).toBe('complete');
    expect(done.private).toMatchObject({ resourcePlanId: oldPlan.id, resourceJobId: childId });
  },
);
sqliteIt('another account cannot see or drive a project job, and a saved mapping outside home is refused', async () => {
  const { accountKey } = await import('../server/cloud/binding.js');
  const f = await projectFixture();
  const j = await f.service.getProject(
    f.project.id,
    { parentPath: f.home, directoryName: 'owned', transport: 'https', resourceVersions: [] },
    f.binding,
  );
  await f.jobs.wait(j.id);
  // A mapping that never passed today's rule (an outside folder) is refused before any Git work.
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'aasc-outside-mapping-')));
  try {
    const key = JSON.stringify([accountKey(f.binding), f.project.id]);
    const saved = f.jobs.store.get<Record<string, unknown>>('checkout', key)!;
    f.jobs.store.put('checkout', key, { ...saved, localRoot: outside });
    await expect(f.service.pullProject(f.project.id, f.binding)).rejects.toMatchObject({
      code: 'path_not_allowed',
    });
    expect(f.git.pull).not.toHaveBeenCalled();
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
  f.switchProjectAccount();
  const c = f.cloud.status().connection!;
  const other = {
    backendOrigin: c.backendOrigin,
    accountId: c.accountId,
    generation: c.generation,
  };
  for (const attempt of [
    () => f.service.resourcePlan(j.id, other),
    () => f.service.retryResources(j.id, other),
    () => f.service.retry(j.id, other),
  ])
    await expect(attempt()).rejects.toMatchObject({ code: 'not_found' });
});
