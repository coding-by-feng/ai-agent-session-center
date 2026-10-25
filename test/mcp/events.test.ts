// test/mcp/events.test.ts — the hub a tool waits on (server/mcp/events.ts): one subscription to the
// broadcast feed while anything listens, timed waits capped at 50 s, listeners kept apart from each
// other's failures. The feed is a stand-in for `onBroadcast`; timers are faked where a wait times out.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventHub, MAX_WAIT_MS, type BroadcastMessage } from '../../server/mcp/events.js';
import { fakeBus } from './centralFixtures.js';

// The hub logs a listener that throws; the logger would append to a file on disk.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const update = (sessionId: string, status: string): BroadcastMessage => ({
  type: 'session_update',
  sessionId,
  status,
});
const statusOf = (sessionId: string) => (m: BroadcastMessage) =>
  m.type === 'session_update' && m.sessionId === sessionId ? (m.status as string) : null;

/** Has the promise settled yet? Lets the microtasks queued so far run first. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('the event hub', () => {
  afterEach(() => {
    vi.useRealTimers();
    log.warn.mockClear();
  });

  it('events.waitFor resolves on a match and returns null at the timeout', async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);

    const hit = hub.waitFor(statusOf('s1'), 10_000);
    bus.emit({ type: 'queue_update', sessionId: 's1' });
    bus.emit(update('s2', 'idle'));
    bus.emit(update('s1', 'waiting'));
    bus.emit(update('s1', 'idle'));
    await expect(hit).resolves.toBe('waiting');

    const miss = hub.waitFor(statusOf('s1'), 10_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await settled(miss)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(miss).resolves.toBeNull();
  });

  it('never waits longer than 50 s', async () => {
    vi.useFakeTimers();
    const hub = createEventHub(fakeBus().subscribe);
    expect(MAX_WAIT_MS).toBe(50_000);

    const wait = hub.waitFor(statusOf('s1'), 120_000);
    await vi.advanceTimersByTimeAsync(49_999);
    expect(await settled(wait)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(wait).resolves.toBeNull();
  });

  it.each([0, -5, Number.NaN])('answers a wait of %s with null at once', async (ms) => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);

    await expect(hub.waitFor(statusOf('s1'), ms)).resolves.toBeNull();
    expect(bus.listenerCount()).toBe(0);
  });

  it('listens to the feed only while something waits or listens', async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);
    expect(bus.listenerCount()).toBe(0);

    const offA = hub.on(() => {});
    const offB = hub.on(() => {});
    expect(bus.listenerCount()).toBe(1);
    offA();
    offA();
    expect(bus.listenerCount()).toBe(1);
    offB();
    expect(bus.listenerCount()).toBe(0);

    const hit = hub.waitFor(statusOf('s1'), 1_000);
    expect(bus.listenerCount()).toBe(1);
    bus.emit(update('s1', 'idle'));
    await hit;
    expect(bus.listenerCount()).toBe(0);

    const miss = hub.waitFor(statusOf('s1'), 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await miss;
    expect(bus.listenerCount()).toBe(0);
  });

  it('keeps delivering to the others when one listener throws', async () => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);
    const seen: string[] = [];
    hub.on(() => {
      throw new Error('listener broke');
    });
    hub.on((m) => seen.push(m.type));
    const wait = hub.waitFor(statusOf('s1'), 1_000);

    bus.emit(update('s1', 'waiting'));

    expect(seen).toEqual(['session_update']);
    await expect(wait).resolves.toBe('waiting');
    expect(log.warn).toHaveBeenCalledWith('mcp', expect.stringContaining('listener broke'));
  });

  it('rejects the one wait whose matcher throws, and leaves the others waiting', async () => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);
    const broken = hub.waitFor(() => {
      throw new Error('matcher broke');
    }, 1_000);
    const fine = hub.waitFor(statusOf('s1'), 1_000);

    bus.emit(update('s2', 'idle'));
    await expect(broken).rejects.toThrow('matcher broke');
    bus.emit(update('s1', 'idle'));
    await expect(fine).resolves.toBe('idle');
  });

  it('answers null and stops listening when its signal aborts', async () => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);
    const stop = new AbortController();

    const wait = hub.waitFor(statusOf('s1'), 10_000, stop.signal);
    expect(bus.listenerCount()).toBe(1);
    stop.abort();

    await expect(wait).resolves.toBeNull();
    expect(bus.listenerCount()).toBe(0);
  });

  it('answers null at once, without listening, for a signal already aborted', async () => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);

    await expect(hub.waitFor(statusOf('s1'), 10_000, AbortSignal.abort())).resolves.toBeNull();
    expect(bus.listenerCount()).toBe(0);
  });

  it('lets go of its signal once it has an answer', async () => {
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);
    const stop = new AbortController();
    const removed = vi.spyOn(stop.signal, 'removeEventListener');

    const wait = hub.waitFor(statusOf('s1'), 10_000, stop.signal);
    bus.emit(update('s1', 'idle'));
    await expect(wait).resolves.toBe('idle');

    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    stop.abort();
    expect(bus.listenerCount()).toBe(0);
  });

  it('treats any answer but null or undefined as a match', async () => {
    vi.useFakeTimers();
    const bus = fakeBus();
    const hub = createEventHub(bus.subscribe);

    const zero = hub.waitFor((m) => (m.type === 'tick' ? 0 : null), 1_000);
    const nothing = hub.waitFor(() => undefined as unknown as null, 1_000);
    bus.emit({ type: 'tick' });

    await expect(zero).resolves.toBe(0);
    expect(await settled(nothing)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(nothing).resolves.toBeNull();
  });
});
