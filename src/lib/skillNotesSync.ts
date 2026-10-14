import { cloudNotesApi, NotesApiError } from './cloudNotesApi';
import { notesRepository, type NotesRepository } from './skillNotesOutbox';
import {
  NotesPullResultSchema,
  NotesPushResultSchema,
  type SyncIdentity,
  type NoteMutation,
  type NotesPull,
  type NotesPush,
} from '@/types/skillNotesSync';
export interface NotesApi {
  pull(identity: SyncIdentity, cursor: string | null, signal: AbortSignal): Promise<NotesPull>;
  push(identity: SyncIdentity, ops: NoteMutation[], signal: AbortSignal): Promise<NotesPush>;
}
export const sameIdentity = (a: SyncIdentity | null, b: SyncIdentity | null) =>
  a === b ||
  !!(
    a &&
    b &&
    a.backendOrigin === b.backendOrigin &&
    a.accountId === b.accountId &&
    a.profileId === b.profileId &&
    a.generation === b.generation
  );
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.round(Math.min(60, 2 ** Math.min(attempt, 6)) * 1000 * (0.8 + random() * 0.4));
export function createNotesSync(
  repo: NotesRepository,
  api: NotesApi,
  current: () => SyncIdentity | null,
) {
  return {
    async syncNotesOnce(identity: SyncIdentity, signal: AbortSignal) {
      const check = () => {
        if (signal.aborted || !sameIdentity(identity, current()))
          throw new DOMException('Notes connection changed', 'AbortError');
      };
      check();
      let reset = false;
      async function pull() {
        let more = true;
        while (more) {
          check();
          const before = await repo.read(identity);
          let page: NotesPull;
          try {
            page = NotesPullResultSchema.parse(await api.pull(identity, before.cursor, signal));
          } catch (error) {
            check();
            if (error instanceof NotesApiError && error.code === 'invalid_cursor' && !reset) {
              reset = true;
              await repo.resetHistory(identity, check);
              continue;
            }
            throw error;
          }
          check();
          if (page.hasMore && page.cursor === before.cursor)
            throw new NotesApiError('invalid_response');
          await repo.applyPage(identity, page.records, page.cursor, check);
          more = page.hasMore;
        }
      }
      // Pull first establishes the current cloud view for review; pending operations retain their ORIGINAL bases/dots.
      await pull();
      check();
      let batchSize = 100;
      while (true) {
        const outbox = (await repo.read(identity)).outbox.filter((o) => !o.conflict);
        if (!outbox.length) break;
        const batch = outbox.slice(0, batchSize).map((o) => o.mutation);
        check();
        let result: NotesPush;
        try {
          result = NotesPushResultSchema.parse(await api.push(identity, batch, signal));
        } catch (error) {
          check();
          if (
            error instanceof NotesApiError &&
            error.code === 'batch_too_large' &&
            batch.length > 1
          ) {
            batchSize = Math.max(1, Math.floor(batch.length / 2));
            continue;
          }
          throw error;
        }
        check();
        if (
          result.results.length !== batch.length ||
          result.results.some(
            (r, i) =>
              r.mutationId !== batch[i].mutationId ||
              ('record' in r && r.record.key !== batch[i].key),
          )
        )
          throw new NotesApiError('invalid_response');
        await repo.accept(identity, result.results, check);
      }
      await pull();
      await repo.markSynced(identity, check);
      const latest = await repo.read(identity);
      check();
      return { pending: latest.pending, conflicts: latest.conflicts, cursor: latest.cursor };
    },
  };
}
/** Standalone helper requires callers to supply the active identity guard via a coordinator. */
let activeIdentity: SyncIdentity | null = null;
const defaultSync = createNotesSync(notesRepository, cloudNotesApi, () => activeIdentity);
export function setNotesSyncIdentity(identity: SyncIdentity | null) {
  activeIdentity = identity;
}
export const syncNotesOnce = defaultSync.syncNotesOnce;
