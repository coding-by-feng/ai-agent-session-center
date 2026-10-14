import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardDb } from './db';
import { createNotesRepository } from './skillNotesOutbox';
import { createNotesSync } from './skillNotesSync';
import type { SyncIdentity, NoteRecord } from '@/types/skillNotesSync';
const databases: DashboardDb[] = [];
const identity: SyncIdentity = {
  backendOrigin: 'https://cloud.example',
  accountId: '00000000-0000-4000-8000-000000000001',
  profileId: 'profile',
  generation: 1,
};
const record: NoteRecord = {
  key: 'claude:x',
  version: 1,
  deleted: false,
  value: { fav: false, tags: ['cloud'] },
  tagDots: [{ tag: 'cloud', dots: ['00000000-0000-4000-8000-000000000002'] }],
};
function setup() {
  const db = new DashboardDb(crypto.randomUUID());
  databases.push(db);
  const repo = createNotesRepository(db, 'profile');
  const api = {
    pull: vi.fn().mockResolvedValue({ records: [record], cursor: 'cursor', hasMore: false }),
    push: vi.fn(),
  };
  let current: SyncIdentity | null = identity;
  const sync = createNotesSync(repo, api, () => current);
  return { repo, api, sync, setCurrent: (v: SyncIdentity | null) => (current = v) };
}
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
it('first_connect_merges_without_reset', async () => {
  const { repo, sync } = setup();
  await repo.migrate({ 'claude:x': { fav: true, tags: ['local'] } });
  await sync.syncNotesOnce(identity, new AbortController().signal);
  expect((await repo.read(identity)).pending).toBe(0);
  expect((await repo.read(null)).notes['claude:x'].fav).toBe(true);
  const review = await repo.previewImport(identity);
  expect(review).toMatchObject({ localRecords: 1, cloudRecords: 1 });
  await repo.importLocal(identity, review);
  expect((await repo.read(identity)).notes['claude:x']).toEqual({
    fav: true,
    tags: ['cloud', 'local'],
  });
});
it('disconnect_aborts_and_preserves_notes', async () => {
  const { repo, api, sync, setCurrent } = setup();
  await repo.queueNoteEdit(identity, {
    key: 'claude:x',
    mutationId: crypto.randomUUID(),
    baseVersion: null,
    set: { fav: true },
  });
  let release!: (value: unknown) => void;
  api.pull.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const controller = new AbortController();
  const pending = sync.syncNotesOnce(identity, controller.signal);
  await vi.waitFor(() => expect(api.pull).toHaveBeenCalled());
  setCurrent(null);
  controller.abort();
  release({ records: [record], cursor: 'late', hasMore: false });
  await expect(pending).rejects.toThrow();
  expect((await repo.read(identity)).pending).toBe(1);
  expect((await repo.read(identity)).cursor).toBeNull();
});
it('batch_too_large halves unchanged IDs; conflicts stay pending with fixed messages', async () => {
  const { repo, api, sync } = setup();
  const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const id of ids)
    await repo.queueNoteEdit(identity, {
      key: 'claude:x',
      mutationId: id,
      baseVersion: null,
      set: { fav: true },
    });
  const { NotesApiError } = await import('./cloudNotesApi');
  api.push.mockImplementation(async (_identity, ops) => {
    if (ops.length > 1) throw new NotesApiError('batch_too_large', 413);
    return {
      results: [
        {
          mutationId: ops[0].mutationId,
          error: { code: 'version_conflict', message: 'SECRET /private/path' },
        },
      ],
    };
  });
  const result = await sync.syncNotesOnce(identity, new AbortController().signal);
  expect(result).toMatchObject({ pending: 3, conflicts: 3 });
  expect(api.push.mock.calls[0][1].map((o: { mutationId: string }) => o.mutationId)).toEqual(ids);
  expect(api.push.mock.calls.slice(1).map((c) => c[1][0].mutationId)).toEqual(ids);
  expect(JSON.stringify((await repo.read(identity)).outbox)).not.toContain('SECRET');
});
it('invalid_cursor replaces acknowledged ghost projection, preserving local notes and pending original bases', async () => {
  const { repo, api, sync } = setup();
  await repo.applyPage(
    identity,
    [{ ...record, version: 99, key: 'claude:ghost' }],
    'old-history',
    () => {},
  );
  await repo.migrate({ 'claude:local': { fav: true, tags: [] } });
  const id = crypto.randomUUID();
  await repo.queueNoteEdit(identity, {
    key: 'claude:x',
    mutationId: id,
    baseVersion: 98,
    set: { fav: true },
  });
  const { NotesApiError } = await import('./cloudNotesApi');
  api.pull.mockRejectedValueOnce(new NotesApiError('invalid_cursor', 400));
  api.push.mockResolvedValue({
    results: [{ mutationId: id, error: { code: 'version_conflict', message: 'Review' } }],
  });
  await sync.syncNotesOnce(identity, new AbortController().signal);
  const state = await repo.read(identity);
  expect(state.notes['claude:ghost']).toBeUndefined();
  expect(state.records.find((r) => r.key === 'claude:x')?.acknowledged?.version).toBe(1);
  expect(state.outbox[0].mutation.baseVersion).toBe(98);
  expect(state.historyReset).toBe(true);
  expect((await repo.read(null)).notes['claude:local'].fav).toBe(true);
});
it('same account generation invalidates a late result without dropping pending', async () => {
  const { repo, api, sync, setCurrent } = setup();
  let release!: (v: unknown) => void;
  api.pull.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const promise = sync.syncNotesOnce(identity, new AbortController().signal);
  await vi.waitFor(() => expect(api.pull).toHaveBeenCalled());
  setCurrent({ ...identity, generation: 2 });
  release({ records: [record], cursor: 'late', hasMore: false });
  await expect(promise).rejects.toThrow('connection changed');
  expect((await repo.read(identity)).cursor).toBeNull();
});
it('malicious or incomplete successful receipts cannot acknowledge any batch', async () => {
  const { repo, api, sync } = setup();
  const id = crypto.randomUUID();
  await repo.queueNoteEdit(identity, {
    key: 'claude:x',
    mutationId: id,
    baseVersion: null,
    set: { fav: true },
  });
  api.push.mockResolvedValue({ results: [] });
  await expect(sync.syncNotesOnce(identity, new AbortController().signal)).rejects.toThrow();
  expect((await repo.read(identity)).pending).toBe(1);
  api.push.mockResolvedValue({
    results: [{ mutationId: id, error: { code: 'made_up', message: 'secret' } }],
  });
  await expect(sync.syncNotesOnce(identity, new AbortController().signal)).rejects.toThrow();
  expect((await repo.read(identity)).pending).toBe(1);
});
it('backoff is capped with bounded jitter', async () => {
  const { retryDelay } = await import('./skillNotesSync');
  expect(Array.from({ length: 8 }, (_, i) => retryDelay(i, () => 0.5))).toEqual([
    1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
  ]);
  expect(retryDelay(0, () => 0)).toBe(800);
  expect(retryDelay(0, () => 1)).toBe(1200);
});
it('strict conflict schema validates complete normalized union and replaces backend message', async () => {
  const { NoteResultSchema } = await import('@/types/skillNotesSync');
  const id = crypto.randomUUID();
  const tags = Array.from({ length: 13 }, (_, i) => 'tag' + i);
  const parsed = NoteResultSchema.parse({
    mutationId: id,
    error: { code: 'tag_limit_conflict', message: 'SECRET' },
    proposedTags: tags,
  });
  expect(JSON.stringify(parsed)).not.toContain('SECRET');
  for (const proposedTags of [
    tags.slice(0, 12),
    [...tags.slice(0, 12), 'NOT NORMALIZED'],
    [...tags.slice(0, 12), 'tag1'],
  ])
    expect(
      NoteResultSchema.safeParse({
        mutationId: id,
        error: { code: 'tag_limit_conflict', message: 'unsafe' },
        proposedTags,
      }).success,
    ).toBe(false);
});
it('record bound is 16KiB rather than an accidentally smaller dot ceiling',async()=>{const {NoteRecordSchema}=await import('@/types/skillNotesSync');const bounded={key:'claude:x',version:1,deleted:false,value:{fav:false,tags:['x']},tagDots:[{tag:'x',dots:Array.from({length:405},()=>crypto.randomUUID())}]};expect(new TextEncoder().encode(JSON.stringify(bounded)).length).toBeLessThan(16384);expect(NoteRecordSchema.safeParse(bounded).success).toBe(true);});
