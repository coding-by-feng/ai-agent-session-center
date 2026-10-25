// test/mcp/resourceBook.removal.test.ts — what the subscription book (server/mcp/resourceSubscriptions.ts) does when a
// session is removed, under fake timers: the one notification its removal is owed, and then everything bound to the
// session is let go, so it no longer holds slots of the cap. No server, no endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SUBSCRIPTIONS } from '../../server/mcp/resourceSubscriptions.js';
import { roomInput } from './centralFixtures.js';
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

  describe('a session that is gone', () => {
    const without = (world: ReturnType<typeof freshWorld>, id: string): void => {
      world.sessions = world.sessions.filter((s) => s.sessionId !== id);
    };

    it('is let go once its removal is told: that one notification goes out, then what was bound to it is dropped', async () => {
      const { subs, bus, notified, world } = book();
      for (const uri of [
        'aasc://sessions',
        'aasc://sessions/s1',
        'aasc://sessions/s1/answer',
        'aasc://sessions/s1/queue',
        'aasc://sessions/s2',
      ]) {
        await subs.subscribe(uri);
      }
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });
      // Only what has nothing to be told is gone at once; the notification still waits for its turn.
      expect(subs.count()).toBe(3);
      due();

      expect([...notified].sort()).toEqual(['aasc://sessions', 'aasc://sessions/s1']);
      // The list and the other session stay; nothing of s1's is followed any more.
      expect(subs.count()).toBe(2);
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      bus.emit({ type: 'queue_update', sessionId: 's1' });
      bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
      notified.length = 0;
      due();
      expect([...notified].sort()).toEqual(['aasc://sessions', 'aasc://sessions/s2']);
    });

    it('is dropped with its pending notifications: no answer is told of what cannot be read', async () => {
      const { subs, bus, notified, world } = book();
      await subs.subscribe('aasc://sessions/s1/answer');
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      expect(vi.getTimerCount()).toBe(1);
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });
      due();

      expect(vi.getTimerCount()).toBe(0);
      expect(notified).toEqual([]);
      expect(subs.count()).toBe(0);
    });

    it('is dropped whether or not its removal was told: a session that had left the scope is gone for good too', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions/s1');
      await subs.subscribe('aasc://sessions/s1/answer');
      // s1 leaves the room, and the next update says so: the book now remembers it as out of scope.
      world.rooms[0].sessionIds.length = 0;
      bus.emit({ type: 'session_update', session: { sessionId: 's1' } });
      due();
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });
      due();

      expect(notified).toEqual([]);
      expect(subs.count()).toBe(0);
    });

    it('frees the slots it held: a central that followed one session through a hundred resources can follow again', async () => {
      const { subs, bus, world } = book();
      for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
        await subs.subscribe(`aasc://sessions/s1/changes/${i}`);
      }
      expect((await toolError(subs.subscribe('aasc://sessions/s1/answer'))).code).toBe('INVALID');
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });

      expect(subs.count()).toBe(0);
      await subs.subscribe('aasc://sessions/s2');
      expect(subs.count()).toBe(1);
    });

    it('lets go of the feed when the removed session was the last thing followed', async () => {
      const { subs, bus, notified, world } = book();
      await subs.subscribe('aasc://sessions/s1/answer');
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });

      expect(subs.count()).toBe(0);
      expect(bus.listenerCount()).toBe(0);
      due();
      expect(notified).toEqual([]);
    });

    it('does not drop a subscription made again, for the same id, while the removal notification still waits', async () => {
      const { subs, bus, notified, world } = book();
      await subs.subscribe('aasc://sessions/s1');
      without(world, 's1');
      bus.emit({ type: 'session_removed', sessionId: 's1' });
      // A card with the same id appears again, and the central follows it before the notification has gone.
      world.sessions.push(makeSession('s1', { title: 'Back again' }));
      await subs.subscribe('aasc://sessions/s1');

      due();

      expect(notified).toEqual(['aasc://sessions/s1']);
      expect(subs.count()).toBe(1);
    });

    it('keeps what is not bound to the session, and the sessions of other ids', async () => {
      const { subs, bus, world } = book();
      for (const uri of [
        'aasc://sessions',
        'aasc://snippets',
        'aasc://plan-usage',
        'aasc://sessions/s2/queue',
      ]) {
        await subs.subscribe(uri);
      }
      without(world, 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });
      due();

      expect(subs.count()).toBe(4);
    });
  });
});
