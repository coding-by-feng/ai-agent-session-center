import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { DashboardDb } from './db';
import { createNotesRepository, partitionKey } from './skillNotesOutbox';
import type { SyncIdentity, NoteMutation } from '@/types/skillNotesSync';
const databases: DashboardDb[] = [];
const identity: SyncIdentity = {
  backendOrigin: 'https://cloud.example',
  accountId: '00000000-0000-4000-8000-000000000001',
  profileId: 'profile',
  generation: 1,
};
function setup(name = crypto.randomUUID()) {
  const db = new DashboardDb(name);
  databases.push(db);
  return { db, repo: createNotesRepository(db, 'profile') };
}
const edit = (): NoteMutation => ({
  mutationId: crypto.randomUUID(),
  key: 'claude:x',
  baseVersion: null,
  set: { fav: true },
});
afterEach(async () => {
  vi.restoreAllMocks();
  const opened = databases.splice(0);
  for (const db of opened) db.close();
  for (const db of opened) await db.delete();
});
it('offline_edit_survives_reopen', async () => {
  const { db, repo } = setup();
  await repo.queueNoteEdit(identity, edit());
  db.close();
  await db.open();
  expect((await repo.read(identity)).notes['claude:x'].fav).toBe(true);
  expect((await repo.read(identity)).pending).toBe(1);
});
it('snapshot_and_outbox_commit_together', async () => {
  const { db, repo } = setup();
  vi.spyOn(db.skillNoteSyncMeta, 'put').mockRejectedValueOnce(new Error('quota'));
  await expect(repo.queueNoteEdit(identity, edit())).rejects.toThrow();
  expect(await db.skillNoteRecords.count()).toBe(0);
  expect(await db.skillNoteOutbox.count()).toBe(0);
});
it('two_windows_do_not_duplicate_mutation', async () => {
  const { db, repo } = setup();
  const secondDb = new DashboardDb(db.name);
  databases.push(secondDb);
  const second = createNotesRepository(secondDb, 'profile');
  const op = edit();
  await Promise.all([repo.queueNoteEdit(identity, op), second.queueNoteEdit(identity, op)]);
  expect((await repo.read(identity)).pending).toBe(1);
});
it('account_switch_quarantines_pending', async () => {
  const { repo } = setup();
  await repo.queueNoteEdit(identity, edit());
  const other = { ...identity, accountId: '00000000-0000-4000-8000-000000000002' };
  expect((await repo.read(other)).pending).toBe(0);
  expect(await repo.quarantined(other)).toEqual([
    { partition: partitionKey(identity), pending: 1, records: 1 },
  ]);
  expect((await repo.read({ ...identity, generation: 3 })).pending).toBe(1);
});
it('legacy migrates once atomically and remains separate', async () => {
  const { repo } = setup();
  await repo.migrate({ 'claude:legacy': { fav: true, tags: ['review'] } });
  await repo.migrate({ 'claude:new': { fav: true, tags: [] } });
  expect(Object.keys((await repo.read(null)).notes)).toEqual(['claude:legacy']);
  expect((await repo.read(identity)).notes).toEqual({});
});
it('import review is frozen; source changes need another review', async () => {
  const { repo } = setup();
  await repo.migrate({ 'claude:x': { fav: true, tags: [] } });
  const review = await repo.previewImport(identity);
  await repo.edit(null, 'claude:x', { addTag: 'later' });
  await expect(repo.importLocal(identity, review)).rejects.toThrow('Notes changed');
  expect((await repo.read(identity)).pending).toBe(0);
});
it('divergent abbreviations and over-limit unions stay explicit', async () => {
  const { repo } = setup();
  await repo.migrate({
    'claude:x': {
      fav: true,
      tags: Array.from({ length: 12 }, (_, i) => 'local' + i),
      abbr: 'local',
    },
  });
  await repo.applyPage(
    identity,
    [
      {
        key: 'claude:x',
        version: 1,
        deleted: false,
        value: { fav: false, tags: ['cloud'], abbr: 'cloud' },
        tagDots: [{ tag: 'cloud', dots: [crypto.randomUUID()] }],
      },
    ],
    'c',
    () => {},
  );
  const review = await repo.previewImport(identity);
  expect(review.conflicts).toHaveLength(2);
  await expect(repo.importLocal(identity, review)).rejects.toThrow('Resolve import');
  expect((await repo.read(identity)).pending).toBe(0);
});
it('remove uses only observed dots, chunked in groups of 100', async () => {
  const { repo } = setup();
  const dots = Array.from({ length: 201 }, () => crypto.randomUUID());
  await repo.applyPage(
    identity,
    [
      {
        key: 'claude:x',
        version: 1,
        deleted: false,
        value: { fav: false, tags: ['tag'] },
        tagDots: [{ tag: 'tag', dots }],
      },
    ],
    'c',
    () => {},
  );
  await repo.edit(identity, 'claude:x', { removeTag: 'tag' });
  const snapshot = await repo.read(identity);
  expect(snapshot.outbox.map((o) => o.mutation.removeTagDots?.length)).toEqual([100, 100, 1]);
  expect(snapshot.notes).toEqual({});
});
it('old replay cannot overwrite newer pulled record; failed mutation never acknowledged', async () => {
  const { repo } = setup();
  const op = edit();
  await repo.queueNoteEdit(identity, op);
  await repo.applyPage(
    identity,
    [{ key: op.key, version: 3, deleted: false, value: { fav: false, tags: [] }, tagDots: [] }],
    'new',
    () => {},
  );
  await repo.accept(
    identity,
    [
      {
        mutationId: op.mutationId,
        error: {
          code: 'version_conflict',
          message: 'This note changed or was deleted. Review it before retrying.',
        },
      },
    ],
    () => {},
  );
  expect((await repo.read(identity)).conflicts).toBe(1);
  await repo.accept(
    identity,
    [
      {
        mutationId: op.mutationId,
        record: {
          key: op.key,
          version: 1,
          deleted: false,
          value: { fav: true, tags: [] },
          tagDots: [],
        },
      },
    ],
    () => {},
  );
  expect((await repo.read(identity)).pending).toBe(0);
  expect((await repo.read(identity)).notes).toEqual({});
});
it('migration transaction rolls back marker and rows together', async () => {
  const { db, repo } = setup();
  vi.spyOn(db.skillNoteOutbox, 'add').mockRejectedValueOnce(new Error('quota'));
  await expect(repo.migrate({ 'claude:x': { fav: true, tags: [] } })).rejects.toThrow();
  expect(await db.skillNoteSyncMeta.count()).toBe(0);
  await repo.migrate({ 'claude:x': { fav: true, tags: [] } });
  expect((await repo.read(null)).notes['claude:x'].fav).toBe(true);
});
