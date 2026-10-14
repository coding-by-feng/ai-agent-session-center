import { db as defaultDb, type DashboardDb } from './db';
import {
  NoteMutationSchema,
  type NoteMutation,
  type NoteRecord,
  type NoteResult,
  type StoredNoteMeta,
  type SyncIdentity,
} from '@/types/skillNotesSync';
import { notesProjection, projectNote } from './skillNotesProjection';
import type { SkillNotes } from './skillNotes';

export const partitionKey = (identity: SyncIdentity | null, profileId = 'default') =>
  JSON.stringify(
    identity
      ? [identity.backendOrigin, identity.accountId, identity.profileId]
      : ['local', profileId],
  );
const rowId = (partition: string, key: string) => JSON.stringify([partition, key]);
export interface ImportReview {
  identity: SyncIdentity;
  source: string;
  fingerprint: string;
  localRecords: number;
  cloudRecords: number;
  conflicts: { key: string; reason: string }[];
}
export function createNotesRepository(db: DashboardDb, profileId = 'default') {
  const partition = (identity: SyncIdentity | null) => partitionKey(identity, profileId);
  const tables = [db.skillNoteRecords, db.skillNoteOutbox, db.skillNoteSyncMeta];
  const transaction = <T>(fn: () => Promise<T>) => db.transaction('rw', tables, fn);
  const getMeta = async (p: string): Promise<StoredNoteMeta> =>
    (await db.skillNoteSyncMeta.get(p)) ?? { partition: p, cursor: null, sequence: 0 };
  const operations = async (p: string) =>
    (await db.skillNoteOutbox.where('partition').equals(p).toArray()).sort(
      (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
    );
  async function rebuild(p: string, key: string) {
    const id = rowId(p, key),
      row = await db.skillNoteRecords.get(id);
    const pending = (await operations(p))
      .filter((o) => o.mutation.key === key)
      .map((o) => o.mutation);
    if (!row?.acknowledged && !pending.length) {
      await db.skillNoteRecords.delete(id);
      return;
    }
    const projected = pending.length
      ? projectNote(row?.acknowledged ?? null, pending)
      : row!.acknowledged!;
    await db.skillNoteRecords.put({
      id,
      partition: p,
      key,
      acknowledged: row?.acknowledged ?? null,
      projected,
    });
  }
  async function queue(p: string, mutation: NoteMutation) {
    NoteMutationSchema.parse(mutation);
    const id = rowId(p, mutation.mutationId),
      existing = await db.skillNoteOutbox.get(id);
    if (existing) {
      if (JSON.stringify(existing.mutation) !== JSON.stringify(mutation))
        throw new Error('Mutation identifier already used');
      return;
    }
    const meta = await getMeta(p);
    meta.sequence++;
    await db.skillNoteOutbox.add({ id, partition: p, sequence: meta.sequence, mutation });
    await rebuild(p, mutation.key);
    await db.skillNoteSyncMeta.put(meta);
  }
  async function read(identity: SyncIdentity | null) {
    return db.transaction('r', tables, async () => {
      const p = partition(identity),
        rows = await db.skillNoteRecords.where('partition').equals(p).toArray(),
        outbox = await operations(p),
        meta = await getMeta(p);
      return {
        notes: notesProjection(rows.map((r) => r.projected)),
        records: rows,
        outbox,
        pending: identity ? outbox.length : 0,
        conflicts: outbox.filter((o) => o.conflict).length,
        cursor: meta.cursor,
        lastSyncedAt: meta.lastSyncedAt ?? null,
        historyReset: !!meta.historyReset,
        importDecision: meta.importDecision,
      };
    });
  }
  async function previewImport(
    identity: SyncIdentity,
    source = partition(null),
  ): Promise<ImportReview> {
    return db.transaction('r', tables, async () => {
      const local = await db.skillNoteRecords.where('partition').equals(source).sortBy('key');
      const cloud = await read(identity),
        conflicts: ImportReview['conflicts'] = [];
      for (const row of local.filter((r) => !r.projected.deleted)) {
        const l = row.projected.value,
          c = cloud.notes[row.key];
        if (new Set([...l.tags, ...(c?.tags ?? [])]).size > 12)
          conflicts.push({ key: row.key, reason: 'The merged note exceeds 12 tags.' });
        if (l.abbr && c?.abbr && l.abbr !== c.abbr)
          conflicts.push({ key: row.key, reason: 'Local and cloud abbreviations differ.' });
        if (l.abbr && !c?.abbr) {
          const agent = row.key.split(':')[0];
          for (const [key, n] of Object.entries(cloud.notes))
            if (
              key !== row.key &&
              n.abbr === l.abbr &&
              (agent === 'shared' || key.startsWith('shared:') || key.startsWith(agent + ':'))
            )
              conflicts.push({
                key: row.key,
                reason: 'The abbreviation is already used in this account.',
              });
        }
      }
      return {
        identity: { ...identity },
        source,
        fingerprint: JSON.stringify([
          local.map((r) => [r.key, r.projected]),
          cloud.records.map((r) => [r.key, r.projected]).sort(),
        ]),
        localRecords: local.filter(
          (r) =>
            !r.projected.deleted &&
            (r.projected.value.fav || r.projected.value.tags.length || r.projected.value.abbr),
        ).length,
        cloudRecords: Object.keys(cloud.notes).length,
        conflicts,
      };
    });
  }
  const repo = {
    profileId,
    partition,
    read,
    async selection() {
      return (await db.skillNoteSyncMeta.get('selection:' + profileId))?.selectedIdentity ?? null;
    },
    async select(identity: SyncIdentity | null) {
      await db.skillNoteSyncMeta.put({
        partition: 'selection:' + profileId,
        cursor: null,
        sequence: 0,
        selectedIdentity: identity,
      });
    },
    async migrate(legacy: SkillNotes) {
      await transaction(async () => {
        const p = partition(null),
          meta = await getMeta(p);
        if (meta.migrated) return;
        for (const [key, value] of Object.entries(legacy)) {
          const mutation: NoteMutation = {
            mutationId: crypto.randomUUID(),
            key,
            baseVersion: null,
            set: { fav: value.fav, ...(value.abbr ? { abbr: value.abbr, cli: !!value.cli } : {}) },
            addTags: value.tags.map((tag) => ({ tag, dot: crypto.randomUUID() })),
          };
          if (NoteMutationSchema.safeParse(mutation).success) await queue(p, mutation);
        }
        await db.skillNoteSyncMeta.put({ ...(await getMeta(p)), migrated: true });
      });
    },
    async queueNoteEdit(identity: SyncIdentity | null, mutation: NoteMutation) {
      await transaction(() => queue(partition(identity), mutation));
    },
    /** Convert an immediate UI intent into exact dots/base inside the serialized DB transaction. */
    async edit(
      identity: SyncIdentity | null,
      key: string,
      edit: { set?: NoteMutation['set']; addTag?: string; removeTag?: string },
    ) {
      await transaction(async () => {
        const p = partition(identity),
          row = await db.skillNoteRecords.get(rowId(p, key));
        const removed = row?.projected.tagDots.find((t) => t.tag === edit.removeTag)?.dots ?? [];
        const chunks = edit.removeTag
          ? Array.from({ length: Math.ceil(removed.length / 100) }, (_, i) =>
              removed.slice(i * 100, i * 100 + 100),
            )
          : [undefined];
        for (const removeTagDots of chunks)
          await queue(p, {
            mutationId: crypto.randomUUID(),
            key,
            baseVersion: row?.acknowledged?.version ?? null,
            ...(edit.set ? { set: edit.set } : {}),
            ...(edit.addTag ? { addTags: [{ tag: edit.addTag, dot: crypto.randomUUID() }] } : {}),
            ...(removeTagDots ? { removeTagDots } : {}),
          });
      });
    },
    async applyPage(
      identity: SyncIdentity,
      records: NoteRecord[],
      cursor: string,
      check: () => void,
    ) {
      await transaction(async () => {
        check();
        const p = partition(identity);
        for (const r of records) {
          const id = rowId(p, r.key),
            old = await db.skillNoteRecords.get(id);
          if (!old?.acknowledged || r.version > old.acknowledged.version) {
            await db.skillNoteRecords.put({
              id,
              partition: p,
              key: r.key,
              acknowledged: r,
              projected: r,
            });
            await rebuild(p, r.key);
          }
        }
        await db.skillNoteSyncMeta.put({ ...(await getMeta(p)), cursor });
        check();
      });
    },
    async accept(identity: SyncIdentity, results: NoteResult[], check: () => void) {
      await transaction(async () => {
        check();
        const p = partition(identity);
        for (const result of results) {
          const id = rowId(p, result.mutationId),
            operation = await db.skillNoteOutbox.get(id);
          if (!operation) continue;
          if ('error' in result) {
            await db.skillNoteOutbox.put({ ...operation, conflict: result });
            continue;
          }
          if (result.record.key !== operation.mutation.key) throw new Error('Invalid receipt key');
          const rid = rowId(p, result.record.key),
            old = await db.skillNoteRecords.get(rid);
          if (!old?.acknowledged || result.record.version > old.acknowledged.version)
            await db.skillNoteRecords.put({
              id: rid,
              partition: p,
              key: result.record.key,
              acknowledged: result.record,
              projected: result.record,
            });
          await db.skillNoteOutbox.delete(id);
          await rebuild(p, result.record.key);
        }
        check();
      });
    },
    async resetHistory(identity: SyncIdentity, check: () => void) {
      await transaction(async () => {
        check();
        const p = partition(identity),
          rows = await db.skillNoteRecords.where('partition').equals(p).toArray();
        for (const r of rows) {
          await db.skillNoteRecords.put({ ...r, acknowledged: null });
          await rebuild(p, r.key);
        }
        await db.skillNoteSyncMeta.put({ ...(await getMeta(p)), cursor: null, historyReset: true });
        check();
      });
    },
    async markSynced(identity: SyncIdentity, check: () => void) {
      await transaction(async () => {
        check();
        const p = partition(identity);
        await db.skillNoteSyncMeta.put({
          ...(await getMeta(p)),
          lastSyncedAt: new Date().toISOString(),
        });
        check();
      });
    },
    async quarantined(identity: SyncIdentity | null) {
      const current = partition(identity),
        rows = await db.skillNoteRecords.toArray(),
        ops = await db.skillNoteOutbox.toArray();
      const ps = [...new Set(ops.map((o) => o.partition))].filter(
        (p) => p !== current && p !== partition(null),
      );
      return ps.map((p) => ({
        partition: p,
        pending: ops.filter((o) => o.partition === p).length,
        records: rows.filter((r) => r.partition === p).length,
      }));
    },
    previewImport,
    async keepSeparate(identity: SyncIdentity) {
      await transaction(async () => {
        const p = partition(identity);
        await db.skillNoteSyncMeta.put({ ...(await getMeta(p)), importDecision: 'separate' });
      });
    },
    async importLocal(identity: SyncIdentity, review: ImportReview, check: () => void = () => {}) {
      await transaction(async () => {
        check();
        if (JSON.stringify(identity) !== JSON.stringify(review.identity))
          throw new Error('Connection changed; review import again.');
        const fresh = await previewImport(identity, review.source);
        if (fresh.fingerprint !== review.fingerprint)
          throw new Error('Notes changed; review import again.');
        if (fresh.conflicts.length) throw new Error('Resolve import conflicts before importing.');
        const p = partition(identity),
          meta = await getMeta(p);
        if (meta.importedFingerprint === review.fingerprint) return;
        const rows = await db.skillNoteRecords.where('partition').equals(review.source).toArray();
        for (const row of rows) {
          if (row.projected.deleted) continue;
          const local = row.projected.value,
            old = await db.skillNoteRecords.get(rowId(p, row.key)),
            value = old?.projected.value;
          // Import does not opt a device into filesystem writes, nor transplant CLI intent onto another abbreviation.
          const set: NonNullable<NoteMutation['set']> = {};
          if (local.fav && !value?.fav) set.fav = true;
          if (local.abbr && !value?.abbr) {
            set.abbr = local.abbr;
            set.cli = false;
          }
          const addTags = local.tags
            .filter((t) => !value?.tags.includes(t))
            .map((tag) => ({ tag, dot: crypto.randomUUID() }));
          if (Object.keys(set).length || addTags.length)
            await queue(p, {
              mutationId: crypto.randomUUID(),
              key: row.key,
              baseVersion: old?.acknowledged?.version ?? null,
              set,
              addTags,
            });
        }
        await db.skillNoteSyncMeta.put({
          ...(await getMeta(p)),
          importDecision: 'import',
          importedFingerprint: review.fingerprint,
        });
        check();
      });
    },
    /** Explicit user resolution: discard, or replace using a NEW mutation identifier. Never rebase automatically. */
    async resolve(identity: SyncIdentity, id: string, replacement?: NoteMutation) {
      await transaction(async () => {
        const p = partition(identity),
          key = rowId(p, id),
          old = await db.skillNoteOutbox.get(key);
        if (!old) return;
        if (replacement && replacement.mutationId === id)
          throw new Error('A resolution needs a new identifier.');
        await db.skillNoteOutbox.delete(key);
        if (replacement) await queue(p, replacement);
        await rebuild(p, old.mutation.key);
      });
    },
  };
  return repo;
}
export type NotesRepository = ReturnType<typeof createNotesRepository>;
export const notesRepository = createNotesRepository(defaultDb);
export const queueNoteEdit = notesRepository.queueNoteEdit;
