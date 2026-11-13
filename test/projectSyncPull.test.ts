/**
 * Project Sync pulls (Nov 13 2026): copy folders or files from anywhere in a saved server's home
 * into a project here, without linking them. Files already here are kept unless the pull replaces
 * them; what it replaces or adds can be undone. Both helpers are real processes.
 */
import { describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import type { SyncService } from '../server/projectSync/service.js';
import type { SyncPull, SyncPullInput } from '../src/types/projectSync.js';
import { put, serviceOf, useSyncFixture } from './projectSyncFixture.js';

const f = useSyncFixture();
const read = (p: string) => readFile(p, 'utf8');
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

async function settlePull(s: SyncService, id: string): Promise<SyncPull> {
  for (let i = 0; i < 400; i++) {
    const p = await s.getPull(id);
    if (p.state !== 'running') return p;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('pull did not settle');
}
function pullOf(s: SyncService, input: Partial<SyncPullInput>) {
  return s.planPull({
    deviceId: f.device.id,
    projectId: 'proj-1',
    sources: [],
    ...input,
  });
}
async function pullNow(s: SyncService, input: Partial<SyncPullInput>) {
  const plan = await pullOf(s, input);
  expect(plan.state).toBe('planned');
  await s.startPull(plan.id);
  return settlePull(s, plan.id);
}

describe('pulling server folders into a project', () => {
  it('copies a folder from outside any link into the project, nested files included', async () => {
    await put(join(f.deviceHome, 'data', 'a.txt'), 'aa\n');
    await put(join(f.deviceHome, 'data', 'deep', 'b.txt'), 'bbb\n');
    const s = serviceOf(f);
    const plan = await pullOf(s, { sources: [join(f.deviceHome, 'data')] });
    expect(plan).toMatchObject({
      state: 'planned',
      dest: '~/proj',
      counts: { new: 3, replace: 0, keep: 0, same: 0, skip: 0 },
      bytes: { toGet: 7, got: 0 },
    });
    await s.startPull(plan.id);
    const done = await settlePull(s, plan.id);
    expect(done).toMatchObject({ state: 'complete', failed: 0, bytes: { got: 7 } });
    expect(await read(join(f.src, 'data', 'a.txt'))).toBe('aa\n');
    expect(await read(join(f.src, 'data', 'deep', 'b.txt'))).toBe('bbb\n');
  });

  it('keeps files already here unless the pull replaces them; undo puts them back', async () => {
    await put(join(f.deviceHome, 'data', 'a.txt'), 'server\n');
    await put(join(f.deviceHome, 'data', 'same.txt'), 'same\n');
    await put(join(f.src, 'data', 'a.txt'), 'mine\n');
    await put(join(f.src, 'data', 'same.txt'), 'same\n');
    const s = serviceOf(f);
    const kept = await pullNow(s, { sources: [join(f.deviceHome, 'data')] });
    expect(kept.counts).toMatchObject({ keep: 1, same: 1 });
    expect(await read(join(f.src, 'data', 'a.txt'))).toBe('mine\n');

    const replaced = await pullNow(s, { sources: [join(f.deviceHome, 'data')], replace: true });
    expect(replaced).toMatchObject({ state: 'complete', counts: { replace: 1 } });
    expect(await read(join(f.src, 'data', 'a.txt'))).toBe('server\n');
    const undone = await s.undoPull(replaced.id);
    expect(undone.state).toBe('undone');
    expect(await read(join(f.src, 'data', 'a.txt'))).toBe('mine\n');
  });

  it('undo removes what the pull added', async () => {
    await put(join(f.deviceHome, 'data', 'new.txt'), 'n\n');
    const s = serviceOf(f);
    const p = await pullNow(s, { sources: [join(f.deviceHome, 'data')] });
    expect(await exists(join(f.src, 'data', 'new.txt'))).toBe(true);
    await s.undoPull(p.id);
    expect(await exists(join(f.src, 'data', 'new.txt'))).toBe(false);
  });

  it('copies single files into a subfolder of the project', async () => {
    await put(join(f.deviceHome, 'conf', 'app.yml'), 'a: 1\n');
    await put(join(f.deviceHome, 'conf', 'db.yml'), 'b: 2\n');
    await put(join(f.deviceHome, 'conf', 'other.yml'), 'c: 3\n');
    const s = serviceOf(f);
    const p = await pullNow(s, {
      sources: [join(f.deviceHome, 'conf', 'app.yml'), join(f.deviceHome, 'conf', 'db.yml')],
      into: 'imports/conf',
    });
    expect(p).toMatchObject({ state: 'complete', dest: '~/proj/imports/conf' });
    expect(await read(join(f.src, 'imports', 'conf', 'app.yml'))).toBe('a: 1\n');
    expect(await read(join(f.src, 'imports', 'conf', 'db.yml'))).toBe('b: 2\n');
    expect(await exists(join(f.src, 'imports', 'conf', 'other.yml'))).toBe(false);
  });

  it('leaves out dependency folders, and skips links that lead outside', async () => {
    await put(join(f.deviceHome, 'app', 'index.js'), 'x\n');
    await put(join(f.deviceHome, 'app', 'node_modules', 'dep', 'i.js'), 'dep\n');
    await mkdir(join(f.deviceHome, 'app', 'bin'));
    await symlink('/etc/hosts', join(f.deviceHome, 'app', 'bin', 'hosts'));
    await put(join(f.deviceHome, 'app', 'run.sh'), '#!/bin/sh\n');
    await chmod(join(f.deviceHome, 'app', 'run.sh'), 0o755);
    const s = serviceOf(f);
    const p = await pullNow(s, { sources: [join(f.deviceHome, 'app')] });
    expect(p.state).toBe('complete');
    expect(p.counts.skip).toBe(1);
    expect(p.warnings.join('\n')).toMatch(/link.*outside/i);
    expect(p.warnings.join('\n')).toMatch(/executable/i);
    expect(await exists(join(f.src, 'app', 'node_modules'))).toBe(false);
    expect(await exists(join(f.src, 'app', 'bin', 'hosts'))).toBe(false);
    expect(await read(join(f.src, 'app', 'index.js'))).toBe('x\n');
  });

  it('refuses sources outside the server home, credential folders and clashing names', async () => {
    await put(join(f.deviceHome, 'a', 'same', 'x.txt'));
    await put(join(f.deviceHome, 'b', 'same', 'y.txt'));
    await put(join(f.deviceHome, 'top.txt'));
    await mkdir(join(f.deviceHome, '.ssh'));
    const s = serviceOf(f);
    await expect(pullOf(s, { sources: [] })).rejects.toThrow(/Pick/);
    await expect(pullOf(s, { sources: [f.base] })).rejects.toThrow(/inside/);
    await expect(pullOf(s, { sources: [f.deviceHome] })).rejects.toThrow(/home folder itself/);
    await expect(pullOf(s, { sources: [join(f.deviceHome, '.ssh')] })).rejects.toThrow(
      /credentials/,
    );
    await expect(pullOf(s, { sources: [f.deviceHome + '/a/../b'] })).rejects.toThrow(/plain path/);
    await expect(
      pullOf(s, { sources: [join(f.deviceHome, 'a', 'same'), join(f.deviceHome, 'b', 'same')] }),
    ).rejects.toThrow(/both named "same"/);
    await expect(pullOf(s, { sources: [join(f.deviceHome, 'top.txt')] })).rejects.toThrow(
      /directly in the home folder/,
    );
    await expect(pullOf(s, { sources: [join(f.deviceHome, 'nope')] })).rejects.toThrow(
      /does not exist/,
    );
    await expect(
      pullOf(s, { sources: [join(f.deviceHome, 'a')], into: '../escape' }),
    ).rejects.toThrow(/subfolder/);
    await expect(
      pullOf(s, { sources: [join(f.deviceHome, 'a')], projectId: 'home' }),
    ).rejects.toThrow(/project/);
  });

  it('a pull can be started once, and unknown pulls are not found', async () => {
    await put(join(f.deviceHome, 'data', 'a.txt'));
    const s = serviceOf(f);
    const p = await pullNow(s, { sources: [join(f.deviceHome, 'data')] });
    await expect(s.startPull(p.id)).rejects.toThrow(/already/);
    await expect(s.getPull('2b0c1c5e-9d47-4c55-9f0e-1f0b8f7d1a11')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses a pull this computer has no room for', async () => {
    await put(join(f.deviceHome, 'data', 'big.bin'), 'x'.repeat(4096));
    const s = serviceOf(f, { freeSpace: async () => 10 });
    const p = await pullOf(s, { sources: [join(f.deviceHome, 'data')] });
    await expect(s.startPull(p.id)).rejects.toMatchObject({ code: 'no-space' });
    expect((await s.getPull(p.id)).state).toBe('planned');
  });

  it('never pulls a .git folder, in any letter case, nor into one', async () => {
    await put(join(f.deviceHome, 'x', '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    await put(join(f.deviceHome, 'y', '.GIT', 'config'), '[core]\n');
    const s = serviceOf(f);
    await expect(pullOf(s, { sources: [join(f.deviceHome, 'x', '.git')] })).rejects.toThrow(
      /\.git/,
    );
    await expect(pullOf(s, { sources: [join(f.deviceHome, 'y', '.GIT')] })).rejects.toThrow(
      /\.git/,
    );
    await put(join(f.deviceHome, 'data', 'a.txt'));
    await expect(
      pullOf(s, { sources: [join(f.deviceHome, 'data')], into: 'imports/.GIT' }),
    ).rejects.toThrow(/subfolder/);
    expect(await exists(join(f.src, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('refuses credential folders in any letter case and leaves them out of a picked folder', async () => {
    await put(join(f.deviceHome, '.SSH', 'id_ed25519'), 'KEY\n');
    await put(join(f.deviceHome, 'backup', 'notes.txt'), 'n\n');
    await put(join(f.deviceHome, 'backup', '.ssh', 'id_rsa'), 'KEY\n');
    await put(join(f.deviceHome, 'backup', 'deep', '.Aws', 'credentials'), 'KEY\n');
    const s = serviceOf(f);
    await expect(
      pullOf(s, { sources: [join(f.deviceHome, '.SSH', 'id_ed25519')] }),
    ).rejects.toThrow(/credentials/);
    const p = await pullNow(s, { sources: [join(f.deviceHome, 'backup')] });
    expect(p.state).toBe('complete');
    expect(p.warnings.join('\n')).toMatch(/credential folder/i);
    expect(await read(join(f.src, 'backup', 'notes.txt'))).toBe('n\n');
    expect(await exists(join(f.src, 'backup', '.ssh'))).toBe(false);
    expect(await exists(join(f.src, 'backup', 'deep', '.Aws'))).toBe(false);
  });

  it('skips git names a Mac would read as git’s own instead of failing on them', async () => {
    await put(join(f.deviceHome, 'app', 'index.js'), 'x\n');
    await put(join(f.deviceHome, 'app', '.GIT', 'HEAD'), 'ref: refs/heads/main\n');
    const s = serviceOf(f);
    const p = await pullNow(s, { sources: [join(f.deviceHome, 'app')] });
    expect(p).toMatchObject({ state: 'complete', failed: 0 });
    expect(p.counts.skip).toBeGreaterThanOrEqual(1);
    expect(await read(join(f.src, 'app', 'index.js'))).toBe('x\n');
  });

  it('keeps one waiting plan per project and server', async () => {
    await put(join(f.deviceHome, 'data', 'a.txt'));
    const s = serviceOf(f);
    const first = await pullOf(s, { sources: [join(f.deviceHome, 'data')] });
    const second = await pullOf(s, { sources: [join(f.deviceHome, 'data')] });
    await expect(s.getPull(first.id)).rejects.toMatchObject({ status: 404 });
    expect((await s.getPull(second.id)).state).toBe('planned');
  });

  it('finds a picked item past the first 2,000 entries of its folder', async () => {
    const many = join(f.deviceHome, 'many');
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 2001 }, (_, i) =>
        writeFile(join(many, `f${String(i).padStart(4, '0')}`), ''),
      ),
    );
    await mkdir(join(many, 'zz-last'));
    await put(join(many, 'zz-last', 'a.txt'), 'a\n');
    const s = serviceOf(f);
    const p = await pullOf(s, { sources: [join(many, 'zz-last')] });
    expect(p.counts.new).toBe(1);
  });
});
