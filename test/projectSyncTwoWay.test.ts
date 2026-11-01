/**
 * Project Sync two-way links (P2, Oct 31 2026): changes carry both ways, a path both sides
 * changed is decided (this computer's, the server's, or keep both), undo covers both sides.
 * Both helpers are real processes; the "server" is a second temporary home.
 */
import { describe, expect, it } from 'vitest';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { localLauncher } from '../server/projectSync/helperClient.js';
import type { SyncService } from '../server/projectSync/service.js';
import { measureFold } from '../server/projectSync/servers.js';
import { memoryStore } from '../server/projectSync/store.js';
import type { SyncEntry } from '../src/types/projectSync.js';
import {
  catalogOf,
  compare,
  git,
  hasGit,
  put,
  runIt,
  serviceOf,
  sync,
  useSyncFixture,
} from './projectSyncFixture.js';

const f = useSyncFixture();
// File systems differ in how they fold names; the collision test injects its own fold.
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
const day = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

describe('two-way links', () => {
  it('are the default, and a project syncs with one server', async () => {
    const s = service();
    const l = await link(s);
    expect(l.direction).toBe('two-way');
    await expect(link(s, { remoteRoot: f.dst + '-2' })).rejects.toThrow(/already links/);
  });

  it('need the project inside the home folder (undo copies live there); push links do not', async () => {
    const outside = join(f.base, 'outside');
    await mkdir(outside);
    const s = service({
      catalog: catalogOf(f, [
        { id: 'out', name: 'outside', path: outside, exists: true, evidence: [], counts: {} },
      ]),
    });
    await expect(link(s, { projectId: 'out' })).rejects.toThrow(/inside your home folder/);
    const pushLink = await link(s, { projectId: 'out', direction: 'push' });
    await expect(s.updateLink(pushLink.id, { direction: 'two-way' })).rejects.toThrow(
      /inside your home folder/,
    );
  });

  it('first run copies each side’s files to the other, then reports nothing to do', async () => {
    await put(join(f.src, 'a.txt'), 'here\n');
    await put(join(f.dst, 'b.txt'), 'there\n');
    await put(join(f.dst, 'sub/c.txt'), 'deep\n');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    expect(rows(await entries(s, r.id))).toEqual([
      ['a.txt', 'add', 'push'],
      ['b.txt', 'extra', 'pull'],
      ['sub', 'extra', 'pull'],
      ['sub/c.txt', 'extra', 'pull'],
    ]);
    expect(r.bytes).toMatchObject({ toSend: 5, toGet: 11 });
    const done = await runIt(s, r.id);
    expect(done).toMatchObject({ state: 'complete', failed: 0, bytes: { sent: 5, got: 11 } });
    expect(await read(join(f.dst, 'a.txt'))).toBe('here\n');
    expect(await read(join(f.src, 'b.txt'))).toBe('there\n');
    expect(await read(join(f.src, 'sub/c.txt'))).toBe('deep\n');
    const again = await compare(s, l.id);
    expect(again.total).toBe(0);
    expect(again.pendingDecisions).toBe(0);
  });

  it('carries edits, adds and deletes from whichever side made them', async () => {
    for (const name of ['a', 'b', 'c', 'e']) await put(join(f.src, `${name}.txt`), `${name}1\n`);
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'a2 here\n'); // edited here
    await put(join(f.dst, 'b.txt'), 'b2 there\n'); // edited there
    await rm(join(f.dst, 'c.txt')); // deleted there
    await rm(join(f.src, 'e.txt')); // deleted here
    await put(join(f.src, 'd.txt'), 'new here\n'); // added here
    await put(join(f.dst, 'z.txt'), 'new there\n'); // added there
    const r = await compare(s, l.id);
    expect(rows(await entries(s, r.id))).toEqual([
      ['a.txt', 'change', 'push'],
      ['b.txt', 'drift', 'pull'],
      ['c.txt', 'drift', 'delete-local'],
      ['d.txt', 'add', 'push'],
      ['e.txt', 'delete', 'delete-device'],
      ['z.txt', 'extra', 'pull'],
    ]);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.dst, 'a.txt'))).toBe('a2 here\n');
    expect(await read(join(f.src, 'b.txt'))).toBe('b2 there\n');
    expect(await gone(join(f.src, 'c.txt'))).toBe(true);
    expect(await read(join(f.dst, 'd.txt'))).toBe('new here\n');
    expect(await gone(join(f.dst, 'e.txt'))).toBe(true);
    expect(await read(join(f.src, 'z.txt'))).toBe('new there\n');
    expect((await compare(s, l.id)).total).toBe(0);
  });

  it('a file changed on both sides waits for a decision; keep both keeps each version on both sides', async () => {
    await put(join(f.src, 'notes.md'), 'base\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'notes.md'), 'mine\n');
    await put(join(f.dst, 'notes.md'), 'theirs\n');
    const r = await compare(s, l.id);
    expect(r.pendingDecisions).toBe(1);
    await expect(s.run(r.id)).rejects.toThrow(/need a decision/);
    const [conflict] = (await s.entries(r.id, { filter: 'decisions' })).entries;
    expect(conflict).toMatchObject({ path: 'notes.md', change: 'conflict', action: 'review' });
    const decided = await s.decide(r.id, { entries: { [conflict.id]: 'keep-both' } });
    expect(decided.pendingDecisions).toBe(0);
    const [kept] = (await entries(s, r.id)).filter((e) => e.path === 'notes.md');
    const copy = `notes.server-${day()}.md`;
    expect(kept).toMatchObject({ action: 'keep-both', copyPath: copy });
    expect((await runIt(s, r.id)).state).toBe('complete');
    for (const root of [f.src, f.dst]) {
      expect(await read(join(root, 'notes.md'))).toBe('mine\n');
      expect(await read(join(root, copy))).toBe('theirs\n');
    }
    expect((await compare(s, l.id)).total).toBe(0);
  });

  it('keep both never touches the server when the copy could not be made here', async () => {
    await put(join(f.src, 'notes.md'), 'base\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'notes.md'), 'mine\n');
    await put(join(f.dst, 'notes.md'), 'theirs\n');
    const r = await compare(s, l.id);
    const [conflict] = (await s.entries(r.id, { filter: 'decisions' })).entries;
    await s.decide(r.id, { entries: { [conflict.id]: 'keep-both' } });
    // Something appears at the copy's name after the compare: the copy is refused.
    await put(join(f.src, `notes.server-${day()}.md`), 'in the way\n');
    const done = await runIt(s, r.id);
    expect(done).toMatchObject({ state: 'failed', failed: 1 });
    expect(await read(join(f.dst, 'notes.md'))).toBe('theirs\n');
    expect(await read(join(f.src, 'notes.md'))).toBe('mine\n');
  });

  it('a conflict can take either side instead', async () => {
    await put(join(f.src, 'a.txt'), 'base\n');
    await put(join(f.src, 'b.txt'), 'base\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    for (const p of ['a.txt', 'b.txt']) {
      await put(join(f.src, p), 'mine\n');
      await put(join(f.dst, p), 'theirs\n');
    }
    const r = await compare(s, l.id);
    const list = (await s.entries(r.id, { filter: 'decisions' })).entries;
    const id = (p: string) => list.find((e) => e.path === p)!.id;
    await expect(s.decide(r.id, { entries: { [id('a.txt')]: 'delete-local' } })).rejects.toThrow(
      /not possible/,
    );
    await s.decide(r.id, { entries: { [id('a.txt')]: 'pull', [id('b.txt')]: 'push' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.src, 'a.txt'))).toBe('theirs\n');
    expect(await read(join(f.dst, 'b.txt'))).toBe('mine\n');
  });

  it('undo puts both sides back and forgets the base', async () => {
    await put(join(f.src, 'a.txt'), 'a1\n');
    await put(join(f.src, 'b.txt'), 'b1\n');
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await put(join(f.src, 'a.txt'), 'a2\n');
    await put(join(f.dst, 'b.txt'), 'b2\n');
    const second = await sync(s, l.id);
    expect(second.done).toBe(2);
    const u = await s.undo(second.id);
    expect(u).toMatchObject({ restored: 2, skipped: 0, run: { state: 'undone' } });
    expect(await read(join(f.dst, 'a.txt'))).toBe('a1\n');
    expect(await read(join(f.src, 'b.txt'))).toBe('b1\n');
    expect((await s.overview()).links[0].hasBase).toBe(false);
  });

  it('a server folder that vanished deletes nothing here: the link starts over', async () => {
    for (let i = 0; i < 3; i++) await put(join(f.src, `f${i}.txt`), `${i}\n`);
    const s = service();
    const l = await link(s);
    await sync(s, l.id);
    await rm(f.dst, { recursive: true, force: true });
    const r = await compare(s, l.id);
    expect(rows(await entries(s, r.id)).every(([, change]) => change === 'add')).toBe(true);
    expect(r.warnings[0]).toMatch(/gone on the server/);
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(await read(join(f.src, 'f0.txt'))).toBe('0\n');
    expect(await read(join(f.dst, 'f2.txt'))).toBe('2\n');
  });

  it('a server path that would land on another spelling here is skipped, with a warning', async () => {
    await put(join(f.src, 'x.txt'), 'same\n');
    await put(join(f.dst, 'x.txt'), 'same\n');
    await put(join(f.dst, 'x-alias.txt'), 'other\n');
    const s = service({ foldLocal: async () => (p: string) => p.replace('-alias', '') });
    const l = await link(s);
    const r = await compare(s, l.id);
    const [blocked] = (await entries(s, r.id)).filter((e) => e.path === 'x-alias.txt');
    expect(blocked).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(blocked.flags).toContain('case-collision');
    expect(r.warnings.join(' ')).toMatch(/letter case/);
    await runIt(s, r.id);
    expect(await gone(join(f.src, 'x-alias.txt'))).toBe(true);
  });

  it('switching the direction invalidates a waiting review', async () => {
    await put(join(f.src, 'a.txt'));
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    await s.updateLink(l.id, { direction: 'push' });
    await expect(s.run(r.id)).rejects.toThrow(/direction changed/);
  });
});

describe('servers', () => {
  // No `devices` override: the store holds the servers, as in production.
  const unsaved = () => service({ devices: undefined, store: memoryStore() });

  it('adds a server after reading its home folder over the pinned helper', async () => {
    const s = unsaved();
    const d = await s.addDevice({ name: 'mini', host: 'mini.local', username: 'me', port: 22 });
    expect(d).toMatchObject({
      name: 'mini',
      fingerprint: 'SHA256:pinned',
      home: f.deviceHome,
      platform: process.platform,
    });
    expect((await s.overview()).devices.map((x) => x.id)).toEqual([d.id]);
    await expect(
      s.addDevice({ name: 'again', host: 'mini.local', username: 'me', port: 22 }),
    ).rejects.toThrow(/already added/);
    await s.removeDevice(d.id);
    expect((await s.overview()).devices).toEqual([]);
  });

  it('refuses anything that could read as an ssh option', async () => {
    const s = unsaved();
    for (const bad of [
      { host: '-oProxyCommand=touch /tmp/x' },
      { host: 'a b' },
      { username: '-l' },
      { port: 0 },
    ])
      await expect(
        s.addDevice({ name: 'x', host: 'ok.local', username: 'me', port: 22, ...bad }),
      ).rejects.toMatchObject({ status: 400 });
  });

  it('explains an unreachable server and a missing host key', async () => {
    const noKey = service({
      devices: undefined,
      store: memoryStore(),
      fingerprint: async () => {
        throw new Error('No trusted SSH host key for mini.local. Connect once in a terminal.');
      },
    });
    await expect(
      noKey.addDevice({ name: 'mini', host: 'mini.local', username: 'me', port: 22 }),
    ).rejects.toThrow(/No trusted SSH host key/);
    const down = service({
      devices: undefined,
      store: memoryStore(),
      launchDevice: () => localLauncher({ ...process.env, HOME: join(f.base, 'missing') }),
    });
    await expect(
      down.addDevice({ name: 'mini', host: 'mini.local', username: 'me', port: 22 }),
    ).rejects.toThrow(/Could not reach the server|home folder/);
  });
});

describe('measureFold', () => {
  it('folds names exactly when this file system treats two spellings as one', async () => {
    const dir = join(f.base, 'Probe');
    await mkdir(dir);
    await writeFile(join(dir, 'Case.txt'), '');
    const foldsHere = (await readdir(dir)).length === 1 && !(await gone(join(dir, 'CASE.TXT')));
    const fold = await measureFold(dir);
    expect(!!fold).toBe(foldsHere);
    if (fold) expect(fold('Café/README.md')).toBe(fold('café/readme.md'));
  });
});

describe.skipIf(!hasGit)('two-way git repositories', () => {
  async function repo() {
    git(f.src, 'init', '-q');
    await put(join(f.src, 'a.txt'), 'one\n');
    git(f.src, 'add', '.');
    git(f.src, 'commit', '-q', '-m', 'one');
    const s = service();
    const l = await link(s);
    expect((await sync(s, l.id)).state).toBe('complete');
    return { s, l };
  }

  it('a commit made on the server comes back whole', async () => {
    const { s, l } = await repo();
    await put(join(f.dst, 'a.txt'), 'two\n');
    git(f.dst, 'commit', '-q', '-am', 'two');
    const r = await compare(s, l.id);
    expect(r.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'device-ahead',
      decision: 'sync',
    });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(git(f.src, 'rev-parse', 'HEAD')).toBe(git(f.dst, 'rev-parse', 'HEAD'));
    git(f.src, 'fsck', '--no-progress');
    expect(git(f.src, 'status', '--porcelain')).toBe('');
  });

  it('a repository changed on both sides needs a side; the server’s can win', async () => {
    const { s, l } = await repo();
    git(f.src, 'commit', '-q', '--allow-empty', '-m', 'here');
    git(f.dst, 'commit', '-q', '--allow-empty', '-m', 'there');
    const r = await compare(s, l.id);
    expect(r.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'both-changed',
      decision: 'review',
    });
    await expect(s.decide(r.id, { groups: { '.git': 'sync' } })).rejects.toThrow(/Both copies/);
    await s.decide(r.id, { groups: { '.git': 'take-device' } });
    expect((await runIt(s, r.id)).state).toBe('complete');
    expect(git(f.src, 'log', '-1', '--format=%s')).toBe('there');
    git(f.src, 'fsck', '--no-progress');
  });
});
