/**
 * A person's queue switch against a write the server makes meanwhile (Ruling 62, FW-B's concern 1).
 *
 * A central's queue tool reads the stored record, changes the items and stores the record back, so its broadcast
 * carries the automation as the server last had it. A person who flipped a switch in the last 400 ms (the push
 * debounce) has not sent that flip yet; installing the broadcast's automation undid it in the window and in the
 * push that followed. Ruling 62 kept the window's switches only when the broadcast's automation equalled the one the
 * server last had; a central's `queue_pause` stores the WHOLE record with `paused` set, so it differed and undid the
 * flip all the same (P4-20). Now, while this window holds unsent edits, the switches are merged key by key against
 * the last synced automation: a key the window changed keeps the window's value (one both changed goes to the
 * window), every other takes the server's. With nothing unsent the incoming record is installed whole.
 *
 * Second half: a switch flipped on a session with no list in this window queued a push of `items: []`; the item a
 * central added meanwhile was installed as is, and that stale push then wiped it from the server.
 *
 * One store, driven through its own setters; the central's broadcast is handed to `applyRemoteQueue` by hand, as
 * queueStore.test.ts does. `fetch` is a stub that records every PUT.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueAutomationConfig, QueueItem } from './queueStore';

interface Put {
  sessionId: string;
  items: QueueItem[];
  automation: QueueAutomationConfig | null;
}

const CENTRAL_ORIGIN = 'mcp:central-test';
let puts: Put[] = [];

const mk = (id: number, sessionId = 's1'): QueueItem => ({
  id,
  sessionId,
  text: `Prompt #${id}`,
  position: id - 1,
  createdAt: 1,
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const lastPut = (sessionId: string): Put | undefined => puts.filter((p) => p.sessionId === sessionId).at(-1);
const ids = (items: readonly QueueItem[] | undefined) => (items ?? []).map((i) => i.id);

async function openWindow() {
  vi.resetModules();
  vi.useFakeTimers();
  puts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /^\/api\/sessions\/([^/]+)\/queue$/.exec(String(input));
      if (match && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { items: QueueItem[]; automation?: QueueAutomationConfig | null };
        puts.push({ sessionId: decodeURIComponent(match[1]), items: body.items, automation: body.automation ?? null });
      }
      return new Response('{"ok":true}', { status: 200 });
    }),
  );
  const mod = await import('./queueStore');
  return mod.useQueueStore;
}

/** Past the 400 ms push debounce, with the PUT answered. */
const pushOut = () => vi.advanceTimersByTimeAsync(500);

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(5000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a switch the person flipped while a central writes the queue', () => {
  it("a central's item write does not undo a switch the person just flipped", async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoSend: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null); // synced: the server has this

    store.getState().setAutoSend('s1', false); // the person turns auto-send off; its push waits 400 ms
    // A central adds a prompt: the server stores [1, 2] with the automation it had, and tells every window.
    store.getState().applyRemoteQueue('s1', [mk(1), mk(2)], clone(stored), CENTRAL_ORIGIN);
    await pushOut();

    expect(store.getState().getAutomation('s1').autoSend).toBe(false);
    expect(ids(store.getState().queues.get('s1'))).toEqual([1, 2]);
    expect(lastPut('s1')?.automation?.autoSend).toBe(false);
    expect(ids(lastPut('s1')?.items)).toEqual([1, 2]);
  });

  it("after the window's own push lands, that is what the server has: a later central write keeps both flips", async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoSend: true, autoResume: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null);

    store.getState().setAutoSend('s1', false);
    await pushOut(); // the server now has autoSend off (the window ignores its own echo)
    const afterFirst = clone(store.getState().getAutomation('s1'));

    store.getState().setAutoResume('s1', false); // second flip, still waiting
    store.getState().applyRemoteQueue('s1', [mk(1), mk(2)], afterFirst, CENTRAL_ORIGIN);
    await pushOut();

    expect(store.getState().getAutomation('s1').autoSend).toBe(false);
    expect(store.getState().getAutomation('s1').autoResume).toBe(false);
    expect(lastPut('s1')?.automation?.autoResume).toBe(false);
  });

  it("a central's queue_pause during a pending autoEnter flip keeps both", async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoEnter: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null); // synced: the server has this

    store.getState().setAutoEnter('s1', false); // the person turns auto-enter off; its push waits 400 ms
    // A central pauses the queue: the server stores the whole record with `paused` set and tells every window.
    store.getState().applyRemoteQueue('s1', [mk(1)], { ...clone(stored), paused: true }, CENTRAL_ORIGIN);
    await pushOut();

    expect(store.getState().getAutomation('s1').autoEnter).toBe(false);
    expect(store.getState().getAutomation('s1').paused).toBe(true);
    expect(lastPut('s1')?.automation?.autoEnter).toBe(false);
    expect(lastPut('s1')?.automation?.paused).toBe(true);
  });

  it('a switch both writers changed goes to the window: the person wins', async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), resumeMaxRetries: 3, idleGuard: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null);

    store.getState().setResumeMaxRetries('s1', 5); // the person's number
    // The central set another number, and changed an unrelated switch too.
    const theirs = { ...stored, resumeMaxRetries: 7, idleGuard: false };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(theirs), 'another-window');
    await pushOut();

    expect(store.getState().getAutomation('s1')).toEqual({ ...theirs, resumeMaxRetries: 5 });
    expect(lastPut('s1')?.automation).toEqual({ ...theirs, resumeMaxRetries: 5 });
  });

  it('a remote change to another switch lands beside the window\'s own flip', async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoSend: true, idleGuard: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null);

    store.getState().setAutoSend('s1', false);
    const theirs = { ...stored, idleGuard: false }; // another writer changed a different switch
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(theirs), 'another-window');

    expect(store.getState().getAutomation('s1')).toEqual({ ...theirs, autoSend: false });
  });

  it("with nothing unsent, a remote automation replaces the window's as before", async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoSend: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null);
    await pushOut();

    const theirs = { ...stored, autoSend: false };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(theirs), 'another-window');

    expect(store.getState().getAutomation('s1')).toEqual(theirs);
  });

  it('a central write carrying the old switches replaces them once the flip has synced (nothing unsent)', async () => {
    const store = await openWindow();
    const stored = { ...store.getState().getAutomation('s1'), autoSend: true };
    store.getState().applyRemoteQueue('s1', [mk(1)], clone(stored), null);
    store.getState().setAutoSend('s1', false);
    await pushOut();

    // Nothing unsent now: whatever the server sends is the newer state (no exception applies).
    store.getState().applyRemoteQueue('s1', [mk(1), mk(2)], clone(stored), CENTRAL_ORIGIN);

    expect(store.getState().getAutomation('s1').autoSend).toBe(true);
  });
});

describe('a switch flipped on a session this window holds no list for', () => {
  it("an automation flip on a session with no list is merged, not wiped by its own stale push", async () => {
    const store = await openWindow();
    expect(store.getState().queues.get('s2')).toBeUndefined();

    store.getState().setAutoResume('s2', false); // its push waits 400 ms carrying `items: []`
    // A central adds the session's first prompt meanwhile; a first record carries no automation.
    store.getState().applyRemoteQueue('s2', [mk(7, 's2')], null, CENTRAL_ORIGIN);
    await pushOut();

    expect(ids(store.getState().queues.get('s2'))).toEqual([7]);
    expect(ids(lastPut('s2')?.items)).toEqual([7]);
    expect(lastPut('s2')?.automation?.autoResume).toBe(false);
  });
});
