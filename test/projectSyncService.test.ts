import { describe, expect, it } from 'vitest';
import { lstat, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { SyncService } from '../server/projectSync/service.js';
import {
  compare,
  git,
  hasGit,
  put,
  runIt,
  serviceOf,
  settle,
  sync,
  useSyncFixture,
  type SyncFixture,
} from './projectSyncFixture.js';

// P1: push links (this computer mirrored onto the server). Two-way: projectSyncTwoWay.test.ts.
const f: SyncFixture = useSyncFixture();
const service = (overrides: Parameters<typeof serviceOf>[1] = {}) => serviceOf(f, overrides);
async function link(s: SyncService, extra: Record<string, unknown> = {}) {
  return s.createLink({
    name: 'proj → mini',
    projectId: 'proj-1',
    deviceId: f.device.id,
    remoteRoot: f.dst,
    excludes: [],
    credentialsAck: true,
    direction: 'push',
    ...extra,
  });
}

describe('links', () => {
  it('validates the acknowledgement, the device folder, overlaps and duplicates', async () => {
    const s = service();
    await expect(link(s, { credentialsAck: false })).rejects.toThrow(/credential/);
    await expect(link(s, { remoteRoot: join(f.base, 'elsewhere') })).rejects.toThrow(/inside/);
    await expect(link(s, { remoteRoot: f.deviceHome })).rejects.toThrow(/home folder/);
    await expect(link(s, { remoteRoot: f.dst + '/' })).rejects.toThrow(/trailing/);
    await expect(link(s, { projectId: 'home' })).rejects.toThrow(/existing project/);
    const l = await link(s);
    expect(l).not.toHaveProperty('localRoot');
    expect(l.state).toBe('never');
    await expect(link(s)).rejects.toThrow(/already links/);
    await expect(s.removeDevice(f.device.id)).rejects.toThrow(/Remove that link first/);
  });
});

describe('compare and run', () => {
  it('mirrors everything (hidden files included), records a base, then reports nothing to do', async () => {
    await put(join(f.src, '.env'), 'TOKEN=1\n');
    await put(join(f.src, '.config/app.json'), '{}\n');
    await put(join(f.src, 'src/index.ts'), 'export {};\n');
    const s = service();
    const l = await link(s);
    const done = await sync(s, l.id);
    expect(done).toMatchObject({ state: 'complete', failed: 0 });
    expect(await readFile(join(f.dst, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(await readFile(join(f.dst, '.config/app.json'), 'utf8')).toBe('{}\n');
    const again = await compare(s, l.id);
    expect(again.total).toBe(0);
    expect(again.counts.same).toBe(5);
    expect((await s.overview()).links[0].state).toBe('pending');
  });

  it('strips credential hashes from the browser and never previews them; previews text changes', async () => {
    await put(join(f.src, '.env'), 'TOKEN=1\n');
    await put(join(f.src, 'readme.md'), 'one\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, '.env'), 'TOKEN=2\n');
    await put(join(f.src, 'readme.md'), 'two\n');
    const r = await compare(s, l.id);
    const page = await s.entries(r.id, { filter: 'changes' });
    const env = page.entries.find((e) => e.path === '.env')!;
    expect(env.flags).toContain('credential');
    expect(env.local).not.toHaveProperty('sha256');
    expect(env.device).not.toHaveProperty('sha256');
    expect(await s.diff(r.id, env.id)).toEqual({
      patch: null,
      note: expect.stringMatching(/never previewed/),
    });
    const readme = page.entries.find((e) => e.path === 'readme.md')!;
    const d = await s.diff(r.id, readme.id);
    expect(d.patch).toMatch(/-one/);
    expect(d.patch).toMatch(/\+two/);
    expect(r.warnings.join(' ')).toMatch(/credential file/);
  });

  it('a device-side change needs a decision; keeping it leaves the device file and asks again next time', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await writeFile(join(f.dst, 'a.txt'), 'edited on device\n');
    const r = await compare(s, l.id);
    expect(r.pendingDecisions).toBe(1);
    await expect(s.run(r.id)).rejects.toThrow(/need a decision/);
    const drift = (await s.entries(r.id, { filter: 'decisions' })).entries[0];
    expect(drift).toMatchObject({ path: 'a.txt', change: 'drift' });
    await expect(s.decide(r.id, { entries: { [drift.id]: 'delete-device' } })).rejects.toThrow(
      /not possible/,
    );
    await s.decide(r.id, { entries: { [drift.id]: 'keep' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await readFile(join(f.dst, 'a.txt'), 'utf8')).toBe('edited on device\n');
    expect((await compare(s, l.id)).pendingDecisions).toBe(1);
  });

  it('deletes go to the device trash; a kept delete becomes a kept extra', async () => {
    await put(join(f.src, 'a.txt'));
    await put(join(f.src, 'b.txt'));
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(join(f.src, 'a.txt'));
    await rm(join(f.src, 'b.txt'));
    const r = await compare(s, l.id);
    const deletes = (await s.entries(r.id, {})).entries;
    expect(deletes.map((e) => [e.path, e.change, e.action])).toEqual([
      ['a.txt', 'delete', 'delete-device'],
      ['b.txt', 'delete', 'delete-device'],
    ]);
    await s.decide(r.id, { entries: { [deletes[1].id]: 'keep' } });
    await runIt(s, r.id);
    await expect(lstat(join(f.dst, 'a.txt'))).rejects.toThrow();
    expect((await lstat(join(f.dst, 'b.txt'))).isFile()).toBe(true);
    const next = (await s.entries((await compare(s, l.id)).id, {})).entries;
    expect(next.map((e) => [e.path, e.change, e.action])).toEqual([['b.txt', 'extra', 'keep']]);
  });

  it('asks before running while an AASC session works in the project', async () => {
    await put(join(f.src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    f.active = [join(f.src, 'sub')];
    await expect(s.run(r.id)).rejects.toMatchObject({ code: 'live-sessions' });
    expect((await runIt(s, r.id, true)).state).toBe('complete');
  });

  it('undo restores the device and forgets the base', async () => {
    await put(join(f.src, 'a.txt'), 'v1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'v2\n');
    const second = await sync(s, l.id);
    const u = await s.undo(second.id);
    expect(u).toMatchObject({ restored: 1, skipped: 0, run: { state: 'undone' } });
    expect(await readFile(join(f.dst, 'a.txt'), 'utf8')).toBe('v1\n');
    expect((await s.overview()).links[0].hasBase).toBe(false);
    const fresh = await compare(s, l.id);
    expect(fresh.counts.different).toBe(1);
  });

  it('refuses device folders that hold credentials or AASC state', async () => {
    const s = service();
    await expect(link(s, { remoteRoot: join(f.deviceHome, '.ssh', 'proj') })).rejects.toThrow(
      /credentials or AASC state/,
    );
    await expect(
      link(s, { remoteRoot: join(f.deviceHome, '.aasc-project-sync', 'x') }),
    ).rejects.toThrow(/credentials or AASC state/);
  });

  it('a store failure after the run still ends it (never stuck "running")', async () => {
    await put(join(f.src, 'a.txt'));
    const failing = {
      ...f.store,
      replaceBase: async () => {
        throw new Error('SQLITE_FULL');
      },
    };
    const s = service({ store: failing });
    const l = await link(s);
    const r = await compare(s, l.id);
    const done = await runIt(s, r.id);
    expect(done.state).toBe('partial');
    expect(done.error).toMatch(/SQLITE_FULL/);
    await expect(s.compare(l.id)).resolves.toMatchObject({ state: 'comparing' });
  });

  it('a second Run while the first is starting is refused (the slot is claimed before any await)', async () => {
    await put(join(f.src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    const [a, b] = await Promise.allSettled([s.run(r.id), s.run(r.id)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await settle(s, r.id)).state).toBe('complete');
  });

  it('changing what is left out invalidates a waiting review', async () => {
    await put(join(f.src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await s.updateLink(l.id, { excludes: ['*.txt'] });
    expect((await s.getRun(r.id)).state).toBe('failed');
    await expect(s.run(r.id)).rejects.toThrow(/left out changed/);
  });

  it('marks an interrupted run after a restart', async () => {
    await put(join(f.src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await f.store.saveRun({ ...r, state: 'running' });
    const restarted = service();
    expect((await restarted.getRun(r.id)).state).toBe('interrupted');
  });
});

describe.skipIf(!hasGit)('git repositories', () => {
  it('a mirrored repo is valid on the device, and moved-then-packed or deleted refs follow the source', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'one\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-q', '-m', 'one');
    git(f.src, 'branch', 'feature');
    const s = service();
    const l = await link(s);
    const first = await compare(s, l.id);
    expect(first.groups.find((g) => g.id === '.git')).toMatchObject({
      isRepo: true,
      decision: 'sync',
    });
    expect((await runIt(s, first.id)).state).toBe('complete');
    git(f.dst, 'fsck', '--no-progress');
    expect(git(f.dst, 'status', '--porcelain')).toBe('');
    expect(git(f.dst, 'rev-parse', 'feature')).toBe(git(f.src, 'rev-parse', 'feature'));

    // The ref moves, then gets packed, between two syncs: the device's stale loose ref must go.
    await put(join(f.src, 'a.txt'), 'two\n');
    git(f.src, 'commit', '-q', '-am', 'two');
    git(f.src, 'branch', '-f', 'feature', 'HEAD');
    git(f.src, 'pack-refs', '--all');
    const second = await compare(s, l.id);
    expect(second.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'local-ahead',
      decision: 'sync',
    });
    expect((await runIt(s, second.id)).state).toBe('complete');
    expect(git(f.dst, 'rev-parse', 'feature')).toBe(git(f.src, 'rev-parse', 'feature'));
    expect(git(f.dst, 'status', '--porcelain')).toBe('');

    git(f.src, 'branch', '-D', 'feature');
    await runIt(s, (await compare(s, l.id)).id);
    expect(() => git(f.dst, 'rev-parse', '--verify', '--quiet', 'feature')).toThrow();
    git(f.dst, 'fsck', '--no-progress');
  });

  it('Retry applies what failed because git was busy here, once the lock is gone', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'one\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-q', '-m', 'one');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await put(join(f.src, '.git/index.lock'), '');
    const busy = await runIt(s, r.id);
    expect(busy.state).toBe('partial');
    await rm(join(f.src, '.git/index.lock'));
    const retried = await runIt(s, r.id);
    expect(retried).toMatchObject({ state: 'complete', failed: 0 });
    git(f.dst, 'fsck', '--no-progress');
  });

  it('a repo with a .lock file is skipped and cannot be forced', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, '.git/index.lock'), '');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    expect(r.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'busy',
      decision: 'skip',
    });
    await expect(s.decide(r.id, { groups: { '.git': 'overwrite' } })).rejects.toThrow(/busy/);
  });

  it('a repo changed on the device needs Overwrite or Skip; Overwrite makes it equal', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'one\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-q', '-m', 'one');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    git(f.dst, 'branch', 'device-only');
    const r = await compare(s, l.id);
    expect(r.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'device-changed',
      decision: 'review',
    });
    await expect(s.decide(r.id, { groups: { '.git': 'sync' } })).rejects.toThrow(
      /Overwrite or Skip/,
    );
    await s.decide(r.id, { groups: { '.git': 'overwrite' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(() => git(f.dst, 'rev-parse', '--verify', '--quiet', 'device-only')).toThrow();
    git(f.dst, 'fsck', '--no-progress');
  });
});
