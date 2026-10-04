/**
 * The shared queue with MORE THAN ONE WRITER — two windows of one device (the docked
 * queue and a float), or two devices.
 *
 * queueStore.test.ts drives one store and hands it the other side's messages by hand.
 * That cannot show the failure that matters here, which lives BETWEEN two stores:
 * each pushes its whole list a moment after an edit, the server keeps the last one,
 * and a window that applies the other's list wholesale throws its own edits away.
 * So these tests load the store module twice (`vi.resetModules()`), the way two
 * windows are two JS contexts, and wire both to one fake server that records every
 * PUT and broadcasts it to every window — the sender included — like the real one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { QueueItem } from './queueStore';

type QueueModule = typeof import('./queueStore');

interface Win {
  store: QueueModule['useQueueStore'];
  /** This window's origin id, the one its pushes are stamped with. */
  origin: string;
}

interface Put {
  sessionId: string;
  items: QueueItem[];
  automation: unknown;
  originClientId: string;
  keepalive: boolean;
}

const mk = (id: number, sessionId = 's1', over: Partial<QueueItem> = {}): QueueItem => ({
  id,
  sessionId,
  text: `Prompt #${id}`,
  position: id - 1,
  createdAt: 1,
  ...over,
});

const idsOf = (items: readonly QueueItem[] | undefined) => (items ?? []).map((i) => i.id);
const queueOf = (w: Win, sessionId = 's1') => idsOf(w.store.getState().queues.get(sessionId));

/** A fresh JS context's worth of the store: its own module state, its own window id. */
async function openWindow(): Promise<Win> {
  vi.resetModules();
  const mod = await import('./queueStore');
  const identity = await import('@/lib/deviceIdentity');
  return { store: mod.useQueueStore, origin: identity.getWindowOriginId() };
}

/** A window whose IndexedDB holds `rows` (Dexie has no IndexedDB under jsdom). */
async function openWindowWithDb(rows: Array<Record<string, unknown>>): Promise<Win> {
  vi.resetModules();
  vi.doMock('@/lib/db', () => ({
    db: {
      queueAutomation: {
        toArray: async () => [],
        put: async () => undefined,
        delete: async () => undefined,
      },
      promptQueue: {
        toArray: async () => rows,
        where: () => ({ equals: () => ({ primaryKeys: async () => [] }) }),
        bulkDelete: async () => undefined,
        bulkAdd: async () => undefined,
      },
      transaction: async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn(),
    },
  }));
  const mod = await import('./queueStore');
  const identity = await import('@/lib/deviceIdentity');
  return { store: mod.useQueueStore, origin: identity.getWindowOriginId() };
}

/**
 * The server: keeps the last PUT per session, answers `GET /api/queues`, and
 * broadcasts every PUT to every window — including the sender, which must ignore it.
 */
function startServer(windows: () => Win[]) {
  const records = new Map<string, Put>();
  const puts: Put[] = [];
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const match = /^\/api\/sessions\/([^/]+)\/queue$/.exec(url);
    if (match && init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as {
        items: QueueItem[];
        automation: unknown;
        originClientId: string;
      };
      const put: Put = {
        sessionId: decodeURIComponent(match[1]),
        items: body.items,
        automation: body.automation ?? null,
        originClientId: body.originClientId,
        keepalive: init.keepalive === true,
      };
      puts.push(put);
      records.set(put.sessionId, put);
      for (const w of windows()) {
        w.store.getState().applyRemoteQueue(
          put.sessionId,
          clone(put.items),
          clone(put.automation) as never,
          put.originClientId,
        );
      }
      return new Response('{"ok":true}', { status: 200 });
    }
    if (url === '/api/queues') {
      const queues = [...records.values()].map((p) => ({
        sessionId: p.sessionId,
        items: p.items,
        automation: p.automation,
        updatedAt: 0,
      }));
      return new Response(JSON.stringify({ queues }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });

  return {
    fetchMock,
    puts,
    /** Put a record on the server without a window having pushed it. */
    preload(sessionId: string, items: QueueItem[]) {
      records.set(sessionId, { sessionId, items, automation: null, originClientId: '', keepalive: false });
    },
    final: (sessionId: string) => idsOf(records.get(sessionId)?.items),
    putsFor: (sessionId: string) => puts.filter((p) => p.sessionId === sessionId),
    /** Only the pushes this window sent. */
    putsBy: (win: Win, sessionId: string) =>
      puts.filter((p) => p.sessionId === sessionId && p.originClientId === win.origin),
  };
}

/** Give `win` a synced copy of `items` — as if it had just pulled them from the server. */
function sync(win: Win, items: QueueItem[], sessionId = 's1'): void {
  win.store.getState().applyRemoteQueue(sessionId, items.map((it, i) => ({ ...it, position: i })), null, null);
}

/** Let any zero-delay timers a store scheduled for itself run. */
const settle = () => vi.advanceTimersByTimeAsync(1);

function begin() {
  vi.useFakeTimers();
}

afterEach(async () => {
  // Every store module this file loads keeps its pagehide listener for the life of the file, so a
  // push a test left waiting would be flushed by a LATER test's pagehide. Let them all go first.
  await vi.advanceTimersByTimeAsync(5000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/db');
});

describe('two windows of one device', () => {
  it("applies the sibling window's real push, and drops its own echo", async () => {
    begin();
    const a = await openWindow();
    const b = await openWindow();
    const server = startServer(() => [a, b]);
    vi.stubGlobal('fetch', server.fetchMock);

    a.store.getState().add('s1', mk(1));
    await vi.advanceTimersByTimeAsync(500);

    expect(server.puts).toHaveLength(1);
    expect(server.puts[0].originClientId).toBe(a.origin);
    // Same device, different window: the stamps must differ or one window would
    // discard the other's updates as "my own echo".
    expect(a.origin).not.toBe(b.origin);
    expect(queueOf(b)).toEqual([1]); // the sibling applied it
    expect(queueOf(a)).toEqual([1]); // its own echo changed nothing

    // And nothing bounced back: B applied A's list but did not push it again.
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.puts).toHaveLength(1);
  });

  it('with nothing pending, an incoming list replaces this one — and is not pushed back', async () => {
    begin();
    const m = await openWindow();
    const f = await openWindow();
    const server = startServer(() => [m, f]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(m, [mk(1), mk(2)]);
    sync(f, [mk(1), mk(2)]);
    await settle();

    f.store.getState().add('s1', mk(3));
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(m)).toEqual([1, 2, 3]);
    expect(server.puts).toHaveLength(1);
  });

  it('does not bring back an item this window sent and removed when the other window’s push lands first', async () => {
    // The reviewer's timeline. F adds Z; about 100 ms later M's scheduler finishes sending X
    // and removes it. F's push (built before it knew) reaches the server first.
    begin();
    const m = await openWindow(); // the window whose scheduler sends
    const f = await openWindow(); // the float
    const server = startServer(() => [m, f]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(m, [mk(1), mk(2)]);
    sync(f, [mk(1), mk(2)]);
    await settle();

    f.store.getState().add('s1', mk(3)); // t=0 — F's push is due at 400
    await vi.advanceTimersByTimeAsync(100);
    m.store.getState().remove('s1', 1); // t=100 — M's push is due at 500
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(m)).toEqual([2, 3]); // X stays gone — it would be sent twice
    expect(queueOf(f)).toEqual([2, 3]); // F kept its own add and learned of the removal
    expect(server.final('s1')).toEqual([2, 3]); // and the server agrees with both
  });

  it('keeps a pending add when the other window’s push removed an item', async () => {
    // The mirror image: M's add must not be lost to F's removal arriving first.
    begin();
    const m = await openWindow();
    const f = await openWindow();
    const server = startServer(() => [m, f]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(m, [mk(1), mk(2)]);
    sync(f, [mk(1), mk(2)]);
    await settle();

    f.store.getState().remove('s1', 1); // t=0 — F's push is due at 400
    await vi.advanceTimersByTimeAsync(100);
    m.store.getState().add('s1', mk(3)); // t=100 — M's push is due at 500
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(m)).toEqual([2, 3]);
    expect(queueOf(f)).toEqual([2, 3]);
    expect(server.final('s1')).toEqual([2, 3]);
  });

  it('lets a remote deletion beat a pending edit of the same item', async () => {
    begin();
    const m = await openWindow();
    const f = await openWindow();
    const server = startServer(() => [m, f]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(m, [mk(1), mk(2)]);
    sync(f, [mk(1), mk(2)]);
    await settle();

    f.store.getState().remove('s1', 2); // F sent #2 and removed it
    await vi.advanceTimersByTimeAsync(100);
    m.store.getState().updateItem('s1', 2, { text: 'edited in M' }); // too late: it is gone
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(m)).toEqual([1]);
    expect(queueOf(f)).toEqual([1]);
    expect(server.final('s1')).toEqual([1]);
  });

  it('keeps this window’s edit to an item the other window did not touch', async () => {
    begin();
    const m = await openWindow();
    const f = await openWindow();
    const server = startServer(() => [m, f]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(m, [mk(1), mk(2)]);
    sync(f, [mk(1), mk(2)]);
    await settle();

    f.store.getState().add('s1', mk(3));
    await vi.advanceTimersByTimeAsync(100);
    m.store.getState().updateItem('s1', 2, { text: 'edited in M' });
    await vi.advanceTimersByTimeAsync(2000);

    const textIn = (w: Win) => w.store.getState().queues.get('s1')?.find((i) => i.id === 2)?.text;
    expect(queueOf(m)).toEqual([1, 2, 3]);
    expect(textIn(m)).toBe('edited in M');
    expect(textIn(f)).toBe('edited in M'); // it reached the other window too
  });
});

describe('what the merge starts from (the last list known to match the server)', () => {
  it('is the list a pull from the server returned', async () => {
    begin();
    const w = await openWindowWithDb([]);
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    server.preload('s1', [mk(1), mk(2)]);

    await w.store.getState().syncFromServer();
    w.store.getState().remove('s1', 1); // M's scheduler consumed #1
    // The float's push, built before it saw that, arrives while M's own is pending.
    w.store.getState().applyRemoteQueue('s1', [mk(1), mk(2, 's1', { position: 1 }), mk(3, 's1', { position: 2 })], null, 'other-window');
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(w)).toEqual([2, 3]);
    expect(server.final('s1')).toEqual([2, 3]);
  });

  it('is the list this window loaded from IndexedDB, so the boot sync does not double every item', async () => {
    // IndexedDB hands out its own auto-increment ids; the server's copy carries the ids the
    // window that pushed it was using. Without a base, the loaded items look like this window's
    // own additions and the same prompts appear twice, each once under each id.
    begin();
    const w = await openWindowWithDb([
      { id: 11, sessionId: 's1', text: 'Prompt #1', position: 0, createdAt: 1 },
      { id: 12, sessionId: 's1', text: 'Prompt #2', position: 1, createdAt: 1 },
    ]);
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    server.preload('s1', [mk(101, 's1', { position: 0 }), mk(102, 's1', { position: 1 })]);

    await w.store.getState().loadFromDb();
    await settle(); // loadFromDb's own zero-delay "this write came from IndexedDB" flag
    expect(queueOf(w)).toEqual([11, 12]);
    w.store.getState().add('s1', mk(99, 's1', { position: 2 })); // an edit made before the sync lands
    await w.store.getState().syncFromServer();
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(w)).toEqual([101, 102, 99]);
    expect(server.final('s1')).toEqual([101, 102, 99]);
  });

  it('follows the session across a re-key', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(w, [mk(1, 'old'), mk(2, 'old')], 'old');
    await settle();

    w.store.getState().migrateSession('old', 'new');
    w.store.getState().remove('new', 1);
    w.store.getState().applyRemoteQueue('new', [mk(1, 'new'), mk(2, 'new', { position: 1 }), mk(3, 'new', { position: 2 })], null, 'other-window');
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(w, 'new')).toEqual([2, 3]);
  });

  it('moves up to what this window pushed once the server has accepted it', async () => {
    // #2 was added and pushed (so the server holds it), then consumed here. The other
    // window's list, built while #2 still existed, must not bring it back: the removal is
    // measured against the pushed list, not against the older synced one that never had #2.
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    sync(w, [mk(1)]);
    await settle();

    w.store.getState().add('s1', mk(2));
    await vi.advanceTimersByTimeAsync(500); // pushed [1,2] and confirmed
    w.store.getState().remove('s1', 2); // consumed #2 afterwards
    // Another window's push, built from [1,2], arrives while this removal is pending.
    w.store.getState().applyRemoteQueue('s1', [mk(1), mk(2, 's1', { position: 1 }), mk(3, 's1', { position: 2 })], null, 'other-window');
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(w)).toEqual([1, 3]);
  });
});

describe('a push that finishes late', () => {
  it('does not overwrite what a newer list from the server established', async () => {
    // M's push is still on the wire when the other window's list arrives and is applied.
    // When M's response finally comes back it says nothing about what the server holds NOW,
    // so it must not rewind the merge base to the list M sent.
    begin();
    const w = await openWindow();
    let release!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return init?.method === 'PUT' ? held : new Response('{}', { status: 200 });
    }));
    sync(w, [mk(1)]);
    await settle();

    w.store.getState().updateItem('s1', 1, { text: 'edited here' });
    await vi.advanceTimersByTimeAsync(500); // the push is out, unanswered
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);

    // The other window's list lands now: #2 exists, and this window replaces its list with it.
    w.store.getState().applyRemoteQueue('s1', [mk(1), mk(2, 's1', { position: 1 })], null, 'other-window');
    release(new Response('{"ok":true}', { status: 200 }));
    await settle();

    // #2 is sent and removed here; then a stale list that still has it comes in.
    w.store.getState().remove('s1', 2);
    w.store.getState().applyRemoteQueue(
      's1', [mk(1), mk(2, 's1', { position: 1 }), mk(3, 's1', { position: 2 })], null, 'other-window',
    );

    expect(queueOf(w)).toEqual([1, 3]);
  });
});

describe('a local edit is never swallowed by a remote apply', () => {
  it('pushes an edit made right after the server’s list was installed', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    // No timer turn between the two: the old zero-delay "skip the next push" flag was still set.
    w.store.getState().applyRemoteQueue('s1', [mk(1)], null, 'someone-else');
    w.store.getState().add('s1', mk(2));
    await vi.advanceTimersByTimeAsync(500);

    expect(server.puts).toHaveLength(1);
    expect(idsOf(server.puts[0].items)).toEqual([1, 2]);
  });

  it('does not push back the list it just installed', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    w.store.getState().applyRemoteQueue('s1', [mk(1), mk(2)], null, 'someone-else');
    await vi.advanceTimersByTimeAsync(2000);

    expect(server.puts).toHaveLength(0);
  });

  it('does not push back remote automation, but does push a local change made right after it', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    const { DEFAULT_AUTOMATION } = await import('./queueStore');

    w.store.getState().applyRemoteQueue('s1', [], { ...DEFAULT_AUTOMATION, paused: true }, 'someone-else');
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.puts).toHaveLength(0);

    w.store.getState().applyRemoteQueue('s2', [], { ...DEFAULT_AUTOMATION, paused: true }, 'someone-else');
    w.store.getState().setPaused('s2', false); // the user's own toggle, in the same tick
    await vi.advanceTimersByTimeAsync(500);

    const sent = server.putsFor('s2');
    expect(sent).toHaveLength(1);
    expect((sent[0].automation as { paused: boolean }).paused).toBe(false);
  });

  it('still recognises a list as the server’s after other changes have happened in between', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    w.store.getState().applyRemoteQueue('s1', [mk(1)], null, 'someone-else');
    await vi.advanceTimersByTimeAsync(10);
    w.store.getState().applyRemoteQueue('s1', [mk(1), mk(2, 's1', { position: 1 })], null, 'someone-else');
    await vi.advanceTimersByTimeAsync(2000);

    expect(server.puts).toHaveLength(0);
  });
});

describe('closing the window with a push still waiting', () => {
  it('sends it at once, as a keepalive request, instead of losing it', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    w.store.getState().add('s1', mk(1));
    expect(server.puts).toHaveLength(0); // still inside the debounce
    window.dispatchEvent(new Event('pagehide'));

    const sent = server.putsBy(w, 's1');
    expect(sent).toHaveLength(1);
    expect(sent[0].keepalive).toBe(true);
    expect(idsOf(sent[0].items)).toEqual([1]);
    expect(sent[0].originClientId).toBe(w.origin);

    // The timer that would have sent it is gone: it is not sent twice.
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.putsBy(w, 's1')).toHaveLength(1);
  });

  it('flushes every session that has a push waiting, each with its latest state', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    w.store.getState().add('a', mk(1, 'a'));
    w.store.getState().add('a', mk(2, 'a', { position: 1 }));
    w.store.getState().add('b', mk(3, 'b'));
    window.dispatchEvent(new Event('pagehide'));

    expect(idsOf(server.putsBy(w, 'a')[0].items)).toEqual([1, 2]);
    expect(idsOf(server.putsBy(w, 'b')[0].items)).toEqual([3]);
  });

  it('sends nothing when nothing is waiting', async () => {
    begin();
    const w = await openWindow();
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    w.store.getState().add('s1', mk(1));
    await vi.advanceTimersByTimeAsync(500); // pushed normally
    server.puts.length = 0;
    window.dispatchEvent(new Event('pagehide'));

    expect(server.putsBy(w, 's1')).toHaveLength(0);
  });
});

describe('syncFromServer', () => {
  const localRows = [{ id: 7, sessionId: 'local-only', text: 'Prompt #7', position: 0, createdAt: 1 }];

  it('seeds a session the server has never heard of from this window’s own copy', async () => {
    begin();
    const w = await openWindowWithDb(localRows);
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);

    await w.store.getState().loadFromDb();
    await w.store.getState().syncFromServer();
    await vi.advanceTimersByTimeAsync(500);

    expect(idsOf(server.putsFor('local-only')[0].items)).toEqual([7]);
  });

  it('pulls without seeding when asked not to, so a window can never recreate a deleted server record', async () => {
    begin();
    const w = await openWindowWithDb(localRows);
    const server = startServer(() => [w]);
    vi.stubGlobal('fetch', server.fetchMock);
    server.preload('other', [mk(5, 'other')]);

    await w.store.getState().loadFromDb();
    await w.store.getState().syncFromServer({ seed: false });
    await vi.advanceTimersByTimeAsync(2000);

    expect(queueOf(w, 'other')).toEqual([5]); // the pull still applied
    expect(server.puts).toHaveLength(0); // and nothing was created from the local copy
  });
});
