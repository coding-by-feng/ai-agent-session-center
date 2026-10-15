import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { createSkillNotesStore } from './skillNotesStore';
it('IndexedDB failure preserves an accepted optimistic edit and reports durable false', async () => {
  const { repo, store } = await setup();
  vi.spyOn(repo, 'queueNoteEdit').mockRejectedValueOnce(new Error('quota'));
  expect(store.getState().toggleFav('claude:x')).toBeUndefined();
  expect(store.getState().notes['claude:x'].fav).toBe(true);
  await store.getState().flush();
  expect(store.getState().sync.durable).toBe(false);
});
import { DashboardDb } from '@/lib/db';
import { createNotesRepository } from '@/lib/skillNotesOutbox';
import type { SyncIdentity, NoteRecord } from '@/types/skillNotesSync';
import { afterEach } from 'vitest';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0)) await fn();
});
const identity: SyncIdentity = {
  backendOrigin: 'https://cloud.example',
  accountId: '00000000-0000-4000-8000-000000000001',
  profileId: 'profile',
  generation: 1,
};
async function setup() {
  const db = new DashboardDb(crypto.randomUUID()),
    repo = createNotesRepository(db, 'profile');
  const api = {
    pull: vi.fn().mockResolvedValue({ records: [], cursor: 'c', hasMore: false }),
    push: vi.fn().mockResolvedValue({ results: [] }),
  };
  const store = createSkillNotesStore({
    repository: repo,
    api,
    initialNotes: { 'claude:local': { fav: true, tags: [] } },
  });
  cleanup.push(async () => {
    store.getState().stop();
    db.close();
    await db.delete();
  });
  await store.getState().flush();
  return { db, repo, api, store };
}
it('initial connection preserves visible local until explicit use; disconnect edits bound and switch quarantines', async () => {
  const { repo, api, store } = await setup();
  await store.getState().setConnection({ connection: identity, state: 'connected' });
  expect(store.getState().identity).toBeNull();
  expect(store.getState().notes['claude:local'].fav).toBe(true);
  expect(api.pull).not.toHaveBeenCalled();
  const review = await store.getState().previewImport();
  await store.getState().useCloudNotes('separate', review);
  expect(store.getState().notes).toEqual({});
  await store.getState().setConnection({ connection: null, state: 'disconnected' });
  store.getState().toggleFav('claude:offline');
  await store.getState().flush();
  expect((await repo.read(identity)).pending).toBe(1);
  const other = { ...identity, accountId: '00000000-0000-4000-8000-000000000002' };
  await store.getState().setConnection({ connection: other, state: 'connected' });
  expect(store.getState().identity?.accountId).toBe(identity.accountId);
  expect(store.getState().notes['claude:offline'].fav).toBe(true);
  expect(api.push).not.toHaveBeenCalled();
  await store.getState().useLocalNotes();
  expect(store.getState().notes['claude:local'].fav).toBe(true);
});
it('null connection has no sync timer, and auth failures stop retries', async () => {
  const { api, store } = await setup();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await store.getState().setConnection({ connection: null, state: 'disconnected' });
  expect(vi.getTimerCount()).toBe(0);
  await store.getState().setConnection({ connection: identity, state: 'connected' });
  vi.useRealTimers();
  const review = await store.getState().previewImport();
  const { NotesApiError } = await import('@/lib/cloudNotesApi');
  api.pull.mockRejectedValue(new NotesApiError('revoked', 401));
  await store.getState().useCloudNotes('separate', review);
  const calls = api.pull.mock.calls.length;
  store.getState().toggleFav('claude:x');
  await store.getState().flush();
  expect(store.getState().sync.state).toBe('error');
  expect(api.pull).toHaveBeenCalledTimes(calls);
});
it('legacy storage events never replace authoritative notes', async () => {
  const { store } = await setup();
  localStorage.setItem(
    'aasc.skillNotes.v1',
    JSON.stringify({ v: 1, notes: { 'claude:foreign': { fav: true, tags: [] } } }),
  );
  window.dispatchEvent(new StorageEvent('storage', { key: 'aasc.skillNotes.v1' }));
  expect(store.getState().notes['claude:local'].fav).toBe(true);
  expect(store.getState().notes['claude:foreign']).toBeUndefined();
});
it('optimistic intent keeps observed base and dots while persistence is delayed', async () => {
  const { repo, store } = await setup();
  const old: NoteRecord = {
    key: 'claude:x',
    version: 1,
    deleted: false,
    value: { fav: false, tags: ['tag'] },
    tagDots: [{ tag: 'tag', dots: ['00000000-0000-4000-8000-000000000009'] }],
  };
  await repo.applyPage(identity, [old], 'c', () => {});
  await repo.select(identity);
  const other = createSkillNotesStore({ repository: repo, initialNotes: {} });
  cleanup.push(async () => other.getState().stop());
  await other.getState().flush();
  other.getState().removeTag('claude:x', 'tag');
  await repo.applyPage(
    identity,
    [
      {
        ...old,
        version: 2,
        tagDots: [
          { tag: 'tag', dots: [...old.tagDots[0].dots, '00000000-0000-4000-8000-000000000010'] },
        ],
      },
    ],
    'c2',
    () => {},
  );
  await other.getState().flush();
  const op = (await repo.read(identity)).outbox[0].mutation;
  expect(op.baseVersion).toBe(1);
  expect(op.removeTagDots).toEqual(old.tagDots[0].dots);
  store.getState().stop();
});
it('disconnect aborts both an active sync and overlapping import preview', async () => {
  const { api, store } = await setup();
  await store.getState().setConnection({ connection: identity, state: 'connected' });
  await store.getState().useCloudNotes('separate', await store.getState().previewImport());
  const signals: AbortSignal[] = [];
  api.pull.mockImplementation(
    (_identity, _cursor, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      }),
  );
  const sync = store.getState().refresh();
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  const preview = store
    .getState()
    .previewImport()
    .catch(() => null);
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  await store.getState().setConnection({ connection: null, state: 'disconnected' });
  expect(signals.every((s) => s.aborted)).toBe(true);
  await Promise.all([sync, preview]);
});
it('pre-hydration removal cannot acquire later dots and initialization is an editing boundary', async () => {
  const db = new DashboardDb(crypto.randomUUID()),
    repo = createNotesRepository(db, 'profile');
  cleanup.push(async () => {
    db.close();
    await db.delete();
  });
  await repo.migrate({ 'claude:x': { fav: false, tags: ['old'] } });
  const original = (await repo.read(null)).records[0].projected.tagDots[0].dots[0];
  let release!: () => void;
  const migration = repo.migrate.bind(repo);
  vi.spyOn(repo, 'migrate').mockImplementation(async (notes) => {
    await migration(notes);
    await new Promise<void>((r) => (release = r));
  });
  const store = createSkillNotesStore({
    repository: repo,
    initialNotes: { 'claude:x': { fav: false, tags: ['old'] } },
  });
  cleanup.push(async () => store.getState().stop());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  store.getState().removeTag('claude:x', 'old');
  expect(store.getState().notes['claude:x'].tags).toEqual(['old']);
  expect(store.getState().setAbbr('claude:x', 'xx', new Set()).ok).toBe(false);
  expect(store.getState().message).toMatch(/initializ|loading/i);
  const later = crypto.randomUUID();
  await repo.queueNoteEdit(null, {
    key: 'claude:x',
    mutationId: crypto.randomUUID(),
    baseVersion: null,
    addTags: [{ tag: 'old', dot: later }],
  });
  release();
  await store.getState().flush();
  const saved = await repo.read(null);
  expect(saved.outbox.some((o) => o.mutation.removeTagDots)).toBe(false);
  expect(saved.records[0].projected.tagDots[0].dots).toEqual(
    expect.arrayContaining([original, later]),
  );
  expect(store.getState().ready).toBe(true);
  expect(store.getState().sync.durable).toBe(true);
});
it('pre-hydration action cannot redirect persisted bound account edits into local', async () => {
  const db = new DashboardDb(crypto.randomUUID()),
    repo = createNotesRepository(db, 'profile');
  cleanup.push(async () => {
    db.close();
    await db.delete();
  });
  await repo.select(identity);
  await repo.applyPage(
    identity,
    [
      {
        key: 'claude:bound',
        version: 2,
        deleted: false,
        value: { fav: true, tags: [] },
        tagDots: [],
      },
    ],
    'c',
    () => {},
  );
  let release!: () => void;
  const migrate = repo.migrate.bind(repo);
  vi.spyOn(repo, 'migrate').mockImplementation(async (notes) => {
    await migrate(notes);
    await new Promise<void>((r) => (release = r));
  });
  const store = createSkillNotesStore({ repository: repo, initialNotes: {} });
  cleanup.push(async () => store.getState().stop());
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  store.getState().toggleFav('claude:early');
  release();
  await store.getState().flush();
  expect(store.getState().identity).toEqual(identity);
  expect(store.getState().notes).toEqual({ 'claude:bound': { fav: true, tags: [] } });
  expect((await repo.read(null)).outbox).toHaveLength(0);
  expect((await repo.read(identity)).pending).toBe(0);
});
it('authenticated lifecycle cleanup owns event listeners, status responses and remount', async () => {
  const { store, api } = await setup();
  await store.getState().setConnection({ connection: identity, state: 'connected' });
  await store.getState().useCloudNotes('separate', await store.getState().previewImport());
  const { createNotesSyncLifecycle } = await import('./skillNotesStore');
  const status = vi.fn().mockResolvedValue({ connection: identity, state: 'connected' });
  const lifecycle = createNotesSyncLifecycle(store, status);
  const stop = lifecycle.start();
  await vi.waitFor(() => expect(store.getState().sync.state).toBe('idle'));
  stop();
  const calls = status.mock.calls.length,
    pulls = api.pull.mock.calls.length;
  window.dispatchEvent(new Event('online'));
  document.dispatchEvent(new Event('visibilitychange'));
  await lifecycle.refresh();
  await Promise.resolve();
  expect(status).toHaveBeenCalledTimes(calls);
  expect(api.pull).toHaveBeenCalledTimes(pulls);
  expect(store.getState().sync.state).toBe('off');
  let release!: (value: unknown) => void;
  status.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const stopAgain = lifecycle.start();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const signal = status.mock.calls.at(-1)![0] as AbortSignal;
  stopAgain();
  expect(signal.aborted).toBe(true);
  release({ connection: identity, state: 'connected' });
  await Promise.resolve();
  await Promise.resolve();
  expect(api.pull).toHaveBeenCalledTimes(pulls);
  expect(store.getState().sync.state).toBe('off');
  const stopNew = lifecycle.start();
  await vi.waitFor(() => expect(store.getState().sync.state).toBe('idle'));
  expect(api.pull.mock.calls.length).toBeGreaterThan(pulls);
  stopAgain();
  expect(store.getState().sync.state).toBe('idle');
  let eventRelease!: (value: unknown) => void;
  status.mockImplementationOnce(() => new Promise((r) => (eventRelease = r)));
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(eventRelease).toBeTypeOf('function'));
  const eventSignal = status.mock.calls.at(-1)![0] as AbortSignal;
  const eventPulls = api.pull.mock.calls.length;
  stopNew();
  expect(eventSignal.aborted).toBe(true);
  eventRelease({ connection: identity, state: 'connected' });
  await Promise.resolve();
  await Promise.resolve();
  expect(api.pull).toHaveBeenCalledTimes(eventPulls);
  expect(store.getState().sync.state).toBe('off');
});

it('selection generation invalidates local callbacks before cloud selection and on returning local', async () => {
  const { store } = await setup();
  await store.getState().setConnection({ connection: identity, state: 'connected' });
  const review = await store.getState().previewImport();
  const localToken = store.getState().selectionGeneration;
  const selecting = store.getState().useCloudNotes('separate', review);
  expect(store.getState().selectionGeneration).toBeGreaterThan(localToken);
  await selecting;
  expect(store.getState().ready).toBe(true);
  const cloudToken = store.getState().selectionGeneration;
  const returning = store.getState().useLocalNotes();
  expect(store.getState().selectionGeneration).toBeGreaterThan(cloudToken);
  await returning;
  expect(store.getState().identity).toBeNull();
  expect(store.getState().ready).toBe(true);
  expect(store.getState().selectionGeneration).not.toBe(localToken);
});
