/**
 * Project Sync "when both changed" policy (Nov 13 2026): a two-way link may let this computer's
 * version win a conflict instead of asking. Only conflicts against a base are settled; a first
 * compare, a repository and a guarded entry still ask. Both helpers are real in the service tests.
 */
import { describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { classify, type ManifestEntry } from '../server/projectSync/classify.js';
import { applyDecisions } from '../server/projectSync/decisions.js';
import type { SyncService } from '../server/projectSync/service.js';
import type { FileMeta, SyncEntry } from '../src/types/projectSync.js';
import { compare, put, runIt, serviceOf, sync, useSyncFixture } from './projectSyncFixture.js';

const file = (sha: string): ManifestEntry => ({
  kind: 'file',
  size: sha.length,
  mtimeMs: 1000,
  mode: 0o644,
  sha256: sha.padEnd(64, '0'),
});
const dir = (): ManifestEntry => ({ kind: 'dir', size: 0, mtimeMs: 1000, mode: 0o755 });
const m = (o: Record<string, ManifestEntry>) => new Map(Object.entries(o));
const base = (o: Record<string, ManifestEntry>) => new Map<string, FileMeta>(Object.entries(o));
const byPath = (entries: SyncEntry[]) => Object.fromEntries(entries.map((e) => [e.path, e]));
const twoWay = (conflictPolicy?: 'ask' | 'local') => ({
  localPlatform: 'darwin',
  devicePlatform: 'linux',
  direction: 'two-way' as const,
  ...(conflictPolicy ? { conflictPolicy } : {}),
});

describe('classify — this computer wins conflicts', () => {
  const B = base({
    'both.txt': file('b0'),
    'gone-here.txt': file('g0'),
    'gone-there.txt': file('t0'),
  });
  const local = m({ 'both.txt': file('b1'), 'gone-there.txt': file('t1') });
  const device = m({ 'both.txt': file('b2'), 'gone-here.txt': file('g2') });

  it('asks by default', () => {
    const plan = classify(local, device, B, twoWay());
    const e = byPath(plan.entries);
    expect(e['both.txt']).toMatchObject({ change: 'conflict', action: 'review' });
    expect(plan.settled ?? 0).toBe(0);
  });

  it('pushes this computer’s version, or deletes the server’s when this computer deleted it', () => {
    const plan = classify(local, device, B, twoWay('local'));
    const e = byPath(plan.entries);
    expect(e['both.txt']).toMatchObject({ change: 'conflict', action: 'push' });
    // Deleted here, edited there: the delete wins (the server's copy goes to its trash).
    expect(e['gone-here.txt']).toMatchObject({ change: 'conflict', action: 'delete-device' });
    // Deleted there, edited here: this computer's file goes back.
    expect(e['gone-there.txt']).toMatchObject({ change: 'conflict', action: 'push' });
    expect(e['both.txt'].reason).toMatch(/this computer/i);
    expect(plan.settled).toBe(3);
  });

  it('still asks on a first compare: there is no base to tell who changed what', () => {
    const plan = classify(
      m({ 'x.txt': file('x1') }),
      m({ 'x.txt': file('x2') }),
      new Map(),
      twoWay('local'),
    );
    expect(byPath(plan.entries)['x.txt']).toMatchObject({ change: 'different', action: 'review' });
    expect(plan.settled ?? 0).toBe(0);
  });

  it('still asks for a repository changed on both sides', () => {
    const repoBase = base({ 'r/.git': dir(), 'r/.git/HEAD': file('h0') });
    const plan = classify(
      m({ 'r/.git': dir(), 'r/.git/HEAD': file('h1') }),
      m({ 'r/.git': dir(), 'r/.git/HEAD': file('h2') }),
      repoBase,
      twoWay('local'),
    );
    expect(byPath(plan.entries)['r/.git/HEAD'].action).toBe('review');
    expect(plan.groups.find((g) => g.isRepo)?.decision).toBe('review');
    expect(plan.settled ?? 0).toBe(0);
  });

  it('still asks for a folder one side replaced while the other changed inside it', () => {
    const B2 = base({ d: dir(), 'd/a.txt': file('a0') });
    const plan = classify(
      m({ d: dir(), 'd/a.txt': file('a1') }), // changed inside here
      m({ d: file('f') }), // the server replaced the folder with a file
      B2,
      twoWay('local'),
    );
    const e = byPath(plan.entries);
    expect(e.d).toMatchObject({ change: 'conflict', action: 'review' });
    // What is inside waits for the folder's decision too.
    expect(e['d/a.txt']).toMatchObject({ change: 'conflict', action: 'review' });
  });

  it('still asks for a delete here inside a folder the server added files to', () => {
    const plan = classify(
      m({}),
      m({ d: dir(), 'd/a.txt': file('a2'), 'd/new.txt': file('n') }),
      base({ d: dir(), 'd/a.txt': file('a0') }),
      twoWay('local'),
    );
    expect(byPath(plan.entries)['d/a.txt']).toMatchObject({ change: 'conflict', action: 'review' });
    expect(plan.settled ?? 0).toBe(0);
  });

  it('drops the "this computer wins" note once you pick another action', () => {
    const plan = classify(local, device, B, twoWay('local'));
    const both = byPath(plan.entries)['both.txt'];
    applyDecisions(plan, { entries: { [both.id]: 'pull' } }, 'two-way', (p) => p + '.copy');
    expect(both.action).toBe('pull');
    expect(both.reason).toBeUndefined();
  });

  it('leaves push links alone', () => {
    const plan = classify(local, device, B, { ...twoWay('local'), direction: 'push' });
    expect(plan.settled ?? 0).toBe(0);
    expect(plan.entries.some((e) => e.reason?.match(/this computer/i))).toBe(false);
  });
});

describe('two-way links with "This computer wins"', () => {
  const f = useSyncFixture();
  const service = () => serviceOf(f, { foldLocal: async () => undefined });
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

  it('a new link asks by default', async () => {
    const l = await link(service());
    expect(l.conflictPolicy ?? 'ask').toBe('ask');
  });

  it('settles a conflict without a decision, says so, and undo gives the server its version back', async () => {
    await put(join(f.src, 'notes.md'), 'one\n');
    const s = service();
    const l = await link(s, { conflictPolicy: 'local' });
    expect(l.conflictPolicy).toBe('local');
    await sync(s, l.id);
    await writeFile(join(f.src, 'notes.md'), 'here\n');
    await writeFile(join(f.dst, 'notes.md'), 'there\n');
    const r = await compare(s, l.id);
    expect(r.state).toBe('review');
    expect(r.pendingDecisions).toBe(0);
    expect(r.warnings.join('\n')).toMatch(/1 file changed on both sides.*this computer/i);
    const done = await runIt(s, r.id);
    expect(done.state).toBe('complete');
    expect(await readFile(join(f.dst, 'notes.md'), 'utf8')).toBe('here\n');
    await s.undo(r.id);
    expect(await readFile(join(f.dst, 'notes.md'), 'utf8')).toBe('there\n');
  });

  it('a delete here beats an edit there', async () => {
    await put(join(f.src, 'old.md'), 'one\n');
    const s = service();
    const l = await link(s, { conflictPolicy: 'local' });
    await sync(s, l.id);
    await rm(join(f.src, 'old.md'));
    await writeFile(join(f.dst, 'old.md'), 'edited there\n');
    const r = await compare(s, l.id);
    expect(r.pendingDecisions).toBe(0);
    expect((await runIt(s, r.id)).state).toBe('complete');
    await expect(readFile(join(f.dst, 'old.md'), 'utf8')).rejects.toThrow();
  });

  it('changing the policy invalidates a waiting review', async () => {
    await put(join(f.src, 'a.txt'), 'a\n');
    const s = service();
    const l = await link(s);
    const r = await compare(s, l.id);
    expect(r.state).toBe('review');
    const updated = await s.updateLink(l.id, { conflictPolicy: 'local' });
    expect(updated.conflictPolicy).toBe('local');
    const after = await s.getRun(r.id);
    expect(after.state).toBe('failed');
    expect(after.stale).toMatch(/both changed|conflict/i);
    // The same value again changes nothing.
    const again = await compare(s, l.id);
    await s.updateLink(l.id, { conflictPolicy: 'local' });
    expect((await s.getRun(again.id)).stale).toBeUndefined();
  });
});
