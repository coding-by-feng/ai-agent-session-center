import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  applyOps,
  localLauncher,
  readManifest,
  readText,
  undoRun,
  type Ack,
} from '../server/projectSync/helperClient.js';
import { applyOrder, classify, sameContent } from '../server/projectSync/classify.js';
import type { FileMeta } from '../src/types/projectSync.js';

let base: string, localHome: string, deviceHome: string, src: string, dst: string;
const opts = { localPlatform: process.platform, devicePlatform: process.platform };
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'aasc-sync-helper-')));
  localHome = join(base, 'local-home');
  deviceHome = join(base, 'device-home');
  src = join(localHome, 'proj');
  dst = join(deviceHome, 'proj');
  await mkdir(src, { recursive: true });
  await mkdir(deviceHome, { recursive: true });
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});
const local = () => localLauncher({ ...process.env, HOME: localHome });
const device = () => localLauncher({ ...process.env, HOME: deviceHome });
async function put(p: string, body = 'x\n', mode?: number) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
  if (mode) await chmod(p, mode);
}
const manifestOf = async (
  launch: ReturnType<typeof local>,
  root: string,
  excludes: string[] = [],
  b = new Map<string, FileMeta>(),
) => (await readManifest(launch, { root, excludes, base: b })).manifest;

/** Compare both sides and push everything the plan says to push; returns the acks. */
async function push(b = new Map<string, FileMeta>(), linkId = randomUUID(), runId = randomUUID()) {
  const L = await manifestOf(local(), src, [], b);
  const R = await manifestOf(device(), dst, [], b);
  const plan = classify(L, R, b, opts);
  for (const e of plan.entries) if (e.action === 'review') e.action = 'push';
  const acks: Ack[] = [];
  await applyOps(device(), { root: dst, linkId, runId }, src, applyOrder(plan.entries, R), {
    onAck: (a) => acks.push(a),
    cancelled: () => false,
  });
  return { acks, plan, linkId, runId };
}
const baseFrom = async () => {
  const L = await manifestOf(local(), src);
  return new Map<string, FileMeta>([...L].map(([p, m]) => [p, m]));
};

describe('manifest', () => {
  it('lists dotfiles, empty folders, links (unfollowed), modes and git heads; skips excludes', async () => {
    await put(join(src, '.env'), 'TOKEN=1\n');
    await put(join(src, 'bin/run.sh'), 'echo\n', 0o755);
    await mkdir(join(src, 'empty'));
    await symlink('bin/run.sh', join(src, 'link'));
    await symlink('/etc', join(src, 'etc-link'));
    await put(join(src, '.git/HEAD'), 'ref: refs/heads/main\n');
    await put(join(src, 'node_modules/a/index.js'));
    await put(join(src, 'logs/x.log'));
    await put(join(src, 'build/out.js'));
    await put(join(src, 'sub/build/keep.js'));
    const m = await manifestOf(local(), src, ['node_modules/', '*.log', '/build']);
    expect(m.get('.env')).toMatchObject({ kind: 'file', size: 8 });
    expect(m.get('bin/run.sh')?.mode).toBe(0o755);
    expect(m.get('empty')?.kind).toBe('dir');
    expect(m.get('link')).toMatchObject({ kind: 'symlink', linkTarget: 'bin/run.sh' });
    expect(m.get('etc-link')).toMatchObject({ kind: 'symlink', linkTarget: '/etc' });
    expect([...m.keys()].some((k) => k.startsWith('etc-link/'))).toBe(false);
    expect(m.get('.git/HEAD')?.text).toBe('ref: refs/heads/main\n');
    expect(m.has('node_modules')).toBe(false);
    expect(m.has('logs/x.log')).toBe(false);
    expect(m.has('build')).toBe(false);
    expect(m.has('sub/build/keep.js')).toBe(true);
  });
  it('reports special files as "other"', async () => {
    execFileSync('mkfifo', [join(src, 'pipe')]);
    expect((await manifestOf(local(), src)).get('pipe')?.kind).toBe('other');
  });
  it('trusts the base hash only while size, mtime and mode are unchanged', async () => {
    await put(join(src, 'a.txt'), 'hello\n');
    const real = (await manifestOf(local(), src)).get('a.txt')!;
    const fake = 'f'.repeat(64);
    const b = new Map<string, FileMeta>([['a.txt', { ...real, sha256: fake }]]);
    expect((await manifestOf(local(), src, [], b)).get('a.txt')?.sha256).toBe(fake);
    await utimes(join(src, 'a.txt'), new Date(), new Date(real.mtimeMs + 5000));
    expect((await manifestOf(local(), src, [], b)).get('a.txt')?.sha256).toBe(real.sha256);
  });
  it('reports a missing root as empty, and refuses the home folder itself', async () => {
    expect(
      (await readManifest(device(), { root: dst, excludes: [], base: new Map() })).missing,
    ).toBe(true);
    await expect(manifestOf(device(), deviceHome)).rejects.toThrow(/home folder/);
  });
});

describe('apply', () => {
  it('mirrors every file kind, keeps modes and mtimes, and creates the device folder', async () => {
    await put(join(src, '.env'), 'TOKEN=1\n');
    await put(join(src, '.hidden/deep/file'), 'deep\n');
    await put(join(src, 'bin/run.sh'), 'echo\n', 0o755);
    await mkdir(join(src, 'empty'));
    await symlink('bin/run.sh', join(src, 'link'));
    await put(join(src, 'big.bin'), Buffer.alloc(3 * 1024 * 1024 + 7, 7) as unknown as string);
    const { acks } = await push();
    expect(acks.filter((a) => a.state !== 'done')).toEqual([]);
    const L = await manifestOf(local(), src),
      R = await manifestOf(device(), dst);
    expect([...R.keys()].sort()).toEqual([...L.keys()].sort());
    for (const [p, m] of L) {
      expect(sameContent(m, R.get(p)), p).toBe(true);
      if (m.kind === 'file')
        expect(Math.abs(R.get(p)!.mtimeMs - m.mtimeMs), p).toBeLessThanOrEqual(1);
    }
    expect(await readlink(join(dst, 'link'))).toBe('bin/run.sh');
    expect((await lstat(join(dst, 'bin/run.sh'))).mode & 0o777).toBe(0o755);
  });
  it('backs up replaced files, trashes deleted ones, and undo puts both back and removes adds', async () => {
    await put(join(src, 'keep.txt'), 'v1\n');
    await put(join(src, 'gone.txt'), 'bye\n');
    const first = await push();
    const b = await baseFrom();
    await put(join(src, 'keep.txt'), 'v2\n');
    await rm(join(src, 'gone.txt'));
    await put(join(src, 'new.txt'), 'new\n');
    const second = await push(b, first.linkId);
    expect(second.acks.every((a) => a.state === 'done')).toBe(true);
    expect(await readFile(join(dst, 'keep.txt'), 'utf8')).toBe('v2\n');
    await expect(lstat(join(dst, 'gone.txt'))).rejects.toThrow();
    const r = await undoRun(device(), { root: dst, linkId: first.linkId, runId: second.runId });
    expect(r).toEqual({ restored: 3, skipped: 0 });
    expect(await readFile(join(dst, 'keep.txt'), 'utf8')).toBe('v1\n');
    expect(await readFile(join(dst, 'gone.txt'), 'utf8')).toBe('bye\n');
    await expect(lstat(join(dst, 'new.txt'))).rejects.toThrow();
  });
  it('undo leaves a file alone when the device changed it after the run', async () => {
    await put(join(src, 'a.txt'), 'v1\n');
    const first = await push();
    const b = await baseFrom();
    await put(join(src, 'a.txt'), 'v2\n');
    const second = await push(b, first.linkId);
    await writeFile(join(dst, 'a.txt'), 'edited on device\n');
    expect(
      await undoRun(device(), { root: dst, linkId: first.linkId, runId: second.runId }),
    ).toEqual({
      restored: 0,
      skipped: 1,
    });
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('edited on device\n');
  });
  it('fails only the entry the device changed since compare, and a retry is idempotent', async () => {
    await put(join(src, 'a.txt'), 'a\n');
    await put(join(src, 'b.txt'), 'b\n');
    await mkdir(dst, { recursive: true });
    await put(join(dst, 'a.txt'), 'device a\n');
    const L = await manifestOf(local(), src),
      R = await manifestOf(device(), dst);
    const plan = classify(L, R, new Map(), opts);
    for (const e of plan.entries) if (e.action === 'review') e.action = 'push';
    await writeFile(join(dst, 'a.txt'), 'device a, edited again\n');
    const ops = applyOrder(plan.entries, R);
    const linkId = randomUUID(),
      runId = randomUUID();
    const acks: Ack[] = [];
    await applyOps(device(), { root: dst, linkId, runId }, src, ops, {
      onAck: (a) => acks.push(a),
      cancelled: () => false,
    });
    const byPath = (id: string) => plan.entries.find((e) => e.id === id)!.path;
    expect(acks.map((a) => [byPath(a.id), a.state])).toEqual([
      ['a.txt', 'failed'],
      ['b.txt', 'done'],
    ]);
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('device a, edited again\n');
    const again: Ack[] = [];
    await applyOps(device(), { root: dst, linkId, runId }, src, ops.slice(1), {
      onAck: (a) => again.push(a),
      cancelled: () => false,
    });
    expect(again.map((a) => a.state)).toEqual(['done']);
  });
  it('fails an entry whose local file changed after compare', async () => {
    await put(join(src, 'a.txt'), 'a\n');
    const L = await manifestOf(local(), src);
    const plan = classify(L, new Map(), new Map(), opts);
    await put(join(src, 'a.txt'), 'a, longer now\n');
    const acks: Ack[] = [];
    await applyOps(
      device(),
      { root: dst, linkId: randomUUID(), runId: randomUUID() },
      src,
      applyOrder(plan.entries, new Map()),
      {
        onAck: (a) => acks.push(a),
        cancelled: () => false,
      },
    );
    expect(acks[0]).toMatchObject({ state: 'failed' });
    await expect(lstat(join(dst, 'a.txt'))).rejects.toThrow();
  });
  it('never writes through a link on the device, nor outside the root', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await mkdir(dst, { recursive: true });
    await symlink(outside, join(dst, 'sub'));
    await put(join(src, 'sub/x.txt'), 'x\n');
    const L = await manifestOf(local(), src);
    const sub = L.get('sub/x.txt')!;
    const acks: Ack[] = [];
    await applyOps(
      device(),
      { root: dst, linkId: randomUUID(), runId: randomUUID() },
      src,
      [
        { op: 'put', entryId: randomUUID(), path: 'sub/x.txt', meta: sub, expect: null },
        { op: 'put', entryId: randomUUID(), path: '../escape.txt', meta: sub, expect: null },
      ],
      { onAck: (a) => acks.push(a), cancelled: () => false },
    );
    expect(acks.map((a) => a.state)).toEqual(['failed', 'failed']);
    await expect(lstat(join(outside, 'x.txt'))).rejects.toThrow();
    // A link further up the path (sub → outside, outside/deeper is a real folder) is refused too.
    await mkdir(join(outside, 'deeper'));
    await put(join(src, 'sub/deeper/x.txt'), 'deep\n');
    const deepMeta = (await manifestOf(local(), src)).get('sub/deeper/x.txt')!;
    const deep: Ack[] = [];
    await applyOps(
      device(),
      { root: dst, linkId: randomUUID(), runId: randomUUID() },
      src,
      [
        {
          op: 'put',
          entryId: randomUUID(),
          path: 'sub/deeper/x.txt',
          meta: deepMeta,
          expect: null,
        },
      ],
      { onAck: (a) => deep.push(a), cancelled: () => false },
    );
    expect(deep).toEqual([
      { id: expect.any(String), state: 'failed', error: expect.stringMatching(/symbolic link/) },
    ]);
    await expect(lstat(join(outside, 'deeper', 'x.txt'))).rejects.toThrow();
    await expect(lstat(join(deviceHome, 'escape.txt'))).rejects.toThrow();
  });
  it('refuses a device folder outside the device home or behind a link', async () => {
    await put(join(src, 'a.txt'));
    const L = await manifestOf(local(), src);
    const ops = applyOrder(classify(L, new Map(), new Map(), opts).entries, new Map());
    const run = (root: string) =>
      applyOps(device(), { root, linkId: randomUUID(), runId: randomUUID() }, src, ops, {
        onAck: () => {},
        cancelled: () => false,
      });
    await expect(run(join(base, 'elsewhere'))).rejects.toThrow(/inside the home folder/);
    await symlink(join(base, 'elsewhere'), join(deviceHome, 'linked'));
    await expect(run(join(deviceHome, 'linked', 'proj'))).rejects.toThrow(/symbolic link/);
  });
  it('a held device lock refuses a second writer on the same device folder', async () => {
    const lockDir = join(
      deviceHome,
      '.aasc-project-sync',
      'locks',
      createHash('sha256').update(dst).digest('hex').slice(0, 32),
    );
    await mkdir(join(lockDir, 'lock'), { recursive: true, mode: 0o700 });
    for (const d of [
      join(deviceHome, '.aasc-project-sync'),
      join(deviceHome, '.aasc-project-sync', 'locks'),
      lockDir,
    ])
      await chmod(d, 0o700);
    await writeFile(join(lockDir, 'lock', `owner-${process.pid}-${randomUUID()}`), '');
    await put(join(src, 'a.txt'));
    const L = await manifestOf(local(), src);
    await expect(
      applyOps(
        device(),
        { root: dst, linkId: randomUUID(), runId: randomUUID() },
        src,
        applyOrder(classify(L, new Map(), new Map(), opts).entries, new Map()),
        {
          onAck: () => {},
          cancelled: () => false,
        },
      ),
    ).rejects.toThrow(/Another sync/);
  });
  it('writes credential files owner-only and never group/other-writable modes, and reports them the same way', async () => {
    await put(join(src, '.env'), 'T=1\n');
    await chmod(join(src, '.env'), 0o644);
    await put(join(src, 'open.sh'), 'echo\n');
    await chmod(join(src, 'open.sh'), 0o777);
    const { acks } = await push();
    expect(acks.every((a) => a.state === 'done')).toBe(true);
    expect((await lstat(join(dst, '.env'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(dst, 'open.sh'))).mode & 0o777).toBe(0o755);
    expect((await lstat(dst)).mode & 0o777).toBe(0o700);
    const L = await manifestOf(local(), src),
      R = await manifestOf(device(), dst);
    expect(classify(L, R, new Map(), opts).entries.every((e) => e.change === 'same')).toBe(true);
  });
  it('refuses to write under a device folder other accounts can write to', async () => {
    await put(join(src, 'shared/a.txt'));
    await push();
    await chmod(join(dst, 'shared'), 0o777);
    await put(join(src, 'shared/b.txt'));
    const L = await manifestOf(local(), src),
      R = await manifestOf(device(), dst);
    const plan = classify(L, R, new Map(), opts);
    for (const e of plan.entries) if (e.action === 'review') e.action = 'skip';
    const acks: Ack[] = [];
    await applyOps(
      device(),
      { root: dst, linkId: randomUUID(), runId: randomUUID() },
      src,
      applyOrder(plan.entries, R),
      { onAck: (a) => acks.push(a), cancelled: () => false },
    );
    expect(acks).toEqual([
      {
        id: expect.any(String),
        state: 'failed',
        error: expect.stringMatching(/writable by other accounts/),
      },
    ]);
    await expect(lstat(join(dst, 'shared/b.txt'))).rejects.toThrow();
  });
  it('stops a repository at its first failed write: refs and deletes after it are not applied', async () => {
    await put(join(src, '.git/HEAD'), 'ref: refs/heads/main\n');
    await put(join(src, '.git/objects/pack/old.pack'), 'old\n');
    await put(join(src, '.git/refs/heads/main'), 'aaaa\n');
    const first = await push();
    const b = await baseFrom();
    await rm(join(src, '.git/objects/pack/old.pack'));
    await put(join(src, '.git/objects/pack/new.pack'), 'new\n');
    await put(join(src, '.git/refs/heads/main'), 'bbbb\n');
    const L = await manifestOf(local(), src, [], b),
      R = await manifestOf(device(), dst, [], b);
    const plan = classify(L, R, b, opts);
    await put(join(src, '.git/objects/pack/new.pack'), 'new, but changed after compare\n');
    const acks: Ack[] = [];
    await applyOps(
      device(),
      { root: dst, linkId: first.linkId, runId: randomUUID() },
      src,
      applyOrder(plan.entries, R),
      { onAck: (a) => acks.push(a), cancelled: () => false },
    );
    const byPath = (p: string) =>
      acks.find((a) => plan.entries.find((e) => e.id === a.id)!.path === p);
    expect(byPath('.git/objects/pack/new.pack')).toMatchObject({ state: 'failed' });
    expect(byPath('.git/refs/heads/main')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/earlier write in this repository/),
    });
    expect(byPath('.git/objects/pack/old.pack')).toMatchObject({ state: 'failed' });
    expect(await readFile(join(dst, '.git/refs/heads/main'), 'utf8')).toBe('aaaa\n');
    expect(await readFile(join(dst, '.git/objects/pack/old.pack'), 'utf8')).toBe('old\n');
  });
  it('undo leaves a file in place when its backup is gone', async () => {
    await put(join(src, 'a.txt'), 'v1\n');
    const first = await push();
    const b = await baseFrom();
    await put(join(src, 'a.txt'), 'v2\n');
    const second = await push(b, first.linkId);
    await rm(join(deviceHome, '.aasc-project-sync', first.linkId, 'runs', second.runId, 'backup'), {
      recursive: true,
    });
    expect(
      await undoRun(device(), { root: dst, linkId: first.linkId, runId: second.runId }),
    ).toEqual({ restored: 0, skipped: 1 });
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('v2\n');
  });
  it("keeps the helper's own reason when it stops early, even with a large base", async () => {
    const big = new Map<string, FileMeta>();
    for (let i = 0; i < 6000; i++)
      big.set(`f${i}.txt`, {
        kind: 'file',
        size: 1,
        mtimeMs: 1,
        mode: 0o644,
        sha256: 'a'.repeat(64),
      });
    await expect(
      readManifest(device(), { root: deviceHome, excludes: [], base: big }),
    ).rejects.toThrow(/home folder/);
  });
  it('confines device manifests and reads to the device home when asked', async () => {
    await mkdir(join(base, 'outside'), { recursive: true });
    await expect(
      readManifest(device(), {
        root: join(base, 'outside'),
        excludes: [],
        base: new Map(),
        inHome: true,
      }),
    ).rejects.toThrow(/inside the home folder/);
    await expect(
      readText(device(), { root: join(base, 'outside'), path: 'x', max: 10, inHome: true }),
    ).rejects.toThrow(/inside the home folder/);
  });
  it('reads a small device file for previews', async () => {
    await put(join(dst, 'a.txt'), 'device text\n');
    expect((await readText(device(), { root: dst, path: 'a.txt', max: 1024 }))?.toString()).toBe(
      'device text\n',
    );
    expect(await readText(device(), { root: dst, path: 'missing', max: 1024 })).toBeNull();
  });
});
