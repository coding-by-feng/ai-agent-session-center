// AASC-62: the Cloud → Resources sync list and Sync now, over two fixture devices that share one
// fake backend account. Real job store (sqliteIt), real scanner, real installer.
import { afterEach, expect, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudFixture } from './cloudPackagesFixture.js';
import { sqliteIt } from './helpers/nativeSqlite.js';

type Fixture = Awaited<ReturnType<typeof cloudFixture>>;
const open: Fixture[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.cleanup()));
});
async function device(opts: Parameters<typeof cloudFixture>[0] = {}) {
  const f = await cloudFixture(opts);
  open.push(f);
  return f;
}
/** A second Mac on the same account, with its own home (no skills unless given). */
const secondDevice = (a: Fixture, skills: Record<string, string> = {}) =>
  device({ backend: a.backend, binding: a.binding, skills });
const SKILL = (body: string) => `---\nname: demo\ndescription: test\n---\n${body}`;
const demoFile = (f: Fixture) => join(f.home, '.claude', 'skills', 'demo', 'SKILL.md');

async function saveToCloud(f: Fixture, catalogIds: string[]) {
  const plan = await f.jobs.buildPublicationPlan(
    catalogIds.map((resourceId) => ({ resourceId, include: true })),
    f.binding,
  );
  expect(plan.blocked).toEqual([]);
  const job = await f.jobs.publishPlan(plan.id, f.binding);
  expect((await f.jobs.wait(job.id)).state).toBe('complete');
}
async function edit(f: Fixture, body: string) {
  await writeFile(demoFile(f), SKILL(body));
  await f.rescan();
}
async function syncAndWait(f: Fixture, input: Parameters<Fixture['jobs']['syncNow']>[0] = {}) {
  const result = await f.jobs.syncNow(input, f.binding);
  for (const job of result.jobs) await f.jobs.wait(job.id);
  await f.rescan();
  return { ...result, jobs: await Promise.all(result.jobs.map((j) => f.jobs.wait(j.id))) };
}
const states = async (f: Fixture) =>
  (await f.jobs.syncStatus(f.binding)).items.map((i) => [i.name, i.state]);

sqliteIt('lists only resources saved to cloud, and a saved one reads Synced', async () => {
  const a = await device({ skills: { demo: SKILL('Hello'), other: SKILL('Not saved') } });
  expect((await a.jobs.syncStatus(a.binding)).items).toEqual([]);
  await saveToCloud(a, [a.resource.summary.id]);
  const status = await a.jobs.syncStatus(a.binding);
  expect(status.items).toEqual([
    expect.objectContaining({
      name: 'demo',
      state: 'synced',
      cloudVersion: 1,
      syncedVersion: 1,
      memory: false,
    }),
  ]);
  expect(status.waiting).toBe(0);
});

sqliteIt(
  'a local edit reads Changed on this Mac, and Sync now uploads it as the next version',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    await edit(a, 'Edited on A');
    expect(await states(a)).toEqual([['demo', 'local-changed']]);
    expect((await a.jobs.syncStatus(a.binding)).waiting).toBe(1);
    const result = await syncAndWait(a);
    expect(result.jobs.map((j) => [j.kind, j.state])).toEqual([['publish', 'complete']]);
    expect([...a.versions.values()].map((v) => v.version).sort()).toEqual([1, 2]);
    expect((await a.jobs.syncStatus(a.binding)).items[0]).toMatchObject({
      state: 'synced',
      cloudVersion: 2,
      syncedVersion: 2,
    });
  },
);

sqliteIt(
  'another device sees Only in cloud, then Sync now installs the same bytes there',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    const b = await secondDevice(a);
    expect(await states(b)).toEqual([['demo', 'cloud-only']]);
    const result = await syncAndWait(b);
    expect(result.jobs.map((j) => [j.kind, j.state])).toEqual([['install', 'complete']]);
    expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('Hello'));
    expect(await states(b)).toEqual([['demo', 'synced']]);
  },
);

sqliteIt('a newer cloud version reads Newer in cloud and downloads without asking', async () => {
  const a = await device();
  await saveToCloud(a, [a.resource.summary.id]);
  const b = await secondDevice(a);
  await syncAndWait(b);
  await edit(a, 'Version two');
  await syncAndWait(a);
  expect(await states(b)).toEqual([['demo', 'cloud-newer']]);
  await syncAndWait(b);
  expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('Version two'));
  expect((await b.jobs.syncStatus(b.binding)).items[0]).toMatchObject({
    state: 'synced',
    syncedVersion: 2,
  });
});

sqliteIt(
  "changes on both sides wait for a choice; Use cloud's replaces with a restorable backup",
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    const b = await secondDevice(a);
    await syncAndWait(b);
    await edit(a, 'From A');
    await syncAndWait(a);
    await edit(b, 'From B');
    expect(await states(b)).toEqual([['demo', 'conflict']]);
    const id = (await b.jobs.syncStatus(b.binding)).items[0].resourceId;
    // No choice: nothing is written and the item says why.
    const unchosen = await syncAndWait(b);
    expect(unchosen.jobs).toEqual([]);
    expect(unchosen.skipped).toEqual([
      expect.objectContaining({ resourceId: id, reason: expect.stringMatching(/Keep mine/) }),
    ]);
    expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('From B'));
    const chosen = await syncAndWait(b, { choices: { [id]: 'cloud' } });
    expect(chosen.jobs.map((j) => [j.kind, j.state])).toEqual([['install', 'complete']]);
    expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('From A'));
    const receiptId = chosen.jobs[0].steps[0].receiptId!;
    expect(receiptId).toBeTruthy();
    expect(await states(b)).toEqual([['demo', 'synced']]);
    // The replaced version is backed up and can be put back.
    await b.jobs.restore(receiptId, b.binding);
    expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('From B'));
  },
);

sqliteIt("Keep mine uploads this device's copy over the newer cloud version", async () => {
  const a = await device();
  await saveToCloud(a, [a.resource.summary.id]);
  const b = await secondDevice(a);
  await syncAndWait(b);
  await edit(a, 'From A');
  await syncAndWait(a);
  await edit(b, 'From B');
  const id = (await b.jobs.syncStatus(b.binding)).items[0].resourceId;
  const result = await syncAndWait(b, { choices: { [id]: 'mine' } });
  expect(result.jobs.map((j) => [j.kind, j.state])).toEqual([['publish', 'complete']]);
  expect((await b.jobs.syncStatus(b.binding)).items[0]).toMatchObject({
    state: 'synced',
    cloudVersion: 3,
  });
  // A's version 2 stays in the cloud's history; A now sees B's copy as newer.
  expect([...a.versions.values()].map((v) => v.version).sort()).toEqual([1, 2, 3]);
  expect(await states(a)).toEqual([['demo', 'cloud-newer']]);
});

sqliteIt(
  'an identical copy already on the device counts as synced; a different one asks',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    const same = await secondDevice(a, { demo: SKILL('Hello') });
    expect(await states(same)).toEqual([['demo', 'synced']]);
    const different = await secondDevice(a, { demo: SKILL('Independent copy') });
    expect(await states(different)).toEqual([['demo', 'conflict']]);
    const id = (await different.jobs.syncStatus(different.binding)).items[0].resourceId;
    await syncAndWait(different, { choices: { [id]: 'mine' } });
    expect(await states(different)).toEqual([['demo', 'synced']]);
    expect(await states(a)).toEqual([['demo', 'cloud-newer']]);
  },
);

sqliteIt('memory never syncs without an OK for this run', async () => {
  const a = await device();
  const memories = join(a.home, '.codex', 'memories');
  await mkdir(memories, { recursive: true });
  await writeFile(join(memories, 'notes.md'), 'Remember one thing');
  await a.rescan();
  const memory = [...a.scan.internals.values()].find((r) => r.summary.type === 'memory')!;
  await saveToCloud(a, [memory.summary.id]);
  await writeFile(join(memories, 'notes.md'), 'Remember two things');
  await a.rescan();
  const item = (await a.jobs.syncStatus(a.binding)).items[0];
  expect(item).toMatchObject({ state: 'local-changed', memory: true });
  const without = await syncAndWait(a);
  expect(without.jobs).toEqual([]);
  expect(without.skipped).toEqual([
    expect.objectContaining({ resourceId: item.resourceId, reason: expect.stringMatching(/OK/) }),
  ]);
  const withOk = await syncAndWait(a, { memory: [item.resourceId] });
  expect(withOk.jobs.map((j) => [j.kind, j.state])).toEqual([['publish', 'complete']]);
  expect((await a.jobs.syncStatus(a.binding)).items[0].state).toBe('synced');
});

sqliteIt('a stale browser binding is refused before any outbound call', async () => {
  const a = await device();
  await saveToCloud(a, [a.resource.summary.id]);
  const stale = { ...a.binding };
  a.reconnectSameAccount();
  const before = a.calls.length;
  await expect(a.jobs.syncStatus(stale)).rejects.toMatchObject({ code: 'connection_changed' });
  await expect(a.jobs.syncNow({}, stale)).rejects.toMatchObject({ code: 'connection_changed' });
  expect(a.calls.length).toBe(before);
});

// Security review (Oct 23 2026): an install pulls in its dependencies too. A memory file among
// them moves only with this run's OK, and what this device holds back is never overwritten.
import { syncInstallDecisions } from '../server/cloud/syncStatus.js';
import { it as plainIt } from 'vitest';
plainIt(
  'install decisions skip memory without an OK and anything held, and back up the rest',
  () => {
    const item = (id: string, action: 'add' | 'replace' | 'same' | 'blocked', memory = false) => ({
      id,
      resourceId: id,
      action,
      memory,
    });
    const { decisions, heldBack } = syncInstallDecisions(
      [
        item('skill-new', 'add'),
        item('skill-newer', 'replace'),
        item('memory-dep-new', 'add', true),
        item('memory-dep-old', 'replace', true),
        item('memory-ok', 'replace', true),
        item('changed-here', 'replace'),
        item('blocked', 'blocked'),
      ],
      new Set(['changed-here']),
      new Set(['memory-ok']),
    );
    expect(decisions).toEqual({
      'skill-newer': 'replace-with-backup',
      'memory-dep-new': 'skip',
      'memory-dep-old': 'skip',
      'memory-ok': 'replace-with-backup',
      'changed-here': 'keep-local',
      blocked: 'skip',
    });
    expect(heldBack).toEqual(['memory-dep-new', 'memory-dep-old']);
  },
);

// ---- Oct 23 2026: syncing from Library: catalog ids, Stop syncing, Remove from cloud, one-resource sync ----

const itemOf = async (f: Fixture) => (await f.jobs.syncStatus(f.binding)).items[0];

sqliteIt(
  'each item names the catalog resource it syncs with, so Library rows can show it',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    expect(await itemOf(a)).toMatchObject({ catalogId: a.resource.summary.id, state: 'synced' });
    const b = await secondDevice(a);
    expect(await itemOf(b)).toMatchObject({ catalogId: null, state: 'cloud-only' });
    await syncAndWait(b);
    expect(await itemOf(b)).toMatchObject({ catalogId: b.resource.summary.id, state: 'synced' });
  },
);

sqliteIt(
  'Stop syncing on this Mac: it reads Stopped, never moves or counts as waiting, and Sync again resumes',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    const b = await secondDevice(a);
    await syncAndWait(b);
    const id = (await itemOf(b)).resourceId;
    await b.jobs.syncControl({ resourceId: id, action: 'stop' }, b.binding);
    await edit(a, 'Version two');
    await syncAndWait(a);
    expect(await itemOf(b)).toMatchObject({ state: 'stopped', catalogId: b.resource.summary.id });
    expect((await b.jobs.syncStatus(b.binding)).waiting).toBe(0);
    const stopped = await syncAndWait(b);
    expect(stopped.jobs).toEqual([]);
    expect(stopped.skipped).toEqual([]);
    expect(await readFile(demoFile(b), 'utf8')).toBe(SKILL('Hello'));
    await b.jobs.syncControl({ resourceId: id, action: 'resume' }, b.binding);
    expect(await states(b)).toEqual([['demo', 'cloud-newer']]);
  },
);

sqliteIt(
  'Remove from cloud deletes every version; another Mac then reads Removed and never uploads it again',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    await edit(a, 'Version two');
    await syncAndWait(a);
    const b = await secondDevice(a);
    await syncAndWait(b);
    const id = (await itemOf(a)).resourceId;
    const result = await a.jobs.syncControl({ resourceId: id, action: 'remove' }, a.binding);
    expect(result).toMatchObject({ resourceId: id, action: 'remove', removedVersions: 2 });
    expect([...a.versions.keys()]).toEqual([]);
    // This Mac keeps its files and simply no longer syncs them.
    expect(await states(a)).toEqual([]);
    expect(await readFile(demoFile(a), 'utf8')).toBe(SKILL('Version two'));
    // The other Mac is told, and its Sync now leaves the cloud empty.
    expect(await itemOf(b)).toMatchObject({ state: 'removed', catalogId: b.resource.summary.id });
    expect((await b.jobs.syncStatus(b.binding)).waiting).toBe(0);
    const after = await syncAndWait(b);
    expect(after.jobs).toEqual([]);
    expect([...a.versions.keys()]).toEqual([]);
    // Stop syncing there forgets it too.
    await b.jobs.syncControl({ resourceId: id, action: 'stop' }, b.binding);
    expect(await states(b)).toEqual([]);
  },
);

sqliteIt(
  'Remove from cloud stops at a version another resource or project still uses, keeping it and newer ones',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    await edit(a, 'Version two');
    await syncAndWait(a);
    await edit(a, 'Version three');
    await syncAndWait(a);
    const id = (await itemOf(a)).resourceId;
    a.backend.inUse = new Set([`${id}:2`]);
    await expect(
      a.jobs.syncControl({ resourceId: id, action: 'remove' }, a.binding),
    ).rejects.toMatchObject({
      code: 'version_in_use',
      message: expect.stringMatching(/Version 2 is still used/),
    });
    expect([...a.versions.keys()].sort()).toEqual([`${id}:2`, `${id}:3`]);
    expect(await itemOf(a)).toMatchObject({ state: 'synced', cloudVersion: 3 });
  },
);

sqliteIt('Sync now with `only` moves just the listed resources', async () => {
  const a = await device({ skills: { demo: SKILL('Hello'), other: SKILL('Other') } });
  const other = [...a.scan.internals.values()].find((r) => r.summary.name === 'other')!;
  await saveToCloud(a, [a.resource.summary.id, other.summary.id]);
  await edit(a, 'Demo two');
  await writeFile(join(a.home, '.claude', 'skills', 'other', 'SKILL.md'), SKILL('Other two'));
  await a.rescan();
  expect((await a.jobs.syncStatus(a.binding)).waiting).toBe(2);
  const demoId = (await a.jobs.syncStatus(a.binding)).items.find(
    (i) => i.name === 'demo',
  )!.resourceId;
  await syncAndWait(a, { only: [demoId] });
  expect(Object.fromEntries(await states(a))).toEqual({ demo: 'synced', other: 'local-changed' });
});

// Review of the Oct 23 2026 redesign: dependencies, the write limit, and orphaned jobs.
const USES = (body: string) => SKILL(`${body}\nUse ../helper/SKILL.md`);
const helperFile = (f: Fixture) => join(f.home, '.claude', 'skills', 'helper', 'SKILL.md');
const idOf = async (f: Fixture, name: string) =>
  (await f.jobs.syncStatus(f.binding)).items.find((i) => i.name === name)!.resourceId;

sqliteIt(
  'Remove from cloud waits out the write limit, and a second try skips versions already gone',
  async () => {
    const a = await device();
    await saveToCloud(a, [a.resource.summary.id]);
    for (const body of ['Two', 'Three', 'Four']) {
      await edit(a, body);
      await syncAndWait(a);
    }
    const id = (await itemOf(a)).resourceId;
    // A version still in use stops the first try once v1 and v2 are gone…
    a.backend.inUse = new Set([`${id}:3`]);
    await expect(
      a.jobs.syncControl({ resourceId: id, action: 'remove' }, a.binding),
    ).rejects.toMatchObject({ code: 'version_in_use' });
    expect([...a.versions.keys()].sort()).toEqual([`${id}:3`, `${id}:4`]);
    // …and the second, allowed one write per window, spends its writes on v3 and v4 only.
    a.backend.inUse = new Set();
    a.limitDeletes(1);
    const before = a.calls.length;
    const result = await a.jobs.syncControl({ resourceId: id, action: 'remove' }, a.binding);
    expect(result.removedVersions).toBe(2);
    expect([...a.versions.keys()]).toEqual([]);
    const deletes = a.calls
      .slice(before)
      .filter((c) => c.method === 'DELETE')
      .map((c) => c.path.split('/').pop());
    expect(deletes).toEqual(['3', '4', '4']);
    expect(await states(a)).toEqual([]);
  },
);

sqliteIt(
  'an upload waits while a dependency it would carry is stopped, and nothing reaches the cloud',
  async () => {
    const a = await device({ skills: { demo: USES('Hello'), helper: SKILL('Helper') } });
    await saveToCloud(a, [a.resource.summary.id]);
    await a.jobs.syncControl({ resourceId: await idOf(a, 'helper'), action: 'stop' }, a.binding);
    await writeFile(demoFile(a), USES('Hello again'));
    await a.rescan();
    const before = [...a.versions.keys()].sort();
    const result = await syncAndWait(a);
    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        name: 'demo',
        reason: expect.stringMatching(/needs “helper”, which is stopped on this Mac/),
      }),
    ]);
    expect([...a.versions.keys()].sort()).toEqual(before);
    expect(Object.fromEntries(await states(a))).toEqual({
      demo: 'local-changed',
      helper: 'stopped',
    });
  },
);

sqliteIt(
  'a download never replaces a stopped dependency; what needs its newer version waits',
  async () => {
    const a = await device({ skills: { demo: USES('Hello'), helper: SKILL('Helper') } });
    await saveToCloud(a, [a.resource.summary.id]);
    const b = await secondDevice(a);
    await syncAndWait(b);
    await b.jobs.syncControl({ resourceId: await idOf(b, 'helper'), action: 'stop' }, b.binding);
    await writeFile(helperFile(a), SKILL('Helper two'));
    await writeFile(demoFile(a), USES('Hello two'));
    await a.rescan();
    await syncAndWait(a);
    await syncAndWait(b);
    expect(await readFile(helperFile(b), 'utf8')).toBe(SKILL('Helper'));
    expect(Object.fromEntries(await states(b))).toEqual({ demo: 'cloud-newer', helper: 'stopped' });
  },
);

sqliteIt('with `only`, a dependency changed on this Mac is kept as it is', async () => {
  const a = await device({ skills: { demo: USES('Hello'), helper: SKILL('Helper') } });
  await saveToCloud(a, [a.resource.summary.id]);
  const b = await secondDevice(a);
  await syncAndWait(b);
  await writeFile(helperFile(b), SKILL('Helper edited on B'));
  await b.rescan();
  await writeFile(demoFile(a), USES('Hello two'));
  await a.rescan();
  await syncAndWait(a);
  await syncAndWait(b, { only: [await idOf(b, 'demo')] });
  expect(await readFile(helperFile(b), 'utf8')).toBe(SKILL('Helper edited on B'));
});

sqliteIt('when the download cannot be planned, no upload has started either', async () => {
  const a = await device({ skills: { demo: SKILL('Hello'), other: SKILL('Other') } });
  const other = [...a.scan.internals.values()].find((r) => r.summary.name === 'other')!;
  await saveToCloud(a, [a.resource.summary.id, other.summary.id]);
  const b = await secondDevice(a);
  await syncAndWait(b);
  await writeFile(join(b.home, '.claude', 'skills', 'other', 'SKILL.md'), SKILL('Other two'));
  await b.rescan();
  await syncAndWait(b);
  // On A: demo changed here, other newer in the cloud; reading other's v2 fails mid-plan.
  await edit(a, 'Hello two');
  const otherId = await idOf(a, 'other');
  a.setHook((path) => {
    if (path.endsWith(`/${otherId}/versions/2`)) throw new Error('The cloud went away.');
  });
  // A job queued before the refusal would run unseen: nothing may be queued at all.
  const publish = vi.spyOn(a.jobs, 'publishPlan');
  await expect(a.jobs.syncNow({}, a.binding)).rejects.toThrow();
  a.setHook(() => {});
  expect(publish).not.toHaveBeenCalled();
});
