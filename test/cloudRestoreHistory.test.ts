import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { backendRoot, backendFixture } from './cloudBackendFixture.js';
import { DashboardDb } from '../src/lib/db.js';
import { createNotesRepository } from '../src/lib/skillNotesOutbox.js';
import { createNotesSync } from '../src/lib/skillNotesSync.js';
import { NotesApiError } from '../src/lib/cloudNotesApi.js';
it.skipIf(!backendRoot).each(['lost-final-pull', 'history-caught-up'])(
  'restore invalidates acknowledged cache (%s), preserving original pending ops and local notes',
  async (scenario) => {
    const f = await backendFixture();
    const db = new DashboardDb(randomUUID()),
      repo = createNotesRepository(db, 'fixture');
    let restored: any;
    try {
      const { createSkillNotesService } = await f.load('src/services/skillNotes/store.ts');
      let notes = createSkillNotesService({ store: f.store }).notes;
      const ctx = {
        ownerId: f.ownerId,
        deviceId: randomUUID(),
        scopes: ['notes:read', 'notes:write'],
      };
      const identity = {
        backendOrigin: f.origin,
        accountId: f.ownerId,
        profileId: 'fixture',
        generation: 1,
      };
      const edit = (key: string, baseVersion: number | null, fav: boolean) => ({
        mutationId: randomUUID(),
        key,
        baseVersion,
        set: { fav },
      });
      await notes.pushNotes(ctx, [edit('claude:existing', null, false)]);
      let pulls = 0,
        loseFinal = false;
      const pushed: string[] = [];
      const api = {
        pull: async (_i: any, cursor: string | null) => {
          if (loseFinal && ++pulls === 2) throw new NotesApiError('offline');
          try {
            return await notes.pullNotes(ctx, cursor, 100);
          } catch (e: any) {
            throw new NotesApiError(e.code, e.status);
          }
        },
        push: async (_i: any, ops: any[]) => {
          pushed.push(...ops.map((o) => o.mutationId));
          return notes.pushNotes(ctx, ops);
        },
      };
      let current = identity;
      const sync = createNotesSync(repo, api, () => current);
      await sync.syncNotesOnce(identity, new AbortController().signal);
      const originalCursor = (await repo.read(identity)).cursor;
      const snapshot = join(f.dir, 'snapshot');
      await f.backup
        .createBackupService({ store: f.store, blobs: f.composition.blobs })
        .backupStore(snapshot);
      await repo.migrate({ 'claude:local': { fav: true, tags: [] } });
      const ghost = edit('claude:ghost', null, true),
        newer = edit('claude:existing', 1, true);
      await repo.queueNoteEdit(identity, ghost);
      await repo.queueNoteEdit(identity, newer);
      loseFinal = scenario === 'lost-final-pull';
      pulls = 0;
      if (loseFinal)
        await expect(sync.syncNotesOnce(identity, new AbortController().signal)).rejects.toThrow();
      else await sync.syncNotesOnce(identity, new AbortController().signal);
      const before = await repo.read(identity);
      expect(before.pending).toBe(0);
      expect(before.notes['claude:ghost'].fav).toBe(true);
      if (loseFinal) expect(before.cursor).toBe(originalCursor);
      // Ordinary same-account credential rotation must not clear acknowledged cache or invent writes.
      current = { ...identity, generation: 2 };
      expect((await repo.read(current)).notes).toEqual(before.notes);
      const pending = edit('claude:pending', 9, true);
      await repo.queueNoteEdit(current, pending);
      const target = join(f.dir, 'restored');
      await f.backup.restoreStore({
        source: snapshot,
        dataDir: target,
        blobs: f.composition.blobs,
      });
      restored = f.openCoreStore({ dataDir: target });
      notes = createSkillNotesService({ store: restored }).notes;
      if (scenario === 'history-caught-up')
        await notes.pushNotes(ctx, [
          edit('claude:unrelated1', null, true),
          edit('claude:unrelated2', null, true),
          edit('claude:unrelated3', null, true),
        ]);
      loseFinal = false;
      pushed.length = 0;
      await sync.syncNotesOnce(current, new AbortController().signal);
      const after = await repo.read(current);
      expect(after.notes['claude:ghost']).toBeUndefined();
      expect(after.records.find((r) => r.key === 'claude:existing')?.acknowledged).toMatchObject({
        version: 1,
        value: { fav: false },
      });
      expect(after.historyReset).toBe(true);
      expect(after.outbox[0].mutation).toEqual(pending);
      expect(after.pending).toBe(1);
      expect(pushed).toEqual([pending.mutationId]);
      expect((await repo.read(null)).notes['claude:local'].fav).toBe(true);
    } finally {
      restored?.close();
      db.close();
      await db.delete();
      await f.close();
    }
  },
);
