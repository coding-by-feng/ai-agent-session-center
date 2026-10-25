/**
 * `pagehide` sends every push still waiting out its debounce, at once. One session whose body cannot be built (a
 * value JSON has no form for) must not stop the others from going out, nor leave them waiting for a timer that a
 * closing page will never run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueItem } from './queueStore';

let puts: Array<{ sessionId: string; keepalive: boolean }> = [];

const mk = (id: number, sessionId: string): QueueItem => ({
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const match = /^\/api\/sessions\/([^/]+)\/queue$/.exec(String(input));
      if (match && init?.method === 'PUT') {
        puts.push({ sessionId: decodeURIComponent(match[1]), keepalive: init.keepalive === true });
      }
      return new Response('{"ok":true}', { status: 200 });
    }),
  );
  const mod = await import('./queueStore');
  return mod.useQueueStore;
}

const unserialisable = (sessionId: string) =>
  ({ ...mk(1, sessionId), extra: 1n }) as unknown as QueueItem; // JSON cannot hold a BigInt

afterEach(async () => {
  await vi.advanceTimersByTimeAsync(5000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('flushing pending pushes on pagehide', () => {
  it('sends every waiting session with keepalive', async () => {
    const store = await openWindow();
    store.getState().setQueue('s1', [mk(1, 's1')]);
    store.getState().setQueue('s2', [mk(1, 's2')]);

    window.dispatchEvent(new Event('pagehide'));

    expect(puts.map((p) => p.sessionId).sort()).toEqual(['s1', 's2']);
    expect(puts.every((p) => p.keepalive)).toBe(true);
  });

  it("one session's body that cannot be built does not skip the sessions after it", async () => {
    const store = await openWindow();
    store.getState().setQueue('s1', [unserialisable('s1')]); // first in the map: its throw used to end the loop
    store.getState().setQueue('s2', [mk(1, 's2')]);
    store.getState().setQueue('s3', [mk(1, 's3')]);

    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();

    expect(puts.map((p) => p.sessionId).sort()).toEqual(['s2', 's3']);
  });

  it('leaves nothing waiting, so no timer sends a session twice', async () => {
    const store = await openWindow();
    store.getState().setQueue('s1', [unserialisable('s1')]);
    store.getState().setQueue('s2', [mk(1, 's2')]);

    window.dispatchEvent(new Event('pagehide'));
    puts = [];
    await vi.advanceTimersByTimeAsync(1000);

    expect(puts).toEqual([]);
  });
});
