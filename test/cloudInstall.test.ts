import { afterEach, expect, it, vi } from 'vitest';
import * as installFs from '../server/cloud/installFs.js';
import * as nativeFs from 'node:fs/promises';
import { dirname } from 'node:path';
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobStore } from '../server/cloud/jobStore.js';
import { createInstaller } from '../server/cloud/install.js';
import { sha256 } from '../server/cloud/installFs.js';
import { resourceDestination } from '../server/resourcePackages/adapters.js';
import type { PackageManifest } from '../src/types/cloudResources.js';
const dirs: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((f) => f());
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const binding = {
  backendOrigin: 'https://cloud.example',
  accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
  generation: 1,
};
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-install-')));
  dirs.push(dir);
  const store = await createJobStore(join(dir, 'private'));
  cleanups.push(() => store.close());
  const root = join(dir, 'home');
  await mkdir(root);
  const m: PackageManifest = {
    resourceId: binding.accountId,
    agent: 'claude',
    kind: 'skill',
    name: 'demo',
    scope: 'global',
    projectId: null,
    files: [{ path: 'demo/SKILL.md', sha256: sha256('new'), bytes: 3, mode: 420 }],
    dependencies: [],
  };
  const destination = resourceDestination(m, {
    claudeRoot: root,
    codexRoot: root,
    sharedRoot: root,
  });
  await mkdir(destination.path, { recursive: true });
  await writeFile(join(destination.path, 'SKILL.md'), 'old');
  await writeFile(join(destination.path, 'unrelated.txt'), 'keep');
  return { dir, store, m, destination, installer: createInstaller(store) };
}
it('backs up before replacement, preserves unrelated bytes, and restores only unchanged installed bytes', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const receipt = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('new');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
  await f.installer.restore(receipt.id);
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('changed destination stops without touching original or unrelated files', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  await writeFile(join(f.destination.path, 'SKILL.md'), 'edited');
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'destination_changed' });
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('edited');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('changed installed bytes block restore and brand-new installation is never removed by restore', async () => {
  const f = await fixture();
  await rm(f.destination.path, { recursive: true });
  const plan = await f.installer.review(f.m, 1, f.destination);
  const receipt = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  await expect(f.installer.restore(receipt.id)).rejects.toMatchObject({
    code: 'restore_unavailable',
  });
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('new');
});
it('single-file command replacements and restores keep exact original bytes', async () => {
  const f = await fixture();
  const manifest: PackageManifest = {
    ...f.m,
    kind: 'command',
    files: [{ ...f.m.files[0], path: 'nested/hello.md' }],
  };
  const root = join(f.dir, 'commands');
  await mkdir(join(root, 'nested'), { recursive: true });
  const destination = {
    root,
    path: join(root, 'nested', 'hello.md'),
    package: false,
    label: 'command',
    files: [{ manifestPath: 'nested/hello.md', localPath: 'hello.md' }],
  };
  await writeFile(destination.path, 'old');
  const plan = await f.installer.review(manifest, 1, destination);
  const r = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  await f.installer.restore(r.id);
  expect(await readFile(destination.path, 'utf8')).toBe('old');
});
it('recovery restores original after interrupted backup and refuses changed destinations', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const receipt = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  await writeFile(join(f.destination.path, 'unrelated.txt'), 'user changed');
  await expect(f.installer.restore(receipt.id)).rejects.toMatchObject({
    code: 'destination_changed',
  });
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('new');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('user changed');
});
it('an existing root replaced after review is rejected even if destination bytes match', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const { rename } = await import('node:fs/promises');
  await rename(f.destination.root, f.destination.root + '-old');
  await mkdir(f.destination.path, { recursive: true });
  await writeFile(join(f.destination.path, 'SKILL.md'), 'old');
  await writeFile(join(f.destination.path, 'unrelated.txt'), 'keep');
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'destination_changed' });
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('recovers a durable backed-up receipt without auto-installing after a crash', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const receipt = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  const { rename } = await import('node:fs/promises');
  await rename(f.destination.path, receipt.stage);
  receipt.state = 'backed-up';
  f.store.put('receipt', receipt.id, receipt);
  const recovered = await f.installer.recover(receipt);
  expect(recovered.state).toBe('restored');
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('bad downloaded hash never replaces original; destination hard links are blocked', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from('BAD'),
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'hash_mismatch' });
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
  const { link } = await import('node:fs/promises');
  await link(join(f.destination.path, 'SKILL.md'), join(f.dir, 'hardlink'));
  await expect(f.installer.review(f.m, 1, f.destination)).rejects.toThrow();
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('interrupted restore retains both copies and resumes only the recorded original', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const receipt = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  const { rename } = await import('node:fs/promises');
  await rename(f.destination.path, receipt.displaced);
  receipt.state = 'restoring' as never;
  f.store.put('receipt', receipt.id, receipt);
  const r = await f.installer.restore(receipt.id);
  expect(r.state).toBe('restored');
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(receipt.displaced, 'SKILL.md'), 'utf8')).toBe('new');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('managed generated alias destinations are not silently rewritten', async () => {
  const f = await fixture();
  await writeFile(join(f.destination.path, 'SKILL.md'), '<!-- aasc-alias:v1 -->');
  await expect(f.installer.review(f.m, 1, f.destination)).rejects.toMatchObject({
    code: 'managed_alias',
  });
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('downloaded managed alias content is blocked before originals move', async () => {
  const f = await fixture();
  const text = '<!-- aasc-alias:v1 -->';
  const manifest = {
    ...f.m,
    files: [{ ...f.m.files[0], sha256: sha256(text), bytes: Buffer.byteLength(text) }],
  };
  const plan = await f.installer.review(manifest, 1, f.destination);
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from(text),
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'managed_alias' });
  expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it.skipIf(process.platform === 'win32')(
  'preserves exact private file and directory permissions, including original backup and restore',
  async () => {
    const f = await fixture();
    const { chmod, stat } = await import('node:fs/promises');
    await mkdir(join(f.destination.path, 'private'));
    await writeFile(join(f.destination.path, 'private', 'note'), 'private bytes');
    for (const [p, mode] of [
      ['', 0o750],
      ['private', 0o710],
      ['private/note', 0o600],
      ['SKILL.md', 0o640],
      ['unrelated.txt', 0o600],
    ] as const)
      await chmod(join(f.destination.path, p), mode);
    const plan = await f.installer.review(f.m, 1, f.destination);
    const r = await f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    );
    for (const [p, mode] of [
      ['', 0o750],
      ['private', 0o710],
      ['private/note', 0o600],
      ['unrelated.txt', 0o600],
    ] as const)
      expect((await stat(join(f.destination.path, p))).mode & 0o7777).toBe(mode);
    expect(await readFile(join(f.destination.path, 'private/note'), 'utf8')).toBe('private bytes');
    expect((await stat(join(r.backup, 'SKILL.md'))).mode & 0o7777).toBe(0o640);
    await f.installer.restore(r.id);
    expect((await stat(join(f.destination.path, 'SKILL.md'))).mode & 0o7777).toBe(0o640);
    expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
  },
);
it.skipIf(process.platform === 'win32').each(['unrelated.txt', '', 'SKILL.md'])(
  'refuses mode-only destination edits: %s',
  async (p) => {
    const f = await fixture();
    const { chmod } = await import('node:fs/promises');
    const plan = await f.installer.review(f.m, 1, f.destination);
    await chmod(join(f.destination.path, p), p ? 0o600 : 0o750);
    await expect(
      f.installer.install(
        plan,
        binding,
        async () => Buffer.from('new'),
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'destination_changed' });
    expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
    expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
  },
);
it('walks every Windows drive and UNC parent component and refuses an intermediate junction', async () => {
  const fs = await import('../server/cloud/installFs.js');
  const { win32 } = await import('node:path');
  expect(fs.parentPaths('C:\\Users\\fixture\\.claude\\skills', win32)).toEqual([
    'C:\\Users',
    'C:\\Users\\fixture',
    'C:\\Users\\fixture\\.claude',
    'C:\\Users\\fixture\\.claude\\skills',
  ]);
  expect(fs.parentPaths('\\\\server\\share\\fixture\\.claude\\skills', win32)).toEqual([
    '\\\\server\\share\\fixture',
    '\\\\server\\share\\fixture\\.claude',
    '\\\\server\\share\\fixture\\.claude\\skills',
  ]);
  const f = await fixture();
  const { symlink } = await import('node:fs/promises');
  await symlink(f.destination.root, join(f.dir, 'junction'), 'junction');
  await expect(fs.safeParents(join(f.dir, 'junction', 'demo'))).rejects.toMatchObject({
    code: 'destination_changed',
  });
});

function observeDurability(store: Awaited<ReturnType<typeof createJobStore>>) {
  const events: string[] = [];
  const sync = installFs.syncDirectory,
    move = nativeFs.rename,
    put = store.put;
  vi.spyOn(installFs, 'syncDirectory').mockImplementation(async (path) => {
    events.push(`sync:${path}`);
    await sync(path);
  });
  vi.spyOn(nativeFs, 'rename').mockImplementation(async (from, to) => {
    events.push(`rename:${from}>${to}`);
    await move(from, to);
  });
  vi.spyOn(store, 'put').mockImplementation((kind, id, value) => {
    if (kind === 'receipt') events.push(`receipt:${(value as { state: string }).state}`);
    put(kind, id, value);
  });
  return events;
}
function expectRenameFlush(events: string[], from: string, to: string) {
  const at = events.indexOf(`rename:${from}>${to}`);
  expect(at).toBeGreaterThanOrEqual(0);
  const following = events.slice(at + 1);
  const boundary = following.findIndex((e) => e.startsWith('receipt:') || e.startsWith('rename:'));
  const syncs = boundary < 0 ? following : following.slice(0, boundary);
  expect(syncs).toContain(`sync:${dirname(from)}`);
  expect(syncs).toContain(`sync:${dirname(to)}`);
}
it('flushes workspace creation and both rename directories before backup/install/restore receipts advance', async () => {
  const f = await fixture(),
    events = observeDurability(f.store);
  const plan = await f.installer.review(f.m, 1, f.destination);
  const r = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  expect(events.slice(0, events.indexOf('receipt:prepared'))).toContain(
    `sync:${dirname(r.workspace)}`,
  );
  expectRenameFlush(events, f.destination.path, r.backup);
  expectRenameFlush(events, r.stage, f.destination.path);
  events.length = 0;
  await f.installer.restore(r.id);
  expectRenameFlush(events, f.destination.path, r.displaced);
  expectRenameFlush(events, r.backup, f.destination.path);
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it.each(['backup', 'restore'] as const)(
  'flushes both directories before acknowledging %s recovery',
  async (kind) => {
    const f = await fixture();
    const plan = await f.installer.review(f.m, 1, f.destination);
    const r = await f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    );
    await nativeFs.rename(f.destination.path, kind === 'backup' ? r.stage : r.displaced);
    r.state = kind === 'backup' ? 'backed-up' : 'restoring';
    f.store.put('receipt', r.id, r);
    const events = observeDurability(f.store);
    if (kind === 'backup') await f.installer.recover(r);
    else await f.installer.restore(r.id);
    expectRenameFlush(events, r.backup, f.destination.path);
    expect(await readFile(join(f.destination.path, 'SKILL.md'), 'utf8')).toBe('old');
    expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
  },
);
it('a workspace flush failure after original rename cannot advance a durable backed-up or installed receipt', async () => {
  const f = await fixture(),
    events = observeDurability(f.store);
  const plan = await f.installer.review(f.m, 1, f.destination);
  const sync = vi.mocked(installFs.syncDirectory).getMockImplementation()!;
  vi.spyOn(installFs, 'syncDirectory').mockImplementation(async (path) => {
    if (
      path.includes('.aasc-install-') &&
      !path.includes('/demo') &&
      events.some((e) => e.startsWith(`rename:${f.destination.path}>`))
    )
      throw new Error('injected directory flush failure');
    await sync(path);
  });
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    ),
  ).rejects.toThrow('flush failure');
  expect(events).not.toContain('receipt:backed-up');
  expect(events).not.toContain('receipt:installed');
  const r = f.store.get<import('../server/cloud/receipts.js').InstallReceipt>('receipt', plan.id)!;
  expect(r.state).toBe('prepared');
  const originalPath = await nativeFs.stat(f.destination.path).then(
    () => f.destination.path,
    () => r.backup,
  );
  expect(await readFile(join(originalPath, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(originalPath, 'unrelated.txt'), 'utf8')).toBe('keep');
});
it('a stage-placement flush failure leaves the last durable receipt retryable with original backup intact', async () => {
  const f = await fixture(),
    events = observeDurability(f.store);
  const plan = await f.installer.review(f.m, 1, f.destination);
  const sync = vi.mocked(installFs.syncDirectory).getMockImplementation()!;
  vi.spyOn(installFs, 'syncDirectory').mockImplementation(async (path) => {
    if (
      events.some((e) => e.startsWith('rename:') && e.endsWith(`>${f.destination.path}`)) &&
      path === dirname(f.destination.path)
    )
      throw new Error('injected stage flush failure');
    await sync(path);
  });
  await expect(
    f.installer.install(
      plan,
      binding,
      async () => Buffer.from('new'),
      () => {},
    ),
  ).rejects.toThrow('stage flush failure');
  const r = f.store.get<import('../server/cloud/receipts.js').InstallReceipt>('receipt', plan.id)!;
  expect(r.state).toBe('backed-up');
  expect(await readFile(join(r.backup, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(r.backup, 'unrelated.txt'), 'utf8')).toBe('keep');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
  vi.restoreAllMocks();
  expect((await f.installer.recover(r)).state).toBe('installed');
});
it('restore flush failure retains restoring intent and both verified copies for explicit recovery', async () => {
  const f = await fixture();
  const plan = await f.installer.review(f.m, 1, f.destination);
  const r = await f.installer.install(
    plan,
    binding,
    async () => Buffer.from('new'),
    () => {},
  );
  const events = observeDurability(f.store);
  const sync = vi.mocked(installFs.syncDirectory).getMockImplementation()!;
  vi.spyOn(installFs, 'syncDirectory').mockImplementation(async (path) => {
    if (path === r.workspace && events.includes(`rename:${f.destination.path}>${r.displaced}`))
      throw new Error('injected restore flush failure');
    await sync(path);
  });
  await expect(f.installer.restore(r.id)).rejects.toThrow('restore flush failure');
  expect(f.store.get<{ state: string }>('receipt', r.id)?.state).toBe('restoring');
  expect(await readFile(join(r.backup, 'SKILL.md'), 'utf8')).toBe('old');
  expect(await readFile(join(r.displaced, 'SKILL.md'), 'utf8')).toBe('new');
  expect(await readFile(join(r.backup, 'unrelated.txt'), 'utf8')).toBe('keep');
  vi.restoreAllMocks();
  expect((await f.installer.restore(r.id)).state).toBe('restored');
  expect(await readFile(join(f.destination.path, 'unrelated.txt'), 'utf8')).toBe('keep');
});
