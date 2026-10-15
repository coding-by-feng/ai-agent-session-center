import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../server/cloud/jobStore.js';
import { assertCloudBinding, retryRateLimit } from '../server/cloud/binding.js';
import { CloudError } from '../server/cloud/types.js';
const dirs: string[] = [];
afterEach(async () =>
  Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))),
);
const binding = {
  backendOrigin: 'https://cloud.example',
  accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
  generation: 1,
};
sqliteIt('keeps stable account-scoped UUIDs and marks active durable jobs interrupted on reopen', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aasc-jobs-')));
  dirs.push(directory);
  const s = await createJobStore(directory);
  const id = s.resourceId(binding, 'catalog');
  expect(s.resourceId(binding, 'catalog')).toBe(id);
  expect(
    s.resourceId({ ...binding, accountId: 'ddf341c5-6747-4d12-a012-e29034536836' }, 'catalog'),
  ).not.toBe(id);
  s.saveJob({ id: 'test', kind: 'publish', state: 'running', steps: [] }, binding, {
    planId: 'plan',
  });
  s.close();
  const r = await createJobStore(directory);
  expect(r.getJob('test')?.job.state).toBe('interrupted');
  expect(r.resourceId(binding, 'catalog')).toBe(id);
  r.close();
});
sqliteIt('rejects stale browser identity before any outbound work', () => {
  expect(() =>
    assertCloudBinding(
      { status: () => ({ connection: { ...binding, generation: 2 } }) } as never,
      binding,
    ),
  ).toThrow(/connection/i);
});
sqliteIt('retries bounded rate limits with injected delay and stable operation; cancellation blocks retries', async () => {
  let n = 0;
  const delay = vi.fn(async () => {});
  const op = vi.fn(async () => {
    if (n++ < 2) throw new CloudError('rate_limited', 'Rate limited', 429, undefined, 3000);
    return 'ok';
  });
  expect(await retryRateLimit(op, () => {}, new AbortController().signal, delay)).toBe('ok');
  expect(delay).toHaveBeenCalledTimes(2);
  const c = new AbortController();
  c.abort();
  await expect(retryRateLimit(op, () => {}, c.signal, delay)).rejects.toMatchObject({
    code: 'cancelled',
  });
  expect(op).toHaveBeenCalledTimes(3);
});

import { cloudFixture } from './cloudPackagesFixture.js';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { sqliteIt } from './helpers/nativeSqlite.js';
sqliteIt('publishes frozen bytes with stable UUID and retries 429 during multi-file upload', async () => {
  const f = await cloudFixture();
  try {
    await writeFile(join(f.resource.entry.absPath, 'extra.txt'), 'extra');
    const plan = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    expect(plan.blocked).toEqual([]);
    expect(plan.items[0].manifest.files.map((x) => x.path)).toEqual([
      'demo/SKILL.md',
      'demo/extra.txt',
    ]);
    f.rateLimit(1);
    const job = await f.jobs.publishPlan(plan.id, f.binding);
    expect((await f.jobs.wait(job.id)).state).toBe('complete');
    const puts = f.calls.filter((c) => c.method === 'PUT');
    expect(puts[0].path).toBe(puts[1].path);
    const next = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    expect(next.items[0].manifest.resourceId).toBe(plan.items[0].manifest.resourceId);
    expect(next.items[0].baseVersion).toBe(1);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('source changes after review block publication before any upload', async () => {
  const f = await cloudFixture();
  try {
    const plan = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    await writeFile(join(f.resource.entry.absPath, 'SKILL.md'), 'changed');
    const n = f.calls.length;
    const job = await f.jobs.publishPlan(plan.id, f.binding);
    expect((await f.jobs.wait(job.id)).state).toBe('failed');
    expect(f.calls.length).toBe(n);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('stale browser cannot create a plan under a new account and switch between steps stops upload', async () => {
  const f = await cloudFixture();
  try {
    const plan = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    f.setHook((path) => {
      if (path === '/v1/resources/uploads') f.switchAccount();
    });
    const job = await f.jobs.publishPlan(plan.id, f.binding);
    expect((await f.jobs.wait(job.id)).state).toBe('failed');
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    const n = f.calls.length;
    await expect(f.jobs.buildPublicationPlan([], f.binding)).rejects.toMatchObject({
      code: 'connection_changed',
    });
    expect(f.calls.length).toBe(n);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('download makes a portable ZIP without installing; install and explicit restore remain separate', async () => {
  const f = await cloudFixture();
  try {
    const plan = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    const pub = await f.jobs.publishPlan(plan.id, f.binding);
    await f.jobs.wait(pub.id);
    const ref = { resourceId: plan.items[0].manifest.resourceId, version: 1 };
    const download = await f.jobs.download(ref, f.binding);
    expect((await f.jobs.wait(download.id)).state).toBe('complete');
    const zip = await readFile(f.jobs.downloadFile(download.id, f.binding));
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zip.includes(Buffer.from('manifest.json'))).toBe(true);
    await writeFile(join(f.resource.entry.absPath, 'SKILL.md'), 'local');
    const review = await f.jobs.planInstall(ref, f.binding);
    expect(review.items[0].action).toBe('replace');
    const job = await f.jobs.runInstall(
      review.id,
      { [ref.resourceId]: 'replace-with-backup' },
      f.binding,
    );
    expect((await f.jobs.wait(job.id)).state).toBe('complete');
    expect(await readFile(join(f.resource.entry.absPath, 'SKILL.md'), 'utf8')).toContain('Hello');
  } finally {
    await f.cleanup();
  }
});
sqliteIt('exact dependency versions install first and conflicting dependency diamonds never choose silently', async () => {
  const f = await cloudFixture();
  try {
    const { randomUUID } = await import('node:crypto');
    const { canonicalManifest } = await import('../server/cloud/packageFiles.js');
    const { sha256 } = await import('../server/cloud/installFs.js');
    const make = (id: string, version: number, deps: { resourceId: string; version: number }[]) => {
      const m = canonicalManifest({
        resourceId: id,
        agent: 'claude',
        kind: 'skill',
        name: 'dependency',
        scope: 'global',
        projectId: null,
        dependencies: deps,
        files: [{ path: `pkg-${id}/SKILL.md`, sha256: sha256('body'), bytes: 4, mode: 420 }],
      });
      f.versions.set(`${id}:${version}`, {
        manifest: m,
        version,
        digest: sha256(JSON.stringify(m)),
        createdAt: new Date().toISOString(),
      });
    };
    const root = randomUUID(),
      left = randomUUID(),
      right = randomUUID(),
      shared = randomUUID();
    make(shared, 1, []);
    make(shared, 2, []);
    make(left, 1, [{ resourceId: shared, version: 1 }]);
    make(right, 1, [{ resourceId: shared, version: 2 }]);
    make(root, 1, [
      { resourceId: left, version: 1 },
      { resourceId: right, version: 1 },
    ]);
    await expect(
      f.jobs.planInstall({ resourceId: root, version: 1 }, f.binding),
    ).rejects.toMatchObject({ code: 'dependency_version_conflict' });
    make(root, 2, [{ resourceId: left, version: 1 }]);
    const plan = await f.jobs.planInstall({ resourceId: root, version: 2 }, f.binding);
    expect(plan.items.map((i) => i.resourceId)).toEqual([shared, left, root]);
    const job = await f.jobs.runInstall(plan.id, { [shared]: 'skip' }, f.binding);
    const result = await f.jobs.wait(job.id);
    expect(result.steps.map((i) => i.state)).toEqual(['skipped', 'failed', 'failed']);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('missing source dependencies and broad memory selection produce actionable blockers', async () => {
  const f = await cloudFixture();
  try {
    await writeFile(join(f.resource.entry.absPath, 'SKILL.md'), 'Use ../absent/SKILL.md');
    const plan = await f.jobs.buildPublicationPlan([{ scope: 'global', include: true }], f.binding);
    expect(plan.blocked[0].reason).toMatch(/dependency/i);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('same-byte install is a verified no-op with no backup receipt', async () => {
  const f = await cloudFixture();
  try {
    const p = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    await f.jobs.wait((await f.jobs.publishPlan(p.id, f.binding)).id);
    const plan = await f.jobs.planInstall(
      { resourceId: p.items[0].manifest.resourceId, version: 1 },
      f.binding,
    );
    expect(plan.items[0].action).toBe('same');
    const job = await f.jobs.runInstall(plan.id, {}, f.binding);
    const result = await f.jobs.wait(job.id);
    expect(result.state).toBe('complete');
    expect(f.jobs.store.list('receipt')).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('project metadata association is required before publication; nested resources and explicit memory retain their paths', async () => {
  const f = await cloudFixture();
  try {
    const { randomUUID } = await import('node:crypto');
    const { encodeProjectPath } = await import('../server/resourceRoots.js');
    const project = join(f.home, 'project');
    await mkdir(join(project, 'services', 'api', '.claude', 'skills', 'demo'), { recursive: true });
    await writeFile(
      join(project, 'services', 'api', '.claude', 'skills', 'demo', 'SKILL.md'),
      'nested',
    );
    await mkdir(join(project, '.claude', 'skills', 'demo'), { recursive: true });
    await writeFile(join(project, '.claude', 'skills', 'demo', 'SKILL.md'), 'root');
    const memory = join(f.home, '.claude', 'projects', encodeProjectPath(project), 'memory');
    await mkdir(memory, { recursive: true });
    await writeFile(join(memory, 'topic.md'), 'Reviewed memory');
    await f.rescan([project]);
    const pid = f.scan.projects.find((p) => p.name === 'project')!.id;
    const selected = f.scan.resources.filter((r) => r.projectId === pid && r.type === 'skill');
    expect(selected).toHaveLength(2);
    const blocked = await f.jobs.buildPublicationPlan(
      [{ projectId: pid, include: true }],
      f.binding,
    );
    expect(blocked.items).toHaveLength(0);
    expect(blocked.blocked.some((b) => /metadata/.test(b.reason))).toBe(true);
    await f.jobs.associateProject(
      { localProjectId: pid, cloudProjectId: randomUUID(), path: project, version: 1 },
      f.binding,
    );
    const broad = await f.jobs.buildPublicationPlan([{ projectId: pid, include: true }], f.binding);
    expect(broad.blocked.some((b) => /memory file explicitly/.test(b.reason))).toBe(true);
    const mem = f.scan.resources.find((r) => r.type === 'memory' && r.projectId === pid)!;
    const plan = await f.jobs.buildPublicationPlan(
      [
        ...selected.map((r) => ({ resourceId: r.id, include: true })),
        { resourceId: mem.id, include: true },
      ],
      f.binding,
    );
    expect(plan.blocked).toEqual([]);
    expect(new Set(plan.items.map((i) => i.manifest.resourceId)).size).toBe(3);
    expect(plan.items.flatMap((i) => i.manifest.files.map((f) => f.path))).toContain(
      'services/api/.claude/skills/demo/SKILL.md',
    );
    expect(plan.items.find((i) => i.manifest.kind === 'memory')!.manifest.files[0].path).toBe(
      'topic.md',
    );
  } finally {
    await f.cleanup();
  }
});
sqliteIt('rate-limit waiting is cancellable and stops before the next operation', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const wait = retryRateLimit(
    async () => {
      calls++;
      started();
      throw new CloudError('rate_limited', 'Wait', 429, undefined, 120000);
    },
    () => {},
    controller.signal,
  );
  await pending;
  controller.abort();
  await expect(wait).rejects.toMatchObject({ code: 'cancelled' });
  expect(calls).toBe(1);
});
sqliteIt('two resource identities cannot claim the same reviewed destination', async () => {
  const f = await cloudFixture();
  try {
    const { randomUUID } = await import('node:crypto');
    const { canonicalManifest } = await import('../server/cloud/packageFiles.js');
    const { sha256 } = await import('../server/cloud/installFs.js');
    const dep = randomUUID(),
      root = randomUUID();
    for (const [id, dependencies] of [
      [dep, []],
      [root, [{ resourceId: dep, version: 1 }]],
    ] as const) {
      const m = canonicalManifest({
        resourceId: id,
        agent: 'claude',
        kind: 'skill',
        name: 'same',
        scope: 'global',
        projectId: null,
        dependencies,
        files: [{ path: 'same/SKILL.md', sha256: sha256('x'), bytes: 1, mode: 420 }],
      });
      f.versions.set(`${id}:1`, {
        manifest: m,
        version: 1,
        digest: sha256(JSON.stringify(m)),
        createdAt: new Date().toISOString(),
      });
    }
    const plan = await f.jobs.planInstall({ resourceId: root, version: 1 }, f.binding);
    expect(plan.items.every((i) => i.action === 'blocked')).toBe(true);
  } finally {
    await f.cleanup();
  }
});

sqliteIt('replays ambiguous commit with the same upload after restart without reuploading committed bytes', async () => {
  const f = await cloudFixture();
  try {
    const plan = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    f.loseNextCommitResponse();
    const job = await f.jobs.publishPlan(plan.id, f.binding);
    expect((await f.jobs.wait(job.id)).state).toBe('failed');
    expect(f.versions.size).toBe(1);
    const puts = f.calls.filter((c) => c.method === 'PUT').length;
    await f.restartJobs();
    await f.jobs.retry(job.id, f.binding);
    expect((await f.jobs.wait(job.id)).state).toBe('complete');
    expect(f.calls.filter((c) => c.method === 'PUT')).toHaveLength(puts);
    const commits = f.calls.filter((c) => c.path.endsWith('/commit'));
    expect(commits).toHaveLength(2);
    expect(commits[1].path).toBe(commits[0].path);
    expect(f.calls.filter((c) => c.path === '/v1/resources/uploads')).toHaveLength(1);
    expect(f.versions.size).toBe(1);
  } finally {
    await f.cleanup();
  }
});

async function installedVersion(
  f: Awaited<ReturnType<typeof cloudFixture>>,
  kind: import('../src/types/cloudResources.js').PackageManifest['kind'],
  agent: 'claude' | 'codex' | 'shared',
  path: string,
) {
  const { randomUUID } = await import('node:crypto');
  const { canonicalManifest } = await import('../server/cloud/packageFiles.js');
  const { sha256 } = await import('../server/cloud/installFs.js');
  const body = Buffer.from('---\nname: received\ndescription: fixture\n---\nReceived content');
  const manifest = canonicalManifest({
    resourceId: randomUUID(),
    agent,
    kind,
    name: 'received',
    scope: 'global',
    projectId: null,
    dependencies: [],
    files: [{ path, sha256: sha256(body), bytes: body.length, mode: 420 }],
  });
  const version = {
    manifest,
    version: 2,
    digest: sha256(JSON.stringify(manifest)),
    createdAt: new Date().toISOString(),
  };
  f.versions.set(`${manifest.resourceId}:2`, version);
  f.blobs.set(sha256(body), body);
  return { version, ref: { resourceId: manifest.resourceId, version: 2 } };
}
sqliteIt.each([
  ['skill', 'claude', 'received/SKILL.md'],
  ['skill', 'codex', 'received/SKILL.md'],
  ['skill', 'shared', 'received/SKILL.md'],
  ['command', 'claude', 'nested/received.md'],
  ['command', 'codex', 'received.md'],
  ['rule', 'claude', 'received.md'],
  ['rule', 'codex', 'received.rules'],
  ['agent', 'claude', 'received.md'],
  ['instruction', 'claude', 'CLAUDE.md'],
  ['instruction', 'codex', 'AGENTS.md'],
  ['memory', 'codex', 'received.md'],
] as const)(
  'retains installed cloud identity/version on republish for %s/%s/%s',
  async (kind, agent, path) => {
    const f = await cloudFixture();
    try {
      const { ref } = await installedVersion(f, kind, agent, path);
      const review = await f.jobs.planInstall(ref, f.binding);
      expect(review.items[0].action).toBe('add');
      const job = await f.jobs.runInstall(review.id, {}, f.binding);
      const result = await f.jobs.wait(job.id);
      expect(result.state).toBe('complete');
      expect(result.steps[0].attention).toBeUndefined();
      await f.restartJobs();
      const resources = [...f.scan.internals.values()].filter(
        (r) =>
          r.summary.type === (kind === 'instruction' ? 'instructions' : kind) &&
          r.summary.agent === agent,
      );
      const target = resources.find((r) =>
        r.entry.absPath.endsWith(kind === 'skill' ? 'received' : path),
      );
      expect(target).toBeDefined();
      const publication = await f.jobs.buildPublicationPlan(
        [{ resourceId: target!.summary.id, include: true }],
        f.binding,
      );
      expect(publication.blocked).toEqual([]);
      expect(publication.items[0].manifest.resourceId).toBe(ref.resourceId);
      expect(publication.items[0].baseVersion).toBe(2);
    } finally {
      await f.cleanup();
    }
  },
);
sqliteIt('retains package success while failed catalog refresh defers association/aliases and explicit retry after restart recovers it', async () => {
  const f = await cloudFixture();
  try {
    const { ref } = await installedVersion(f, 'skill', 'claude', 'received/SKILL.md');
    const review = await f.jobs.planInstall(ref, f.binding);
    f.setCatalogReady(false);
    const job = await f.jobs.runInstall(review.id, {}, f.binding);
    const result = await f.jobs.wait(job.id);
    expect(result.state).toBe('complete');
    expect(result.steps[0].attention).toMatch(/catalog/i);
    expect(f.aliasRetries).toEqual([]);
    const bytes = await readFile(join(f.home, '.claude/skills/received/SKILL.md'));
    await f.restartJobs();
    f.setCatalogReady(true);
    await f.jobs.retry(job.id, f.binding);
    const retried = await f.jobs.wait(job.id);
    expect(retried.state).toBe('complete');
    expect(retried.steps[0].attention).toBeUndefined();
    expect(f.aliasRetries).toEqual(['claude:received']);
    expect(await readFile(join(f.home, '.claude/skills/received/SKILL.md'))).toEqual(bytes);
    const target = [...f.scan.internals.values()].find((r) => r.summary.name === 'received')!;
    const publication = await f.jobs.buildPublicationPlan(
      [{ resourceId: target.summary.id, include: true }],
      f.binding,
    );
    expect(publication.items[0].manifest.resourceId).toBe(ref.resourceId);
    expect(publication.items[0].baseVersion).toBe(2);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('catalog failure cannot invoke alias retry against a stale existing target', async () => {
  const f = await cloudFixture();
  try {
    const { ref } = await installedVersion(f, 'skill', 'claude', 'demo/SKILL.md');
    const review = await f.jobs.planInstall(ref, f.binding);
    f.setCatalogReady(false);
    const job = await f.jobs.runInstall(
      review.id,
      { [ref.resourceId]: 'replace-with-backup' },
      f.binding,
    );
    const result = await f.jobs.wait(job.id);
    expect(result.state).toBe('complete');
    expect(result.steps[0].attention).toMatch(/catalog/i);
    expect(f.aliasRetries).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('an incompatible existing catalog association is explicit and never overwritten or republished under the wrong UUID', async () => {
  const f = await cloudFixture();
  try {
    const original = f.jobs.store.resourceId(f.binding, f.resource.summary.id);
    const { ref } = await installedVersion(f, 'skill', 'claude', 'demo/SKILL.md');
    const review = await f.jobs.planInstall(ref, f.binding);
    const job = await f.jobs.runInstall(
      review.id,
      { [ref.resourceId]: 'replace-with-backup' },
      f.binding,
    );
    const result = await f.jobs.wait(job.id);
    expect(result.state).toBe('complete');
    expect(result.steps[0].attention).toMatch(/identity|association/i);
    expect(f.jobs.store.resourceId(f.binding, f.resource.summary.id)).toBe(original);
    expect(f.aliasRetries).toEqual([]);
    const publication = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    expect(publication.items).toHaveLength(0);
    expect(publication.blocked[0].reason).toMatch(/association|identity/i);
  } finally {
    await f.cleanup();
  }
});
sqliteIt('publication review recovers a pending same-byte installation identity after restart without a replacement', async () => {
  const f = await cloudFixture();
  try {
    const { ref, version } = await installedVersion(f, 'skill', 'claude', 'demo/SKILL.md');
    const source = join(f.home, '.claude/skills/demo/SKILL.md');
    await writeFile(source, f.blobs.get(version.manifest.files[0].sha256)!);
    const review = await f.jobs.planInstall(ref, f.binding);
    expect(review.items[0].action).toBe('same');
    f.setCatalogReady(false);
    const job = await f.jobs.runInstall(review.id, {}, f.binding);
    const result = await f.jobs.wait(job.id);
    expect(result.steps[0].receiptId).toBeUndefined();
    expect(result.steps[0].attention).toMatch(/catalog/i);
    expect(f.jobs.store.list('receipt')).toEqual([]);
    await f.restartJobs();
    f.setCatalogReady(true);
    const publication = await f.jobs.buildPublicationPlan(
      [{ resourceId: f.resource.summary.id, include: true }],
      f.binding,
    );
    expect(publication.items[0].manifest.resourceId).toBe(ref.resourceId);
    expect(publication.items[0].baseVersion).toBe(2);
    expect(f.jobs.store.list('receipt')).toEqual([]);
    expect(await readFile(source)).toEqual(f.blobs.get(version.manifest.files[0].sha256));
  } finally {
    await f.cleanup();
  }
});
sqliteIt('a dependency closure over the total size cap is refused before any file is fetched or installed', async () => {
  const { cloudFixture } = await import('./cloudPackagesFixture.js');
  const { randomUUID } = await import('node:crypto');
  const { canonicalManifest, MAX_CLOSURE_BYTES } = await import('../server/cloud/packageFiles.js');
  const { sha256 } = await import('../server/cloud/installFs.js');
  const f = await cloudFixture();
  try {
    // Each version is schema-valid on its own (4 x 15 MB files, under the 64 MB manifest cap).
    const make = (id: string, deps: { resourceId: string; version: number }[]) => {
      const m = canonicalManifest({
        resourceId: id,
        agent: 'claude',
        kind: 'skill',
        name: 'large',
        scope: 'global',
        projectId: null,
        dependencies: deps,
        files: [0, 1, 2, 3].map((n) => ({
          path: `pkg-${id}/f${n}.md`,
          sha256: sha256(`${id}-${n}`),
          bytes: 15 * 1024 * 1024,
          mode: 420,
        })),
      });
      f.versions.set(`${id}:1`, {
        manifest: m,
        version: 1,
        digest: sha256(JSON.stringify(m)),
        createdAt: new Date().toISOString(),
      });
    };
    const deps = Array.from({ length: Math.ceil(MAX_CLOSURE_BYTES / (60 * 1024 * 1024)) }, () =>
      randomUUID(),
    );
    for (const id of deps) make(id, []);
    const root = randomUUID();
    make(
      root,
      deps.map((resourceId) => ({ resourceId, version: 1 })),
    );
    const ref = { resourceId: root, version: 1 };
    await expect(f.jobs.planInstall(ref, f.binding)).rejects.toMatchObject({
      code: 'closure_too_large',
      status: 413,
    });
    const job = await f.jobs.wait((await f.jobs.download(ref, f.binding)).id);
    expect(job.state).toBe('failed');
    expect(job.steps[0].error).toMatch(/256 MB/);
    // Only version manifests were read: no file was streamed and no upload happened.
    expect(f.calls.some((c) => c.path.includes('/files/'))).toBe(false);
    expect(f.calls.every((c) => c.method === 'GET')).toBe(true);
  } finally {
    await f.cleanup();
  }
});
