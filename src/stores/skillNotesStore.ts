/** Immediate UI edits with atomic IndexedDB persistence. No network/timer until explicitly bootstrapped. */
import { create } from 'zustand';
import {
  STORAGE_KEY,
  parseStored,
  validateAbbr,
  withAbbr,
  withCli,
  withFav,
  withTag,
  withoutTag,
  normalizeTag,
  type AbbrCheck,
  type SkillNotes,
} from '@/lib/skillNotes';
import { notesRepository, type NotesRepository, type ImportReview } from '@/lib/skillNotesOutbox';
import { projectNote } from '@/lib/skillNotesProjection';
import { cloudNotesApi, NotesApiError } from '@/lib/cloudNotesApi';
import { createNotesSync, sameIdentity, retryDelay, type NotesApi } from '@/lib/skillNotesSync';
import type {
  NoteMutation,
  NotesSyncState,
  SyncIdentity,
  NotesStatus,
  StoredNoteOperation,
  StoredNoteRecord,
} from '@/types/skillNotesSync';
export function loadSkillNotes(): SkillNotes {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}
interface SkillNotesState {
  notes: SkillNotes;
  /** Editing is blocked until the persisted active partition has loaded. */
  ready: boolean;
  /** Invalidates UI callbacks when selection changes, including leave-and-return. */
  selectionGeneration: number;
  sync: NotesSyncState;
  identity: SyncIdentity | null;
  connection: SyncIdentity | null;
  review: ImportReview | null;
  quarantined: { partition: string; pending: number; records: number }[];
  conflicts: StoredNoteOperation[];
  historyReset: boolean;
  message: string | null;
  toggleFav(key: string): void;
  addTag(key: string, tag: string): void;
  removeTag(key: string, tag: string): void;
  setCli(key: string, cli: boolean): void;
  setAbbr(
    key: string,
    abbr: string,
    realNames: ReadonlySet<string>,
  ): AbbrCheck | { ok: true; value: '' };
  flush(): Promise<void>;
  refresh(): Promise<void>;
  setConnection(status: NotesStatus): Promise<void>;
  previewImport(source?: string): Promise<ImportReview>;
  useCloudNotes(choice: 'separate' | 'import', review: ImportReview): Promise<void>;
  useLocalNotes(): Promise<void>;
  resolveConflict(mutationId: string, replacement?: NoteMutation): Promise<void>;
  stop(): void;
}
export function createSkillNotesStore(
  options: {
    repository?: NotesRepository;
    initialNotes?: SkillNotes;
    api?: NotesApi;
    broadcast?: boolean;
  } = {},
) {
  const repo = options.repository ?? notesRepository,
    api = options.api ?? cloudNotesApi;
  let tail: Promise<void> = Promise.resolve(),
    timer: ReturnType<typeof setTimeout> | undefined,
    running: Promise<void> | null = null,
    rerun = false,
    attempt = 0,
    epoch = 0,
    revision = 0,
    unpersisted = false,
    closed = false,
    autoStopped = false,
    revoked = false;
  let pendingWrites = 0;
  const controllers = new Set<AbortController>();
  let observed = new Map<string, StoredNoteRecord>();
  const channel =
    options.broadcast &&
    typeof window !== 'undefined' &&
    typeof window.BroadcastChannel === 'function'
      ? new BroadcastChannel('aasc.skillNotes.v2')
      : null;
  const store = create<SkillNotesState>((set, get) => {
    const updateSync = (patch: Partial<NotesSyncState>) =>
      set({ sync: { ...get().sync, ...patch } });
    const cancel = () => {
      epoch++;
      for (const c of controllers) c.abort();
      controllers.clear();
      if (timer) clearTimeout(timer);
      timer = undefined;
      rerun = false;
    };
    const connected = () => {
      const s = get();
      return !revoked && s.identity && s.connection && sameIdentity(s.identity, s.connection)
        ? s.identity
        : null;
    };
    const engine = createNotesSync(repo, api, connected);
    const reload = async () => {
      const identity = get().identity,
        rev = revision,
        snapshot = await repo.read(identity);
      if (sameIdentity(identity, get().identity) && rev === revision && pendingWrites === 0) {
        observed = new Map(snapshot.records.map((r) => [r.key, r]));
        set({
          notes: snapshot.notes,
          conflicts: snapshot.outbox.filter((o) => o.conflict),
          historyReset: snapshot.historyReset,
        });
        updateSync({
          pending: snapshot.pending,
          conflicts: snapshot.conflicts,
          lastSyncedAt: snapshot.lastSyncedAt,
          durable: !unpersisted,
        });
      }
      set({ quarantined: await repo.quarantined(get().connection ?? get().identity) });
    };
    const persist = (work: () => Promise<unknown>, notify = true) => {
      tail = tail
        .then(work)
        .then(async () => {
          if (!unpersisted && pendingWrites === 0) await reload();
          if (notify) channel?.postMessage({ committed: true });
        })
        .catch(() => {
          unpersisted = true;
          updateSync({ durable: false, state: 'error' });
          set({
            message:
              'This edit could not be saved on this device. Keep this window open; reload safety is unavailable.',
          });
        });
      return tail;
    };
    const initializingMessage =
      'Notes are initializing. Wait for saved notes to load, then retry the edit.';
    const commit = (
      key: string,
      next: SkillNotes,
      intent: Parameters<NotesRepository['edit']>[2],
    ) => {
      if (!get().ready) {
        set({ message: initializingMessage });
        return;
      }
      if (next === get().notes) return;
      const identity = get().identity;
      revision++;
      pendingWrites++;
      set({ notes: next });
      updateSync({ durable: false });
      const mutationId = crypto.randomUUID(),
        dot = crypto.randomUUID();
      const build = () => {
        const row = observed.get(key),
          baseVersion = row?.acknowledged?.version ?? null;
        const removed = row?.projected.tagDots.find((t) => t.tag === intent.removeTag)?.dots ?? [];
        const parts = intent.removeTag
          ? Array.from({ length: Math.ceil(removed.length / 100) }, (_, i) =>
              removed.slice(i * 100, i * 100 + 100),
            )
          : [undefined];
        const mutations: NoteMutation[] = parts.map((removeTagDots, i) => ({
          mutationId: i === 0 ? mutationId : crypto.randomUUID(),
          key,
          baseVersion,
          ...(intent.set ? { set: intent.set } : {}),
          ...(intent.addTag ? { addTags: [{ tag: intent.addTag, dot }] } : {}),
          ...(removeTagDots ? { removeTagDots } : {}),
        }));
        if (mutations.length)
          observed.set(key, {
            id: row?.id ?? '',
            partition: repo.partition(identity),
            key,
            acknowledged: row?.acknowledged ?? null,
            projected: projectNote(row?.projected ?? null, mutations),
          });
        return mutations;
      };
      const immediate = build();
      void persist(async () => {
        try {
          for (const mutation of immediate) await repo.queueNoteEdit(identity, mutation);
        } finally {
          pendingWrites--;
        }
      }).then(() => {
        if (connected() && !unpersisted && !autoStopped) void get().refresh();
      });
    };
    const schedule = (delay: number) => {
      if (closed || !connected()) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void get().refresh();
      }, delay);
    };
    return {
      notes: options.initialNotes ?? loadSkillNotes(),
      ready: false,
      selectionGeneration: 0,
      identity: null,
      connection: null,
      review: null,
      quarantined: [],
      conflicts: [],
      historyReset: false,
      message: null,
      sync: { state: 'off', pending: 0, conflicts: 0, lastSyncedAt: null, durable: false },
      toggleFav: (key) => {
        const fav = !get().notes[key]?.fav;
        commit(key, withFav(get().notes, key, fav), { set: { fav } });
      },
      addTag: (key, raw) => {
        const tag = normalizeTag(raw);
        if (tag) commit(key, withTag(get().notes, key, raw), { addTag: tag });
      },
      removeTag: (key, tag) => commit(key, withoutTag(get().notes, key, tag), { removeTag: tag }),
      setCli: (key, cli) => commit(key, withCli(get().notes, key, cli), { set: { cli } }),
      setAbbr: (key, abbr, realNames) => {
        if (!get().ready) {
          set({ message: initializingMessage });
          return { ok: false, error: initializingMessage };
        }
        if (!abbr.trim()) {
          commit(key, withAbbr(get().notes, key, null), { set: { abbr: null, cli: false } });
          return { ok: true, value: '' };
        }
        const result = validateAbbr(abbr, key, get().notes, realNames);
        if (result.ok)
          commit(key, withAbbr(get().notes, key, result.value), { set: { abbr: result.value } });
        return result;
      },
      flush: () => tail,
      async refresh() {
        if (running) {
          rerun = true;
          return running;
        }
        const identity = connected();
        if (!identity || closed || unpersisted) return;
        if (timer) clearTimeout(timer);
        timer = undefined;
        const start = epoch;
        const activeController = new AbortController();
        controllers.add(activeController);
        const signal = activeController.signal;
        running = (async () => {
          await tail;
          if (start !== epoch || signal.aborted) return;
          updateSync({ state: 'syncing' });
          try {
            await engine.syncNotesOnce(identity, signal);
            if (start !== epoch) return;
            await reload();
            set({ message: null });
            attempt = 0;
            autoStopped = !!get().sync.conflicts;
            updateSync({ state: get().sync.conflicts ? 'error' : 'idle' });
            if (!get().sync.conflicts) schedule(60_000);
            channel?.postMessage({ committed: true });
          } catch (error) {
            if (start !== epoch || signal.aborted) return;
            const retry =
              error instanceof NotesApiError &&
              ['offline', 'backend_error', 'cancelled', 'rate_limited'].includes(error.code);
            updateSync({ state: retry ? 'offline' : 'error' });
            set({
              message:
                error instanceof NotesApiError
                  ? error.message
                  : 'Notes sync needs attention. Your pending edits remain on this device.',
            });
            autoStopped = !retry;
            if (retry) schedule(retryDelay(attempt++));
          }
        })().finally(() => {
          controllers.delete(activeController);
          running = null;
          if (rerun) {
            rerun = false;
            if (connected() && !autoStopped) void get().refresh();
          }
        });
        return running;
      },
      async setConnection(status) {
        cancel();
        closed = false;
        revoked = status.state === 'revoked';
        autoStopped = revoked;
        const connection = status.connection
          ? { ...status.connection, profileId: repo.profileId }
          : null;
        set({ connection, review: null });
        const transition = epoch;
        await tail;
        if (transition !== epoch) return;
        const active = get().identity;
        // Generation is cancellation state, not a new account partition.
        if (active && connection && repo.partition(active) === repo.partition(connection)) {
          set({ identity: connection, selectionGeneration: get().selectionGeneration + (sameIdentity(active, connection) ? 0 : 1) });
          await repo.select(connection);
        }
        set({ quarantined: await repo.quarantined(connection) });
        if (transition !== epoch) return;
        updateSync({
          state: connection && sameIdentity(connection, get().identity) ? 'idle' : 'off',
        });
        if (status.state === 'revoked') {
          set({ message: 'Reconnect this device to sync notes.' });
          updateSync({ state: 'error' });
          return;
        }
        if (connected()) await get().refresh();
      },
      async previewImport(source) {
        await tail;
        const connection = get().connection;
        if (!connection) throw new Error('Connect before reviewing an import.');
        // Review fetch only: never flush an inactive account's pending operations.
        const c = new AbortController(),
          start = epoch;
        controllers.add(c);
        const check = () => {
          if (c.signal.aborted || start !== epoch || !sameIdentity(connection, get().connection))
            throw new Error('Connection changed.');
        };
        try {
          let more = true,
            reset = false;
          while (more) {
            const before = await repo.read(connection);
            try {
              const page = await api.pull(connection, before.cursor, c.signal);
              check();
              await repo.applyPage(connection, page.records, page.cursor, check);
              more = page.hasMore;
            } catch (error) {
              if (error instanceof NotesApiError && error.code === 'invalid_cursor' && !reset) {
                reset = true;
                await repo.resetHistory(connection, check);
                continue;
              }
              throw error;
            }
          }
          const review = await repo.previewImport(connection, source);
          check();
          set({ review });
          return review;
        } finally {
          controllers.delete(c);
        }
      },
      async useCloudNotes(choice, review) {
        set({ selectionGeneration: get().selectionGeneration + 1 });
        await tail;
        const identity = get().connection;
        if (!identity || !sameIdentity(identity, review.identity))
          throw new Error('Connection changed; review notes again.');
        const start = epoch,
          check = () => {
            if (start !== epoch || !sameIdentity(identity, get().connection))
              throw new Error('Connection changed; review notes again.');
          };
        const fresh = await repo.previewImport(identity, review.source);
        if (fresh.fingerprint !== review.fingerprint)
          throw new Error('Notes changed; review again.');
        if (choice === 'import') await repo.importLocal(identity, review, check);
        else await repo.keepSeparate(identity);
        check();
        cancel();
        revision++;
        await repo.select(identity);
        if (!sameIdentity(identity, get().connection))
          throw new Error('Connection changed; review notes again.');
        set({ identity, ready: false, review: null, message: null });
        await reload();
        set({ ready: true });
        channel?.postMessage({ committed: true });
        await get().refresh();
      },
      async useLocalNotes() {
        set({ selectionGeneration: get().selectionGeneration + 1 });
        cancel();
        await tail;
        revision++;
        await repo.select(null);
        set({ identity: null, ready: false, review: null });
        await reload();
        set({ ready: true });
        updateSync({ state: 'off' });
      },
      async resolveConflict(id, replacement) {
        await tail;
        const identity = get().identity;
        if (!identity) throw new Error('Select an account to resolve sync conflicts.');
        await repo.resolve(identity, id, replacement);
        await reload();
        channel?.postMessage({ committed: true });
        await get().refresh();
      },
      stop() {
        set({ selectionGeneration: get().selectionGeneration + 1 });
        closed = true;
        cancel();
        updateSync({ state: 'off' });
      },
    };
  });
  // No edit is accepted before selection and its exact observed snapshot have loaded.
  const initial = options.initialNotes ?? loadSkillNotes();
  tail = Promise.resolve()
    .then(async () => {
      await repo.migrate(initial);
      const selected = await repo.selection();
      store.setState({ identity: selected, selectionGeneration: store.getState().selectionGeneration + 1 });
      const snapshot = await repo.read(store.getState().identity);
      observed = new Map(snapshot.records.map((r) => [r.key, r]));
      store.setState({
        ready: true,
        message: null,
        notes: snapshot.notes,
        conflicts: snapshot.outbox.filter((o) => o.conflict),
        historyReset: snapshot.historyReset,
        sync: {
          ...store.getState().sync,
          pending: snapshot.pending,
          conflicts: snapshot.conflicts,
          lastSyncedAt: snapshot.lastSyncedAt,
          durable: true,
        },
      });
    })
    .catch(() => {
      unpersisted = true;
      store.setState({
        sync: { ...store.getState().sync, durable: false, state: 'error' },
        message: 'Notes could not be saved on this device. Keep this window open.',
      });
    });
  if (channel)
    channel.onmessage = () => {
      void tail
        .then(async () => {
          if (unpersisted || pendingWrites) return;
          const identity = store.getState().identity,
            snapshot = await repo.read(identity);
          if (sameIdentity(identity, store.getState().identity) && !pendingWrites) {
            observed = new Map(snapshot.records.map((r) => [r.key, r]));
            store.setState({
              notes: snapshot.notes,
              conflicts: snapshot.outbox.filter((o) => o.conflict),
              sync: {
                ...store.getState().sync,
                pending: snapshot.pending,
                conflicts: snapshot.conflicts,
              },
            });
          }
        })
        .catch(() => {});
    };
  return store;
}
export const useSkillNotesStore = createSkillNotesStore({ broadcast: true });
/** A Dashboard mount owns its listeners and every status request. Direct store APIs stay explicit. */
export function createNotesSyncLifecycle(
  store: ReturnType<typeof createSkillNotesStore>,
  status: (signal: AbortSignal) => Promise<NotesStatus> = cloudNotesApi.status,
) {
  type Mount = { controller: AbortController | null; cleanup: () => void };
  let active: Mount | null = null;
  const refresh = async () => {
    const mount = active;
    if (!mount) return;
    mount.controller?.abort();
    const controller = new AbortController();
    mount.controller = controller;
    const next = await status(controller.signal);
    if (active !== mount || controller.signal.aborted) return;
    await store.getState().setConnection(next);
  };
  return {
    refresh,
    start() {
      active?.cleanup();
      const mount: Mount = { controller: null, cleanup: () => {} };
      const onOnline = () => {
        if (store.getState().connection || store.getState().identity)
          void refresh().catch(() => {});
      };
      const onVisible = () => {
        if (document.visibilityState === 'visible') onOnline();
      };
      mount.cleanup = () => {
        if (active !== mount) return;
        active = null;
        mount.controller?.abort();
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', onOnline);
          document.removeEventListener('visibilitychange', onVisible);
        }
        store.getState().stop();
      };
      active = mount;
      if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisible);
      }
      void refresh().catch(() => {});
      return mount.cleanup;
    },
  };
}
const notesLifecycle = createNotesSyncLifecycle(useSkillNotesStore);
export const startNotesSync = notesLifecycle.start;
/** Task12 refreshes its active authenticated lifecycle after connection actions; stopped mounts stay stopped. */
export const refreshNotesConnection = notesLifecycle.refresh;
