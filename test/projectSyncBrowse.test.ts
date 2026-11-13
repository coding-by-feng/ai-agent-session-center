/**
 * Project Sync server reach (Nov 13 2026): browse a server folder (one level, inside its home),
 * read free space before a run, and purge undo journals of runs no longer kept. The helpers are
 * real processes; the "server" is a second temporary home.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { mkdir, readdir, symlink, utimes, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  freeSpace,
  listDir,
  localLauncher,
  purgeRuns,
  readManifest,
} from '../server/projectSync/helperClient.js';
import { validRemoteRoot } from '../server/projectSync/servers.js';
import { compare, put, runIt, serviceOf, sync, useSyncFixture } from './projectSyncFixture.js';

const f = useSyncFixture();
const device = () => localLauncher({ ...process.env, HOME: f.deviceHome });
const local = () => localLauncher({ ...process.env, HOME: f.localHome });

describe('helper: list', () => {
  it('lists one folder level inside home and hides credential and AASC folders', async () => {
    await put(join(f.deviceHome, 'notes.txt'), 'hello\n');
    await mkdir(join(f.deviceHome, 'data'));
    await mkdir(join(f.deviceHome, '.config'));
    await mkdir(join(f.deviceHome, '.ssh'));
    await mkdir(join(f.deviceHome, '.aasc-project-sync'));
    await symlink('/etc', join(f.deviceHome, 'etc-link'));
    const r = await listDir(device(), f.deviceHome);
    expect(r.missing).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.home).toBe(f.deviceHome);
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['.config', 'data', 'etc-link', 'notes.txt']);
    expect(byName['notes.txt']).toMatchObject({ kind: 'file', size: 6 });
    expect(byName.data.kind).toBe('dir');
    expect(byName['etc-link'].kind).toBe('link');
  });

  it('refuses folders outside home, credential folders, links on the way and odd paths', async () => {
    await mkdir(join(f.deviceHome, '.ssh', 'keys'), { recursive: true });
    await mkdir(join(f.base, 'elsewhere'));
    await symlink(join(f.base, 'elsewhere'), join(f.deviceHome, 'via-link'));
    await expect(listDir(device(), f.base)).rejects.toThrow(/inside the home folder/);
    await expect(listDir(device(), join(f.deviceHome, '.ssh', 'keys'))).rejects.toThrow(
      /credentials/,
    );
    await expect(listDir(device(), join(f.deviceHome, 'via-link'))).rejects.toThrow(
      /symbolic link/,
    );
    await expect(listDir(device(), f.deviceHome + '/a/../b')).rejects.toThrow(/Invalid folder/);
    await expect(listDir(device(), 'relative/path')).rejects.toThrow(/Invalid folder/);
  });

  it('judges credential folders in any letter case', async () => {
    await mkdir(join(f.deviceHome, '.SSH', 'keys'), { recursive: true });
    await mkdir(join(f.deviceHome, '.Aasc-Project-Sync'), { recursive: true });
    await mkdir(join(f.deviceHome, 'data'));
    const r = await listDir(device(), f.deviceHome);
    expect(r.entries.map((e) => e.name)).toEqual(['data']);
    await expect(listDir(device(), join(f.deviceHome, '.SSH'))).rejects.toThrow(/credentials/);
    await expect(listDir(device(), join(f.deviceHome, '.SSH', 'keys'))).rejects.toThrow(
      /credentials/,
    );
    expect(validRemoteRoot(join(f.deviceHome, '.AWS', 'x'), f.deviceHome)).toMatch(/credentials/);
    expect(validRemoteRoot(join(f.deviceHome, 'code', 'app'), f.deviceHome)).toBeNull();
  });

  it('never reads nor writes a root inside .git or a credential folder', async () => {
    await mkdir(join(f.deviceHome, 'r', '.Git'), { recursive: true });
    await mkdir(join(f.deviceHome, '.Ssh'), { recursive: true });
    await mkdir(join(f.deviceHome, '.AASC-PROJECT-SYNC', 'x'), { recursive: true });
    const read = (root: string) =>
      readManifest(device(), { root, excludes: [], base: new Map(), inHome: true });
    await expect(read(join(f.deviceHome, 'r', '.Git'))).rejects.toThrow(/\.git/);
    await expect(read(join(f.deviceHome, '.Ssh'))).rejects.toThrow(/credentials/);
    await expect(read(join(f.deviceHome, '.AASC-PROJECT-SYNC', 'x'))).rejects.toThrow(
      /credentials|journal/,
    );
  });

  it('reports a missing folder and stops at 2,000 entries', async () => {
    const gone = await listDir(device(), join(f.deviceHome, 'nope'));
    expect(gone.missing).toBe(true);
    const many = join(f.deviceHome, 'many');
    await mkdir(many);
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(many, `f${i}`), '')));
    const r = await listDir(device(), many);
    expect(r.entries).toHaveLength(2000);
    expect(r.truncated).toBe(true);
  });
});

describe('helper: space', () => {
  it('reads free bytes at a folder, or at its nearest existing parent', async () => {
    const here = await freeSpace(device(), f.deviceHome);
    expect(here).toBeGreaterThan(0);
    const deeper = await freeSpace(device(), join(f.deviceHome, 'not', 'yet'));
    expect(deeper).toBeGreaterThan(0);
  });
});

describe('helper: purge', () => {
  async function journalRun(home: string, linkId: string, runs: string, runId: string, old = true) {
    const dir = join(home, '.aasc-project-sync', linkId, runs, runId);
    await mkdir(join(dir, 'backup'), { recursive: true, mode: 0o700 });
    for (const p of [
      join(home, '.aasc-project-sync'),
      join(home, '.aasc-project-sync', linkId),
      join(home, '.aasc-project-sync', linkId, runs),
    ])
      await import('fs/promises').then((m) => m.chmod(p, 0o700));
    await writeFile(join(dir, 'journal.ndjson'), '');
    if (old) {
      const t = new Date(Date.now() - 2 * 3600_000);
      await utimes(dir, t, t);
    }
    return dir;
  }

  it('removes old runs not kept, keeps the kept and the recent ones', async () => {
    const linkId = randomUUID();
    const kept = randomUUID(),
      oldRun = randomUUID(),
      fresh = randomUUID();
    await journalRun(f.deviceHome, linkId, 'runs', kept);
    await journalRun(f.deviceHome, linkId, 'runs', oldRun);
    await journalRun(f.deviceHome, linkId, 'runs', fresh, false);
    const removed = await purgeRuns(device(), { linkId, keep: [kept] });
    expect(removed).toBe(1);
    const left = await readdir(join(f.deviceHome, '.aasc-project-sync', linkId, 'runs'));
    expect(left.sort()).toEqual([kept, fresh].sort());
  });

  it('purges this computer’s journal apart from the server’s', async () => {
    const linkId = randomUUID(),
      runId = randomUUID();
    await journalRun(f.localHome, linkId, 'runs-local', runId);
    expect(await purgeRuns(local(), { linkId, keep: [], side: 'local' })).toBe(1);
    expect(await purgeRuns(local(), { linkId, keep: [], side: 'local' })).toBe(0);
  });

  it('refuses ids that are not run ids', async () => {
    await expect(purgeRuns(device(), { linkId: '../x', keep: [] })).rejects.toThrow(/Invalid/);
    await expect(
      purgeRuns(device(), { linkId: randomUUID(), keep: ['../../etc'] }),
    ).rejects.toThrow(/Invalid/);
  });
});

describe('service: browse', () => {
  it('lists the server home by default, folders first, with each entry’s full path', async () => {
    await put(join(f.deviceHome, 'b.txt'));
    await mkdir(join(f.deviceHome, 'z-folder'));
    const s = serviceOf(f);
    const r = await s.browse(f.device.id);
    expect(r.path).toBe(f.deviceHome);
    expect(r.parent).toBeNull();
    expect(r.entries.map((e) => e.name)).toEqual(['z-folder', 'b.txt']);
    expect(r.entries[0].path).toBe(join(f.deviceHome, 'z-folder'));
    const inner = await s.browse(f.device.id, join(f.deviceHome, 'z-folder'));
    expect(inner.parent).toBe(f.deviceHome);
  });

  it('checks the pinned host key first and refuses an unknown server', async () => {
    const s = serviceOf(f, { fingerprint: async () => 'SHA256:changed' });
    await expect(s.browse(f.device.id)).rejects.toThrow(/host keys changed/);
    await expect(serviceOf(f).browse(randomUUID())).rejects.toThrow(/Server not found/);
  });
});

describe('service: free space before a run', () => {
  it('refuses a run the server has no room for, and runs when the free space is unknown', async () => {
    await put(join(f.src, 'big.bin'), 'x'.repeat(4096));
    const tight = serviceOf(f, { freeSpace: async () => 1024 });
    const l = await tight.createLink({
      name: 'p',
      projectId: 'proj-1',
      deviceId: f.device.id,
      remoteRoot: f.dst,
      excludes: [],
      credentialsAck: true,
    });
    const r = await compare(tight, l.id);
    await expect(tight.run(r.id, {})).rejects.toMatchObject({ code: 'no-space' });
    expect((await tight.getRun(r.id)).state).toBe('review');
    const unknown = serviceOf(f, { freeSpace: async () => null, store: f.store });
    expect((await runIt(unknown, r.id)).state).toBe('complete');
  });
});

describe('service: journal purge', () => {
  it('drops the undo journals of runs no longer kept', async () => {
    const s = serviceOf(f, { journalMinAgeMs: 0 });
    const l = await s.createLink({
      name: 'p',
      projectId: 'proj-1',
      deviceId: f.device.id,
      remoteRoot: f.dst,
      excludes: [],
      credentialsAck: true,
    });
    for (let i = 0; i < 12; i++) {
      await put(join(f.src, 'a.txt'), `v${i}\n`);
      await sync(s, l.id);
    }
    // The last compare pruned the oldest runs; their journals go in the background.
    await compare(s, l.id);
    const dir = join(f.deviceHome, '.aasc-project-sync', l.id, 'runs');
    const kept = new Set(
      (await s.overview()).runs.filter((r) => r.linkId === l.id).map((r) => r.id),
    );
    expect(kept.size).toBe(10);
    let left: string[] = [];
    for (let i = 0; i < 200; i++) {
      left = await readdir(dir);
      if (left.every((id) => kept.has(id))) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    // Ten runs are kept; the newest is the last compare, which wrote nothing.
    expect(left.filter((id) => !kept.has(id))).toEqual([]);
    expect(left).toHaveLength(9);
  });
});
