import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { localLauncher } from '../server/projectSync/helperClient.js';
import { createSyncService, type SyncService } from '../server/projectSync/service.js';
import { memoryStore, type SyncStore } from '../server/projectSync/store.js';
import type { SyncRun } from '../src/types/projectSync.js';
import type { TransferDevice } from '../src/types/resourceTransfers.js';

let base: string, localHome: string, deviceHome: string, src: string, dst: string;
let device: TransferDevice;
let store: SyncStore;
let active: string[];
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'aasc-sync-service-')));
  localHome = join(base, 'local-home');
  deviceHome = join(base, 'device-home');
  src = join(localHome, 'proj');
  dst = join(deviceHome, 'proj');
  await mkdir(src, { recursive: true });
  await mkdir(deviceHome, { recursive: true });
  device = {
    id: randomUUID(),
    name: 'mini',
    host: 'mini.local',
    username: 'me',
    port: 22,
    fingerprint: 'SHA256:pinned',
    home: deviceHome,
    platform: process.platform,
    checkedAt: 0,
  };
  store = memoryStore();
  active = [];
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function service(overrides: Partial<Parameters<typeof createSyncService>[0]> = {}): SyncService {
  return createSyncService({
    catalog: {
      getCatalog: () =>
        ({
          state: 'ready',
          projects: [
            { id: 'proj-1', name: 'proj', path: '~/proj', exists: true, evidence: [], counts: {} },
            {
              id: 'home',
              name: '~',
              path: '~',
              exists: true,
              isHome: true,
              evidence: [],
              counts: {},
            },
          ],
        }) as never,
    },
    home: localHome,
    store,
    devices: async () => [device],
    fingerprint: async () => 'SHA256:pinned',
    launchLocal: localLauncher({ ...process.env, HOME: localHome }),
    launchDevice: () => localLauncher({ ...process.env, HOME: deviceHome }),
    activeSessionPaths: () => active,
    saveEveryMs: 0,
    ...overrides,
  });
}
async function put(p: string, body = 'x\n') {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
}
async function settle(s: SyncService, id: string): Promise<SyncRun> {
  for (let i = 0; i < 400; i++) {
    const r = await s.getRun(id);
    if (r.state !== 'comparing' && r.state !== 'running') return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error('run did not settle');
}
async function link(s: SyncService, extra: Record<string, unknown> = {}) {
  return s.createLink({
    name: 'proj → mini',
    projectId: 'proj-1',
    deviceId: device.id,
    remoteRoot: dst,
    excludes: [],
    credentialsAck: true,
    ...extra,
  });
}
async function compare(s: SyncService, linkId: string) {
  return settle(s, (await s.compare(linkId)).id);
}
async function runIt(s: SyncService, runId: string, confirm = false) {
  await s.run(runId, { confirmLiveSessions: confirm });
  return settle(s, runId);
}
async function sync(s: SyncService, linkId: string) {
  const r = await compare(s, linkId);
  expect(r.state).toBe('review');
  return runIt(s, r.id);
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  ).trim();
let hasGit = true;
try {
  execFileSync('git', ['--version']);
} catch {
  hasGit = false;
}

describe('links', () => {
  it('validates the acknowledgement, the device folder, overlaps and duplicates', async () => {
    const s = service();
    await expect(link(s, { credentialsAck: false })).rejects.toThrow(/credential/);
    await expect(link(s, { remoteRoot: join(base, 'elsewhere') })).rejects.toThrow(/inside/);
    await expect(link(s, { remoteRoot: deviceHome })).rejects.toThrow(/home folder/);
    await expect(link(s, { remoteRoot: dst + '/' })).rejects.toThrow(/trailing/);
    await expect(link(s, { projectId: 'home' })).rejects.toThrow(/existing project/);
    const l = await link(s);
    expect(l).not.toHaveProperty('localRoot');
    expect(l.state).toBe('never');
    await expect(link(s)).rejects.toThrow(/already links/);
    expect(s.linkedFolder(device.id, join(dst, 'sub'))).toBe('proj → mini');
    expect(s.linkedFolder(device.id, join(deviceHome, 'other'))).toBeNull();
    expect(s.deviceInUse(device.id)).toBe(true);
  });
});

describe('compare and run', () => {
  it('mirrors everything (hidden files included), records a base, then reports nothing to do', async () => {
    await put(join(src, '.env'), 'TOKEN=1\n');
    await put(join(src, '.config/app.json'), '{}\n');
    await put(join(src, 'src/index.ts'), 'export {};\n');
    const s = service();
    const l = await link(s);
    const done = await sync(s, l.id);
    expect(done).toMatchObject({ state: 'complete', failed: 0 });
    expect(await readFile(join(dst, '.env'), 'utf8')).toBe('TOKEN=1\n');
    expect(await readFile(join(dst, '.config/app.json'), 'utf8')).toBe('{}\n');
    const again = await compare(s, l.id);
    expect(again.total).toBe(0);
    expect(again.counts.same).toBe(5);
    expect((await s.overview()).links[0].state).toBe('pending');
  });

  it('strips credential hashes from the browser and never previews them; previews text changes', async () => {
    await put(join(src, '.env'), 'TOKEN=1\n');
    await put(join(src, 'readme.md'), 'one\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(src, '.env'), 'TOKEN=2\n');
    await put(join(src, 'readme.md'), 'two\n');
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
    await put(join(src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await writeFile(join(dst, 'a.txt'), 'edited on device\n');
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
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('edited on device\n');
    expect((await compare(s, l.id)).pendingDecisions).toBe(1);
  });

  it('deletes go to the device trash; a kept delete becomes a kept extra', async () => {
    await put(join(src, 'a.txt'));
    await put(join(src, 'b.txt'));
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(join(src, 'a.txt'));
    await rm(join(src, 'b.txt'));
    const r = await compare(s, l.id);
    const deletes = (await s.entries(r.id, {})).entries;
    expect(deletes.map((e) => [e.path, e.change, e.action])).toEqual([
      ['a.txt', 'delete', 'delete-device'],
      ['b.txt', 'delete', 'delete-device'],
    ]);
    await s.decide(r.id, { entries: { [deletes[1].id]: 'keep' } });
    await runIt(s, r.id);
    await expect(lstat(join(dst, 'a.txt'))).rejects.toThrow();
    expect((await lstat(join(dst, 'b.txt'))).isFile()).toBe(true);
    const next = (await s.entries((await compare(s, l.id)).id, {})).entries;
    expect(next.map((e) => [e.path, e.change, e.action])).toEqual([['b.txt', 'extra', 'keep']]);
  });

  it('asks before running while an AASC session works in the project', async () => {
    await put(join(src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    active = [join(src, 'sub')];
    await expect(s.run(r.id)).rejects.toMatchObject({ code: 'live-sessions' });
    expect((await runIt(s, r.id, true)).state).toBe('complete');
  });

  it('undo restores the device and forgets the base', async () => {
    await put(join(src, 'a.txt'), 'v1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(src, 'a.txt'), 'v2\n');
    const second = await sync(s, l.id);
    const u = await s.undo(second.id);
    expect(u).toMatchObject({ restored: 1, skipped: 0, run: { state: 'undone' } });
    expect(await readFile(join(dst, 'a.txt'), 'utf8')).toBe('v1\n');
    expect((await s.overview()).links[0].hasBase).toBe(false);
    const fresh = await compare(s, l.id);
    expect(fresh.counts.different).toBe(1);
  });

  it('refuses device folders that hold credentials or AASC state', async () => {
    const s = service();
    await expect(link(s, { remoteRoot: join(deviceHome, '.ssh', 'proj') })).rejects.toThrow(
      /credentials or AASC state/,
    );
    await expect(
      link(s, { remoteRoot: join(deviceHome, '.aasc-project-sync', 'x') }),
    ).rejects.toThrow(/credentials or AASC state/);
  });

  it('a store failure after the run still ends it (never stuck "running")', async () => {
    await put(join(src, 'a.txt'));
    const failing = {
      ...store,
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
    await put(join(src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    const [a, b] = await Promise.allSettled([s.run(r.id), s.run(r.id)]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect((await settle(s, r.id)).state).toBe('complete');
  });

  it('changing what is left out invalidates a waiting review', async () => {
    await put(join(src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await s.updateLink(l.id, { excludes: ['*.txt'] });
    expect((await s.getRun(r.id)).state).toBe('failed');
    await expect(s.run(r.id)).rejects.toThrow(/left out changed/);
  });

  it('marks an interrupted run after a restart', async () => {
    await put(join(src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await store.saveRun({ ...r, state: 'running' });
    const restarted = service();
    expect((await restarted.getRun(r.id)).state).toBe('interrupted');
  });
});

describe.skipIf(!hasGit)('git repositories', () => {
  it('a mirrored repo is valid on the device, and moved-then-packed or deleted refs follow the source', async () => {
    git(src, 'init', '-q');
    await put(join(src, 'a.txt'), 'one\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'one');
    git(src, 'branch', 'feature');
    const s = service();
    const l = await link(s);
    const first = await compare(s, l.id);
    expect(first.groups.find((g) => g.id === '.git')).toMatchObject({
      isRepo: true,
      decision: 'sync',
    });
    expect((await runIt(s, first.id)).state).toBe('complete');
    git(dst, 'fsck', '--no-progress');
    expect(git(dst, 'status', '--porcelain')).toBe('');
    expect(git(dst, 'rev-parse', 'feature')).toBe(git(src, 'rev-parse', 'feature'));

    // The ref moves, then gets packed, between two syncs: the device's stale loose ref must go.
    await put(join(src, 'a.txt'), 'two\n');
    git(src, 'commit', '-q', '-am', 'two');
    git(src, 'branch', '-f', 'feature', 'HEAD');
    git(src, 'pack-refs', '--all');
    const second = await compare(s, l.id);
    expect(second.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'local-ahead',
      decision: 'sync',
    });
    expect((await runIt(s, second.id)).state).toBe('complete');
    expect(git(dst, 'rev-parse', 'feature')).toBe(git(src, 'rev-parse', 'feature'));
    expect(git(dst, 'status', '--porcelain')).toBe('');

    git(src, 'branch', '-D', 'feature');
    await runIt(s, (await compare(s, l.id)).id);
    expect(() => git(dst, 'rev-parse', '--verify', '--quiet', 'feature')).toThrow();
    git(dst, 'fsck', '--no-progress');
  });

  it('Retry applies what failed because git was busy here, once the lock is gone', async () => {
    git(src, 'init', '-q');
    await put(join(src, 'a.txt'), 'one\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'one');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await put(join(src, '.git/index.lock'), '');
    const busy = await runIt(s, r.id);
    expect(busy.state).toBe('partial');
    await rm(join(src, '.git/index.lock'));
    const retried = await runIt(s, r.id);
    expect(retried).toMatchObject({ state: 'complete', failed: 0 });
    git(dst, 'fsck', '--no-progress');
  });

  it('a repo with a .lock file is skipped and cannot be forced', async () => {
    git(src, 'init', '-q');
    await put(join(src, '.git/index.lock'), '');
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
    git(src, 'init', '-q');
    await put(join(src, 'a.txt'), 'one\n');
    git(src, 'add', '.');
    git(src, 'commit', '-q', '-m', 'one');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    git(dst, 'branch', 'device-only');
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
    expect(() => git(dst, 'rev-parse', '--verify', '--quiet', 'device-only')).toThrow();
    git(dst, 'fsck', '--no-progress');
  });
});
