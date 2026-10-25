/**
 * The module-level bookkeeping of queueStore (P4 fix wave, findings-D Minors).
 *
 * The store keeps per-session maps beside the Zustand state (what the server holds, pushes in flight, edits it has
 * not seen). Two things must hold of them: a session that is gone leaves nothing behind (it used to keep counting
 * as "unsent edits" for ever, and the maps never shrank), and a push that cannot even build its body is not
 * counted as on the wire.
 *
 * Each case is seen through what the store does next: an incoming list is merged and pushed back while this window
 * holds unsent edits, installed and never echoed when it does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from './queueStore';

interface Put {
  sessionId: string;
  items: QueueItem[];
}

let puts: Put[] = [];
/** Sessions whose PUT never gets an answer (the server cannot be reached for them). */
let failing = new Set<string>();
/** Sessions whose PUTs are held on the wire: sent, not answered, until `answerHeld` is called. */
let holding = new Set<string>();
let held: Array<{ sessionId: string; answer: () => void }> = [];

const mk = (id: number, sessionId = 's1'): QueueItem => ({
  id,
  sessionId,
  text: `Prompt #${id}`,
  position: id - 1,
  createdAt: 1,
});

async function openWindow() {
  vi.resetModules();
  vi.useFakeTimers();
  puts = [];
  failing = new Set();
  holding = new Set();
  held = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /^\/api\/sessions\/([^/]+)\/queue$/.exec(String(input));
      if (match && init?.method === 'PUT') {
        const sessionId = decodeURIComponent(match[1]);
        const body = JSON.parse(String(init.body)) as { items: QueueItem[] };
        puts.push({ sessionId, items: body.items }); // an attempt, answered or not
        if (failing.has(sessionId)) throw new TypeError('Failed to fetch');
        if (holding.has(sessionId)) {
          await new Promise<void>((resolve) => held.push({ sessionId, answer: resolve }));
        }
      }
      return new Response('{"ok":true}', { status: 200 });
    }),
  );
  const mod = await import('./queueStore');
  return mod.useQueueStore;
}

const pushOut = () => vi.advanceTimersByTimeAsync(500);
/** Answer the oldest held PUT of a session (the server replies 200 now). */
const answerHeld = (sessionId: string) => {
  const at = held.findIndex((h) => h.sessionId === sessionId);
  expect(at).toBeGreaterThanOrEqual(0); // splice(-1) would silently answer the wrong PUT
  held.splice(at, 1)[0].answer();
  return vi.advanceTimersByTimeAsync(0);
};
const putsFor = (sessionId: string) => puts.filter((p) => p.sessionId === sessionId);

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(5000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a session whose queue is gone', () => {
  it('no longer counts as holding unsent edits (a failed push of it is forgotten with it)', async () => {
    const store = await openWindow();
    failing.add('s1');
    store.getState().setQueue('s1', [mk(1)]);
    await pushOut(); // refused: the window holds an older list than the server
    // The card is re-keyed: the queue leaves s1 (its own removal push is refused too).
    store.getState().migrateSession('s1', 's2');
    await pushOut();
    failing.delete('s1');
    puts = [];

    // A list for the old id arrives much later. Nothing unsent is left for it, so it is installed as it is
    // and not pushed back.
    store.getState().applyRemoteQueue('s1', [mk(5)], null, 'another-window');
    await pushOut();

    expect(store.getState().queues.get('s1')?.map((i) => i.id)).toEqual([5]);
    expect(putsFor('s1')).toEqual([]);
  });

  it('a push that is still out when the queue goes keeps counting until it is answered, then is forgotten', async () => {
    const store = await openWindow();
    holding.add('s1');
    store.getState().setQueue('s1', [mk(1)]);
    await pushOut(); // PUT #1 is on the wire and stays there
    store.getState().migrateSession('s1', 's2'); // the removal push (an empty list) follows it
    await pushOut(); // PUT #2 is on the wire too
    expect(held.filter((h) => h.sessionId === 's1')).toHaveLength(2);

    await answerHeld('s1'); // #1 comes back; #2 is still out, so the session must not be forgotten yet
    puts = [];
    store.getState().applyRemoteQueue('s1', [mk(1), mk(5)], null, 'another-window');
    await pushOut();

    // Still unsent edits (#2): the list is merged against what #1 left the server holding ([1]), so the removal of
    // item 1 survives, and the merged list is pushed back. A forgotten session would install the list as it is.
    expect(store.getState().queues.get('s1')?.map((i) => i.id)).toEqual([5]);
    expect(putsFor('s1').length).toBeGreaterThan(0);

    await answerHeld('s1'); // the push sent by the merge
    await answerHeld('s1'); // #2
    await pushOut();
    puts = [];

    // Everything is answered: nothing is counted any more, so a later list is installed as it is, never echoed.
    holding.delete('s1');
    store.getState().migrateSession('s1', 's3');
    await pushOut();
    puts = [];
    store.getState().applyRemoteQueue('s1', [mk(9)], null, 'another-window');
    await pushOut();
    expect(store.getState().queues.get('s1')?.map((i) => i.id)).toEqual([9]);
    expect(putsFor('s1')).toEqual([]);
  });

  it('a session that still has a list keeps its bookkeeping when another session goes', async () => {
    const store = await openWindow();
    failing.add('s3');
    store.getState().setQueue('s3', [mk(1, 's3')]);
    store.getState().setQueue('s1', [mk(1)]);
    await pushOut(); // s3 refused
    store.getState().migrateSession('s1', 's2');
    await pushOut();
    puts = [];

    store.getState().applyRemoteQueue('s3', [mk(1, 's3'), mk(2, 's3')], null, 'another-window');
    await pushOut();

    // s3 is still unsynced: its list is merged and sent again, not installed over.
    expect(putsFor('s3').length).toBeGreaterThan(0);
  });
});

describe('a push whose body cannot be built', () => {
  it('is not counted as on the wire', async () => {
    const store = await openWindow();
    const unserialisable = { ...mk(1), text: 'x', extra: 1n } as unknown as QueueItem;
    store.getState().setQueue('s1', [unserialisable]);
    // The timer callback cannot build the body (JSON cannot hold a BigInt); it must not throw out of the timer.
    await pushOut(); // a throw out of the timer would reject here
    store.getState().setQueue('s1', []);
    await pushOut();
    puts = [];

    // Nothing is out: a list from elsewhere is installed, not merged and pushed back.
    store.getState().applyRemoteQueue('s1', [mk(9)], null, 'another-window');
    await pushOut();

    expect(putsFor('s1')).toEqual([]);
  });
});
