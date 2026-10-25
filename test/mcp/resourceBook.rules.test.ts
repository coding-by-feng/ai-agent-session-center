// test/mcp/resourceBook.rules.test.ts — the rules of the subscription book (server/mcp/resourceSubscriptions.ts), under
// fake timers: what may be subscribed to, how a burst of changes becomes one notification, and how the book starts
// and ends its listening. No server, no endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventHub } from '../../server/mcp/events.js';
import {
  MAX_SUBSCRIPTIONS,
  RESOURCE_UPDATE_DEBOUNCE_MS,
} from '../../server/mcp/resourceSubscriptions.js';
import { globalInput, roomInput } from './centralFixtures.js';
import { book, due, toolError } from './resourceBookWorld.js';
import { freshWorld } from './resourceWorld.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('the subscription book', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe('subscribing', () => {
    it('refuses a session outside the scope, an unknown or unoffered URI and bad arguments, and keeps nothing for them', async () => {
      const { subs, bus } = book(roomInput('r1'));

      expect((await toolError(subs.subscribe('aasc://sessions/s2'))).code).toBe('NOT_IN_SCOPE');
      expect((await toolError(subs.subscribe('aasc://sessions/nothing-here/answer'))).code).toBe(
        'NOT_FOUND',
      );
      expect((await toolError(subs.subscribe('aasc://nothing'))).code).toBe('NOT_FOUND');
      expect((await toolError(subs.subscribe('aasc://sessions/s1/changes/abc'))).code).toBe(
        'INVALID',
      );
      expect((await toolError(subs.subscribe(`aasc://resources/not-hex`))).code).toBe('INVALID');
      expect((await toolError(subs.subscribe('aasc://sessions/%E0%A4%A'))).code).toBe('INVALID');
      expect(subs.count()).toBe(0);
      expect(bus.listenerCount()).toBe(0);
    });

    it('refuses what the central was not offered', async () => {
      const { subs } = book(globalInput({ cli: 'codex' }));

      expect((await toolError(subs.subscribe('aasc://rooms'))).code).toBe('NOT_FOUND');
      await subs.subscribe('aasc://sessions');
    });

    it('takes a short id, and tells of the session by the URI as it was written', async () => {
      const world = freshWorld();
      world.sessions.push(makeSession('0123456789abcdef'));
      const { subs, bus, notified } = book(globalInput(), world);
      await subs.subscribe('aasc://sessions/01234567/answer');

      bus.emit({ type: 'chat_grew', sessionId: '0123456789abcdef' });
      due();

      expect(notified).toEqual(['aasc://sessions/01234567/answer']);
    });

    it('refuses an ambiguous short id, naming no URI', async () => {
      const world = freshWorld();
      world.sessions.push(makeSession('0123456789abcdef'), makeSession('0123456789ghijkl'));
      const { subs } = book(globalInput(), world);

      const err = await toolError(subs.subscribe('aasc://sessions/0123456/answer'));

      expect(err.code).toBe('INVALID');
    });

    it('takes the same URI twice as one subscription, and one notification', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();

      expect(subs.count()).toBe(1);
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
    });

    it('accepts a resource that is never pushed, and never tells of it', async () => {
      const { subs, bus, notified } = book();
      for (const uri of [
        'aasc://sessions/s1/terminal',
        'aasc://rooms',
        'aasc://workspace',
        'aasc://tasks/T1',
      ])
        await subs.subscribe(uri);

      for (const type of [
        'session_update',
        'chat_grew',
        'queue_update',
        'snippets_update',
        'rooms_update',
      ])
        bus.emit({ type, sessionId: 's1', session: { sessionId: 's1' } });
      due();

      expect(notified).toEqual([]);
    });

    it(`holds at most ${MAX_SUBSCRIPTIONS} subscriptions, and still takes one it already holds`, async () => {
      const { subs } = book();
      for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) await subs.subscribe(`aasc://history/h${i}`);

      const err = await toolError(subs.subscribe('aasc://history/one-too-many'));
      expect(err.code).toBe('INVALID');
      await subs.subscribe('aasc://history/h0');
      expect(subs.count()).toBe(MAX_SUBSCRIPTIONS);
      subs.unsubscribe('aasc://history/h1');
      await subs.subscribe('aasc://history/one-too-many');
    });
  });

  describe('the debounce', () => {
    it('waits at least 500 ms', () => {
      expect(RESOURCE_UPDATE_DEBOUNCE_MS).toBeGreaterThanOrEqual(500);
    });

    it('turns a burst into one notification, sent when the delay is over and not before', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');

      for (let i = 0; i < 5; i += 1) {
        bus.emit({ type: 'chat_grew', sessionId: 's1' });
        vi.advanceTimersByTime(50);
      }
      vi.advanceTimersByTime(RESOURCE_UPDATE_DEBOUNCE_MS - 250 - 1);
      expect(notified).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
      vi.advanceTimersByTime(60_000);
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
    });

    it('sends the next burst as the next notification', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();

      expect(notified).toEqual(['aasc://sessions/s1/answer', 'aasc://sessions/s1/answer']);
    });

    it('never starves: a stream of broadcasts, one every 100 ms, is heard about every 500 ms', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');

      for (let i = 0; i < 30; i += 1) {
        bus.emit({ type: 'chat_grew', sessionId: 's1' });
        vi.advanceTimersByTime(100);
      }

      expect(notified.length).toBeGreaterThanOrEqual(5);
      expect(notified.length).toBeLessThanOrEqual(6);
    });

    it('keeps one delay for each URI', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');
      await subs.subscribe('aasc://sessions/s1/queue');

      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      vi.advanceTimersByTime(300);
      bus.emit({ type: 'queue_update', sessionId: 's1' });
      vi.advanceTimersByTime(RESOURCE_UPDATE_DEBOUNCE_MS - 300);
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
      vi.advanceTimersByTime(300);
      expect(notified).toEqual(['aasc://sessions/s1/answer', 'aasc://sessions/s1/queue']);
    });

    it('takes the delay the central’s server was given, for a test that cannot wait', async () => {
      const { subs, bus, notified } = book(globalInput(), freshWorld(), { debounceMs: 40 });
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      vi.advanceTimersByTime(39);
      expect(notified).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
    });

    it('keeps sending when one notification fails to send', async () => {
      const heard: string[] = [];
      let first = true;
      const { subs, bus } = book(globalInput(), freshWorld(), {
        notify: (uri) => {
          if (first) {
            first = false;
            throw new Error('the stream closed');
          }
          heard.push(uri);
        },
      });
      await subs.subscribe('aasc://sessions/s1/answer');
      await subs.subscribe('aasc://sessions/s1/queue');

      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      bus.emit({ type: 'queue_update', sessionId: 's1' });
      expect(() => due()).not.toThrow();
      expect(heard).toEqual(['aasc://sessions/s1/queue']);

      // The URI whose notification failed is not stuck: its next update is sent.
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();
      expect(heard).toEqual(['aasc://sessions/s1/queue', 'aasc://sessions/s1/answer']);
    });
  });

  describe('its life', () => {
    it('listens to the feed from the first subscription to the last', async () => {
      const { subs, bus } = book();
      expect(bus.listenerCount()).toBe(0);

      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1');
      expect(bus.listenerCount()).toBe(1);
      subs.unsubscribe('aasc://sessions');
      expect(bus.listenerCount()).toBe(1);
      subs.unsubscribe('aasc://sessions/s1');
      expect(bus.listenerCount()).toBe(0);
    });

    it('drops the notification waiting for a URI that is unsubscribed from', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');
      await subs.subscribe('aasc://sessions/s1/queue');
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      bus.emit({ type: 'queue_update', sessionId: 's1' });
      expect(vi.getTimerCount()).toBe(2);

      subs.unsubscribe('aasc://sessions/s1/answer');
      expect(vi.getTimerCount()).toBe(1);
      due();

      expect(notified).toEqual(['aasc://sessions/s1/queue']);
    });

    it('ends everything on close: timers, the feed, the subscriptions', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1/answer');
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      bus.emit({ type: 'session_update', session: { sessionId: 's1' } });
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      subs.close();

      expect(vi.getTimerCount()).toBe(0);
      expect(bus.listenerCount()).toBe(0);
      expect(subs.count()).toBe(0);
      due();
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();
      expect(notified).toEqual([]);
      subs.close();
    });

    it('keeps nothing of a subscription whose feed cannot be attached', async () => {
      const events = createEventHub(() => {
        throw new Error('the feed is down');
      });
      const { subs } = book(globalInput(), freshWorld(), { events });

      await expect(subs.subscribe('aasc://sessions/s1/answer')).rejects.toThrow('the feed is down');

      expect(subs.count()).toBe(0);
    });

    it('takes no subscription from a call that was under way when it closed', async () => {
      const { subs, bus } = book();

      const pending = subs.subscribe('aasc://sessions/s1/answer');
      subs.close();

      expect((await toolError(pending)).code).toBe('UNAVAILABLE');
      expect(subs.count()).toBe(0);
      expect(bus.listenerCount()).toBe(0);
    });

    it('takes no subscription after it is closed', async () => {
      const { subs, bus } = book();
      subs.close();

      const err = await toolError(subs.subscribe('aasc://sessions'));

      expect(err.code).toBe('UNAVAILABLE');
      expect(bus.listenerCount()).toBe(0);
    });
  });
});
