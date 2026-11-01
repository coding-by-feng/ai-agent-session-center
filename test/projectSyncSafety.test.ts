/**
 * Project Sync engine review fixes (Oct 31 2026): each case is a sequence that once took files
 * out of a working tree on its own, or let a run or undo act on a plan it did not have. Both
 * helpers are real processes; the "server" is a second temporary home.
 */
import { describe, expect, it } from 'vitest';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { localLauncher } from '../server/projectSync/helperClient.js';
import { nextBase } from '../server/projectSync/runner.js';
import type { SyncService } from '../server/projectSync/service.js';
import { legacyDevice, type SyncStore } from '../server/projectSync/store.js';
import { massDeleteAsk } from '../server/projectSync/summary.js';
import type { FileMeta, SyncEntry } from '../src/types/projectSync.js';
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
} from './projectSyncFixture.js';

const f = useSyncFixture();
const service = (overrides: Parameters<typeof serviceOf>[1] = {}) =>
  serviceOf(f, { foldLocal: async () => undefined, ...overrides });
const link = (s: SyncService, extra: Record<string, unknown> = {}) =>
  s.createLink({
    name: 'proj ⇄ mini',
    projectId: 'proj-1',
    deviceId: f.device.id,
    remoteRoot: f.dst,
    excludes: [],
    credentialsAck: true,
    ...extra,
  });
const read = (p: string) => readFile(p, 'utf8');
const gone = async (p: string) =>
  lstat(p).then(
    () => false,
    () => true,
  );
async function entries(s: SyncService, runId: string): Promise<SyncEntry[]> {
  return (await s.entries(runId, { filter: 'all' })).entries;
}
const rows = (list: SyncEntry[]) =>
  list.filter((e) => e.change !== 'same').map((e) => [e.path, e.change, e.action]);
const unreachable = () => async () => {
  throw new Error('ssh: connect to host mini.local port 22: Connection refused');
};
const macFold = async () => (p: string) => p.normalize('NFC').toLowerCase();
const day = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

describe('the base', () => {
  it('a file deleted on both sides and later made again here is copied, never deleted (H1)', async () => {
    await put(join(f.src, 'keep.txt'), 'k\n');
    await put(join(f.src, 'F.txt'), 'same\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(join(f.src, 'F.txt'));
    await rm(join(f.dst, 'F.txt'));
    await sync(s, l.id);
    expect((await f.store.loadBase(l.id)).has('F.txt')).toBe(false);
    await put(join(f.src, 'F.txt'), 'same\n');
    const r = await compare(s, l.id);
    expect(rows(await entries(s, r.id))).toEqual([['F.txt', 'add', 'push']]);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.src, 'F.txt'))).toBe('same\n');
    expect(await read(join(f.dst, 'F.txt'))).toBe('same\n');
  });

  it('a restart after the server folder vanished keeps nothing of the old base (H1)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    await put(join(f.src, 'b.txt'), 'b\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(f.dst, { recursive: true, force: true });
    await rm(join(f.src, 'b.txt'));
    const r = await compare(s, l.id);
    expect(r.warnings[0]).toMatch(/gone on the server/);
    await runIt(s, r.id);
    expect([...(await f.store.loadBase(l.id)).keys()]).toEqual(['a.txt']);
    await put(join(f.src, 'b.txt'), 'b\n');
    const next = await compare(s, l.id);
    expect(rows(await entries(s, next.id))).toEqual([['b.txt', 'add', 'push']]);
  });

  it('is rebuilt from the plan: unfinished paths keep their old row, finished ones take the new', () => {
    const meta = (sha: string): FileMeta => ({
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      mode: 0o644,
      sha256: sha,
    });
    const e = (over: Partial<SyncEntry>): SyncEntry => ({
      id: over.path!,
      groupId: '',
      change: 'change',
      action: 'push',
      flags: [],
      state: 'done',
      path: 'x',
      ...over,
    });
    const base = nextBase([
      e({
        path: 'same',
        change: 'same',
        action: 'skip',
        state: 'pending',
        local: meta('s'),
        device: meta('s'),
      }),
      e({ path: 'pushed', local: meta('p2'), device: meta('p1'), base: meta('p1') }),
      e({
        path: 'pulled',
        change: 'drift',
        action: 'pull',
        local: meta('q1'),
        device: meta('q2'),
        base: meta('q1'),
      }),
      e({
        path: 'failed',
        state: 'failed',
        local: meta('f2'),
        device: meta('f1'),
        base: meta('f1'),
      }),
      e({ path: 'new-failed', change: 'add', state: 'failed', local: meta('n') }),
      e({
        path: 'deleted',
        change: 'delete',
        action: 'delete-device',
        device: meta('d'),
        base: meta('d'),
      }),
      e({
        path: 'both',
        change: 'conflict',
        action: 'keep-both',
        local: meta('b1'),
        device: meta('b2'),
        copyPath: 'both.server-20261031',
      }),
    ]);
    expect(Object.fromEntries([...base].map(([p, m]) => [p, m.sha256]))).toEqual({
      same: 's',
      pushed: 'p2',
      pulled: 'q2',
      failed: 'f1',
      both: 'b1',
      'both.server-20261031': 'b2',
    });
  });
});

describe('undo', () => {
  it('an undo that stops partway forgets the base: the next compare overwrites nothing (H2)', async () => {
    await put(join(f.src, 'doc.txt'), 'v1\n');
    await put(join(f.src, 'other.txt'), 'o1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'doc.txt'), 'v2 local work\n');
    await put(join(f.dst, 'other.txt'), 'o2 server\n');
    const r = await sync(s, l.id);
    expect(r.done).toBe(2);
    // The local journal is no longer private, so the local half of the undo refuses to run.
    await chmod(join(f.localHome, '.aasc-project-sync', l.id, 'runs-local', r.id), 0o755);
    await expect(s.undo(r.id)).rejects.toThrow(/Undo stopped partway/);
    expect(await read(join(f.dst, 'doc.txt'))).toBe('v1\n');
    expect((await s.overview()).links[0].hasBase).toBe(false);
    const next = await compare(s, l.id);
    const doc = (await entries(s, next.id)).find((e) => e.path === 'doc.txt')!;
    expect(doc).toMatchObject({ change: 'different', action: 'review' });
    expect(await read(join(f.src, 'doc.txt'))).toBe('v2 local work\n');
  });

  it('Retry after an undo that stopped partway is refused; Undo again finishes it (H2)', async () => {
    await put(join(f.src, 'doc.txt'), 'v1\n');
    await put(join(f.src, 'other.txt'), 'o1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'doc.txt'), 'v2 local work\n');
    await put(join(f.dst, 'other.txt'), 'o2 server\n');
    await put(join(f.src, 'new.txt'), 'new\n');
    const r = await compare(s, l.id);
    // Something lands at new.txt on the server after compare: its push fails, Retry stays.
    await put(join(f.dst, 'new.txt'), 'someone else\n');
    expect((await runIt(s, r.id)).state).toBe('partial');
    const journal = join(f.localHome, '.aasc-project-sync', l.id, 'runs-local', r.id);
    await chmod(journal, 0o755);
    await expect(s.undo(r.id)).rejects.toThrow(/Undo stopped partway/);
    // A Retry now would rebuild the base from the plan the undo half took back.
    await rm(join(f.dst, 'new.txt'));
    await expect(s.run(r.id)).rejects.toThrow(/Undo began on this run/);
    await chmod(journal, 0o700);
    await s.undo(r.id);
    const undone = await s.getRun(r.id);
    expect(undone.state).toBe('undone');
    expect(undone.stale).toBeUndefined();
    expect(await read(join(f.dst, 'doc.txt'))).toBe('v1\n');
    expect(await read(join(f.src, 'other.txt'))).toBe('o1\n');
    expect(await read(join(f.src, 'doc.txt'))).toBe('v2 local work\n');
  });

  it('a compare that failed can neither run nor be undone, and the base stays (M3, M4)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    const broken = service({ launchDevice: unreachable });
    const r = await compare(broken, l.id);
    expect(r.state).toBe('failed');
    await expect(broken.run(r.id)).rejects.toThrow(/Compare before running/);
    await expect(broken.undo(r.id)).rejects.toThrow(/Nothing from this run/);
    expect((await f.store.loadBase(l.id)).size).toBe(1);
    expect((await broken.overview()).links[0]).toMatchObject({ hasBase: true, state: 'attention' });
  });

  it('undo of a run that never reached either side leaves the base alone (L7)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s, { direction: 'push' });
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'a2\n');
    const r = await compare(s, l.id);
    const failed = await runIt(service({ launchDevice: unreachable }), r.id);
    expect(failed).toMatchObject({ state: 'failed', done: 0 });
    const fresh = service();
    await expect(fresh.undo(r.id)).rejects.toThrow(/Nothing from this run/);
    expect((await f.store.loadBase(l.id)).size).toBe(1);
    expect((await fresh.overview()).links[0].hasBase).toBe(true);
  });

  it('an undo that cannot reach the server changes nothing, so it can run later', async () => {
    await put(join(f.src, 'a.txt'), 'a1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'a2\n');
    const r = await sync(s, l.id);
    expect(r.done).toBe(1);
    const offline = service({ launchDevice: unreachable });
    await expect(offline.undo(r.id)).rejects.toThrow(
      /Could not reach the server: .*Connection refused Nothing was undone\./,
    );
    expect((await offline.getRun(r.id)).stale).toBeUndefined();
    expect((await f.store.loadBase(l.id)).size).toBe(1);
    expect(await service().undo(r.id)).toMatchObject({ restored: 1, skipped: 0 });
    expect(await read(join(f.dst, 'a.txt'))).toBe('a1\n');
  });

  it('a server on this same computer keeps its own journal, and undo puts each side back (L10)', async () => {
    f.device.home = f.localHome;
    const mirror = join(f.localHome, 'mirror');
    await put(join(f.src, 'a.txt'), 'a1\n');
    const s = service({ launchDevice: () => localLauncher({ ...process.env, HOME: f.localHome }) });
    const l = await link(s, { remoteRoot: mirror });
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'a2\n');
    await put(join(mirror, 'b.txt'), 'b1\n');
    const r = await sync(s, l.id);
    expect(r.done).toBe(2);
    const journal = join(f.localHome, '.aasc-project-sync', l.id);
    expect(await readdir(join(journal, 'runs'))).toContain(r.id);
    expect(await readdir(join(journal, 'runs-local'))).toContain(r.id);
    expect(await s.undo(r.id)).toMatchObject({ restored: 2, skipped: 0 });
    expect(await read(join(mirror, 'a.txt'))).toBe('a1\n');
    expect(await gone(join(f.src, 'b.txt'))).toBe(true);
  });
});

describe('folders and names', () => {
  it('a folder the server replaced, while a file was added in it here, waits for a choice and loses nothing (H3)', async () => {
    await put(join(f.src, 'foo/a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(join(f.dst, 'foo'), { recursive: true });
    await put(join(f.dst, 'foo'), 'now a file\n');
    await put(join(f.src, 'foo/new.txt'), 'NEW LOCAL WORK\n');
    const r = await compare(s, l.id);
    const foo = (await entries(s, r.id)).find((e) => e.path === 'foo')!;
    expect(foo).toMatchObject({ change: 'conflict', action: 'review' });
    // Taking the server's file anyway: the folder still holds new.txt, so it stays as it is.
    await s.decide(r.id, { entries: { [foo.id]: 'pull' } });
    expect((await runIt(s, r.id)).state).toBe('partial');
    expect(await read(join(f.src, 'foo/new.txt'))).toBe('NEW LOCAL WORK\n');
    const failed = (await entries(s, r.id)).find((e) => e.path === 'foo')!;
    expect(failed).toMatchObject({ state: 'failed' });
    expect(failed.error).toMatch(/still holds files on this computer/);
  });

  it('keeping this computer’s folder over the server’s file carries the folder and its new file', async () => {
    await put(join(f.src, 'foo/a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(join(f.dst, 'foo'), { recursive: true });
    await put(join(f.dst, 'foo'), 'now a file\n');
    await put(join(f.src, 'foo/new.txt'), 'NEW LOCAL WORK\n');
    const r = await compare(s, l.id);
    const list = await entries(s, r.id);
    const id = (p: string) => list.find((e) => e.path === p)!.id;
    await s.decide(r.id, { entries: { [id('foo')]: 'push', [id('foo/a.txt')]: 'push' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.dst, 'foo/new.txt'))).toBe('NEW LOCAL WORK\n');
    expect(await read(join(f.dst, 'foo/a.txt'))).toBe('a\n');
    expect(await read(join(f.src, 'foo/a.txt'))).toBe('a\n');
  });

  it('a rename on the server that only changes letter case deletes nothing here (M1)', async () => {
    await put(join(f.src, 'README.md'), '# readme\n');
    const s = service({ foldLocal: macFold });
    const l = await link(s);
    await sync(s, l.id);
    await rename(join(f.dst, 'README.md'), join(f.dst, 'tmp.md'));
    await rename(join(f.dst, 'tmp.md'), join(f.dst, 'Readme.md'));
    const r = await compare(s, l.id);
    const list = await entries(s, r.id);
    for (const p of ['README.md', 'Readme.md'])
      expect(list.find((e) => e.path === p)).toMatchObject({ change: 'blocked', action: 'skip' });
    await runIt(s, r.id);
    expect(await readdir(f.src)).toEqual(['README.md']);
    expect(await read(join(f.src, 'README.md'))).toBe('# readme\n');
  });

  it('a rename here that only changes letter case reaches the server without losing the file', async () => {
    await put(join(f.src, 'README.md'), '# readme\n');
    const s = service({ foldLocal: macFold });
    const l = await link(s);
    await sync(s, l.id);
    await rename(join(f.src, 'README.md'), join(f.src, 'tmp.md'));
    await rename(join(f.src, 'tmp.md'), join(f.src, 'Readme.md'));
    expect((await sync(s, l.id)).state).toBe('complete');
    expect(await readdir(f.dst)).toEqual(['Readme.md']);
    expect(await read(join(f.dst, 'Readme.md'))).toBe('# readme\n');
    const next = await compare(s, l.id);
    expect(rows(await entries(s, next.id))).toEqual([]);
  });
});

describe('mass deletes', () => {
  it('a server folder that is there but empty deletes nothing here: the link starts over (H4)', async () => {
    for (let i = 0; i < 12; i++) await put(join(f.src, `src/file${i}.ts`), `${i}\n`);
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(f.dst, { recursive: true, force: true });
    await mkdir(f.dst);
    const r = await compare(s, l.id);
    expect(r.warnings[0]).toMatch(/is empty on the server/);
    expect(rows(await entries(s, r.id)).every(([, change]) => change === 'add')).toBe(true);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect((await readdir(join(f.src, 'src'))).length).toBe(12);
    expect(await read(join(f.dst, 'src/file3.ts'))).toBe('3\n');
  });

  it('a push link whose server folder was deleted starts over too: no question per file', async () => {
    for (let i = 0; i < 12; i++) await put(join(f.src, `src/file${i}.ts`), `${i}\n`);
    const s = service();
    const l = await link(s, { direction: 'push' });
    await sync(s, l.id);
    await rm(f.dst, { recursive: true, force: true });
    const r = await compare(s, l.id);
    expect(r.warnings.join(' ')).toMatch(
      /is gone on the server\. This compare starts the link over/,
    );
    expect(r.pendingDecisions).toBe(0);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.dst, 'src/file3.ts'))).toBe('3\n');
  });

  it('a run that deletes half or more of what was synced asks first (H4)', async () => {
    for (let i = 0; i < 6; i++) await put(join(f.src, `f${i}.txt`), `${i}\n`);
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    for (let i = 0; i < 5; i++) await rm(join(f.dst, `f${i}.txt`));
    const r = await compare(s, l.id);
    expect(r.warnings[0]).toMatch(/5 of 6 synced files are gone on the server/);
    await expect(s.run(r.id)).rejects.toMatchObject({ status: 409, code: 'mass-delete' });
    expect(await read(join(f.src, 'f0.txt'))).toBe('0\n');
    await s.run(r.id, { confirmDeletes: true });
    expect((await settle(s, r.id)).state).toBe('complete');
    expect(await gone(join(f.src, 'f0.txt'))).toBe(true);
    expect(await read(join(f.src, 'f5.txt'))).toBe('5\n');
  });

  it('asks only for deletes still ahead, on either side', () => {
    const e = (
      path: string,
      action: SyncEntry['action'],
      state: SyncEntry['state'] = 'pending',
    ): SyncEntry => ({
      id: path,
      path,
      groupId: '',
      change: 'drift',
      action,
      flags: [],
      state,
      base: { kind: 'file', size: 1, mtimeMs: 1, mode: 0o644 },
    });
    const five = (action: SyncEntry['action'], state?: SyncEntry['state']) =>
      [0, 1, 2, 3, 4].map((i) => e(`${action}-${i}`, action, state));
    expect(massDeleteAsk([...five('delete-local'), ...five('skip')])).toMatch(
      /5 of 10 .* on this computer/,
    );
    expect(massDeleteAsk([...five('delete-device'), ...five('skip')])).toMatch(
      /5 of 10 .* on the server/,
    );
    expect(massDeleteAsk([...five('delete-local', 'done'), ...five('skip')])).toBeNull();
    expect(massDeleteAsk([...five('delete-local').slice(1), ...five('skip')])).toBeNull();
    // Only what was synced before counts: a first run's deletes (a repository taken from the
    // server) never ask "5 of 0".
    const unsynced = five('delete-local').map(({ base: _, ...rest }) => rest);
    expect(massDeleteAsk(unsynced)).toBeNull();
  });
});

describe('a run started again', () => {
  it('after AASC stopped mid-run, the first Retry applies what was in flight (M2)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    await put(join(f.src, 'b.txt'), 'b\n');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    // What the runner had saved when AASC stopped: entries in flight, the run still "running".
    const list = await f.store.loadEntries(r.id);
    await f.store.saveEntries(
      r.id,
      list.map((e) => (e.action === 'push' ? { ...e, state: 'applying' as const } : e)),
    );
    const stored = (await f.store.loadRuns()).find((x) => x.id === r.id)!;
    await f.store.saveRun({ ...stored, state: 'running', startedAt: Date.now() });
    const after = service();
    expect((await after.getRun(r.id)).state).toBe('interrupted');
    expect(await runIt(after, r.id)).toMatchObject({ state: 'complete', failed: 0 });
    expect(await read(join(f.dst, 'a.txt'))).toBe('a\n');
    expect(await read(join(f.dst, 'b.txt'))).toBe('b\n');
  });

  it('a store that fails as a compare or a run starts leaves nothing stuck', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const fail = { saveRun: 0, saveEntries: 0 };
    const full = () => new Error('SQLITE_FULL: database or disk is full');
    const store: SyncStore = {
      ...f.store,
      saveRun: async (r) => {
        if (fail.saveRun > 0 && fail.saveRun--) throw full();
        return f.store.saveRun(r);
      },
      saveEntries: async (id, list) => {
        if (fail.saveEntries > 0 && fail.saveEntries--) throw full();
        return f.store.saveEntries(id, list);
      },
    };
    const s = service({ store });
    const l = await link(s);
    fail.saveRun = 1;
    await expect(s.compare(l.id)).rejects.toThrow(/SQLITE_FULL/);
    const r = await compare(s, l.id);
    expect(r.state).toBe('review');
    fail.saveEntries = 1;
    await expect(s.run(r.id)).rejects.toThrow(/SQLITE_FULL/);
    expect((await s.getRun(r.id)).state).toBe('review');
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.dst, 'a.txt'))).toBe('a\n');
  });

  it('a Retry the store refuses leaves the run and its entries as they were', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const fail = { saveRun: 0 };
    const store: SyncStore = {
      ...f.store,
      saveRun: async (r) => {
        if (fail.saveRun > 0 && fail.saveRun--)
          throw new Error('SQLITE_FULL: database or disk is full');
        return f.store.saveRun(r);
      },
    };
    const s = service({ store });
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'new.txt'), 'new\n');
    const r = await compare(s, l.id);
    // Something lands at new.txt on the server after compare: its push fails.
    await put(join(f.dst, 'new.txt'), 'someone else\n');
    const first = await runIt(s, r.id);
    expect(first.failed).toBe(1);
    const failed = (await entries(s, r.id)).find((e) => e.path === 'new.txt')!;
    expect(failed.state).toBe('failed');
    // Retry claims the entry again, then the store refuses the run: nothing may stay claimed.
    fail.saveRun = 1;
    await expect(s.run(r.id)).rejects.toThrow(/SQLITE_FULL/);
    expect(await s.getRun(r.id)).toMatchObject({ state: first.state, failed: 1 });
    const kept = { state: 'failed', error: failed.error };
    expect((await entries(s, r.id)).find((e) => e.path === 'new.txt')).toMatchObject(kept);
    expect((await f.store.loadEntries(r.id)).find((e) => e.path === 'new.txt')).toMatchObject(kept);
  });

  it('a session working through a link to the project counts as working in it (L9)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    await symlink(f.src, join(f.base, 'proj-link'));
    f.active.push(join(f.base, 'proj-link'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await expect(s.run(r.id)).rejects.toMatchObject({ code: 'live-sessions' });
    expect((await runIt(s, r.id, true)).state).toBe('complete');
  });
});

describe('what the server may bring in', () => {
  it('keep both’s copy of a credential file stays a credential: no hash, no diff (M5)', async () => {
    for (const n of ['.npmrc', 'auth.json']) await put(join(f.src, n), 'token=FAKE-v1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    for (const n of ['.npmrc', 'auth.json']) {
      await put(join(f.src, n), 'token=FAKE-LOCAL\n');
      await put(join(f.dst, n), 'token=FAKE-SERVER\n');
    }
    let r = await compare(s, l.id);
    await s.decide(r.id, { bulk: { change: 'conflict', action: 'keep-both' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    await put(join(f.dst, `.npmrc.server-${day()}`), 'token=FAKE-SERVER-EDITED\n');
    r = await compare(s, l.id);
    const copies = (await entries(s, r.id)).filter((e) => e.path.includes('.server-'));
    expect(copies.map((e) => e.path).sort()).toEqual([
      `.npmrc.server-${day()}`,
      `auth.server-${day()}.json`,
    ]);
    for (const e of copies) {
      expect(e.flags).toContain('credential');
      expect(e.local?.sha256).toBeUndefined();
      expect(e.device?.sha256).toBeUndefined();
      expect((await s.diff(r.id, e.id)).patch).toBeNull();
    }
    expect((await lstat(join(f.src, `auth.server-${day()}.json`))).mode & 0o077).toBe(0);
  });

  it('a link from the server that leads outside the project waits for a choice; an executable is flagged (M6)', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await symlink('/etc/hosts', join(f.dst, 'hosts-link'));
    await put(join(f.dst, 'run.sh'), '#!/bin/sh\necho hi\n');
    await chmod(join(f.dst, 'run.sh'), 0o755);
    const r = await compare(s, l.id);
    const list = await entries(s, r.id);
    const hosts = list.find((e) => e.path === 'hosts-link')!;
    expect(hosts).toMatchObject({ change: 'extra', action: 'review' });
    expect(hosts.flags).toContain('link-outside');
    const run = list.find((e) => e.path === 'run.sh')!;
    expect(run).toMatchObject({ action: 'pull' });
    expect(run.flags).toContain('executable');
    expect(r.warnings.join(' ')).toMatch(/1 executable file comes from the server/);
    await expect(s.run(r.id)).rejects.toThrow(/need a decision/);
  });

  it.skipIf(!hasGit)('git hooks never travel, in either direction (M6)', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'a\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-qm', 'one');
    await put(join(f.src, '.git/hooks/post-checkout'), '#!/bin/sh\necho hi\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    expect(git(f.dst, 'log', '--format=%s')).toBe('one');
    expect(await gone(join(f.dst, '.git/hooks'))).toBe(true);
    await put(join(f.dst, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
    const r = await compare(s, l.id);
    expect((await entries(s, r.id)).filter((e) => e.path.includes('.git/hooks'))).toEqual([]);
  });

  it('a folder a Mac reads as .git never comes from the server, nor its hooks', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service({ foldLocal: macFold });
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.dst, '.GIT/HEAD'), 'ref: refs/heads/main\n');
    await put(join(f.dst, '.GIT/config'), '[core]\n\tbare = false\n');
    await put(join(f.dst, '.GIT/hooks/post-commit'), '#!/bin/sh\necho hi\n');
    const r = await compare(s, l.id);
    const list = (await entries(s, r.id)).filter((e) => /^\.git/i.test(e.path));
    expect(list.map((e) => e.path).sort()).toEqual(['.GIT', '.GIT/HEAD', '.GIT/config']);
    for (const e of list) expect(e).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(r.pendingDecisions).toBe(0);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await gone(join(f.src, '.GIT'))).toBe(true);
  });

  it.skipIf(!hasGit)(
    'no spelling of a hooks folder travels, nor a submodule’s; its config waits for a choice (M6)',
    async () => {
      git(f.src, 'init', '-q');
      await put(join(f.src, 'a.txt'), 'a\n');
      git(f.src, 'add', '.');
      git(f.src, 'commit', '-qm', 'one');
      const s = service({ foldLocal: macFold });
      const l = await link(s);
      await sync(s, l.id);
      await put(join(f.dst, '.git/Hooks/post-checkout'), '#!/bin/sh\necho hi\n');
      await put(join(f.dst, '.git/modules/lib/hooks/post-checkout'), '#!/bin/sh\necho hi\n');
      await put(join(f.dst, '.git/modules/lib/config'), '[core]\n\tbare = false\n');
      const r = await compare(s, l.id);
      const list = await entries(s, r.id);
      expect(list.filter((e) => /hooks/i.test(e.path))).toEqual([]);
      expect(list.find((e) => e.path === '.git/modules/lib/config')!.flags).toContain('git-config');
      expect(r.groups.find((g) => g.id === '.git')).toMatchObject({ decision: 'review' });
      expect(r.warnings.join(' ')).toMatch(/submodule’s or worktree’s/);
    },
  );

  it.skipIf(!hasGit)(
    'a link inside .git from the server that leads outside is never copied here (M6)',
    async () => {
      git(f.src, 'init', '-q');
      await put(join(f.src, 'a.txt'), 'a\n');
      git(f.src, 'add', '.');
      git(f.src, 'commit', '-qm', 'one');
      const s = service();
      const l = await link(s);
      await sync(s, l.id);
      const outside = join(f.base, 'outside.txt');
      await put(outside, 'precious\n');
      await rm(join(f.dst, '.git/COMMIT_EDITMSG'), { force: true });
      await symlink(outside, join(f.dst, '.git/COMMIT_EDITMSG'));
      const r = await compare(s, l.id);
      const e = (await entries(s, r.id)).find((x) => x.path === '.git/COMMIT_EDITMSG')!;
      expect(e).toMatchObject({ change: 'blocked', action: 'skip' });
      expect(e.flags).toContain('link-outside');
      expect((await runIt(s, r.id)).state).toBe('complete');
      expect((await lstat(join(f.src, '.git/COMMIT_EDITMSG'))).isSymbolicLink()).toBe(false);
      // git writes COMMIT_EDITMSG on every commit: here it stays a file of this repository.
      await put(join(f.src, 'b.txt'), 'b\n');
      git(f.src, 'add', '.');
      git(f.src, 'commit', '-qm', 'two');
      expect(await read(outside)).toBe('precious\n');
    },
  );

  it.skipIf(!hasGit)('a .git/config changed on the server waits for a choice (M6)', async () => {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'a\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-qm', 'one');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    git(f.dst, 'config', 'alias.st', 'status');
    const r = await compare(s, l.id);
    expect(r.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'device-ahead',
      decision: 'review',
    });
    expect((await entries(s, r.id)).find((e) => e.path === '.git/config')!.flags).toContain(
      'git-config',
    );
    expect(r.warnings.join(' ')).toMatch(/\.git\/config/);
    await expect(s.run(r.id)).rejects.toThrow(/need a decision/);
    await s.decide(r.id, { groups: { '.git': 'sync' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(git(f.src, 'config', 'alias.st')).toBe('status');
  });
});

describe('saved servers from the retired Transfers tab', () => {
  it('are not imported when they would read as an ssh option (L5)', () => {
    const saved = {
      id: 'legacy-1',
      name: 'old',
      host: 'mini.local',
      username: 'me',
      port: 22,
      fingerprint: 'SHA256:x',
      home: '/home/me',
      platform: 'linux',
      checkedAt: 1,
    };
    expect(legacyDevice(saved)).toMatchObject({ id: 'legacy-1', host: 'mini.local' });
    expect(legacyDevice({ ...saved, host: '-oProxyCommand=evil' })).toBeNull();
    expect(legacyDevice({ ...saved, username: '-l root' })).toBeNull();
  });
});
