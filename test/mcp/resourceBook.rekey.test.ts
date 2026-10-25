// test/mcp/resourceBook.rekey.test.ts — what the subscription book (server/mcp/resourceSubscriptions.ts) does when the
// session a URI names is re-keyed (review finding C-M2): a worker's /clear, a resume, or a terminal's first hook gives
// its card a new id, and the `session_update` that tells so carries `replacesId` (the old id). A subscription is bound
// to a whole id when it is made; without this it would stay silent for the rest of the MCP session, holding its slot,
// on `aasc://sessions/<old>/…`. It follows the card instead, under the URI the central wrote, and the scope is still
// checked on every notification. Under fake timers; no server, no endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SUBSCRIPTIONS } from '../../server/mcp/resourceSubscriptions.js';
import { roomInput } from './centralFixtures.js';
import { book, due } from './resourceBookWorld.js';
import { freshWorld, type World } from './resourceWorld.js';
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

/** The store after a re-key: the card now lives under its new id (and the old id is no card any more). */
function reKey(world: World, from: string, to: string): void {
  world.sessions = world.sessions.map((s) => (s.sessionId === from ? { ...s, sessionId: to } : s));
}

/** The update the hook pipeline sends for a re-keyed card: the new card, with the id it replaces. */
const reKeyUpdate = (to: string, replacesId: unknown) => ({
  type: 'session_update',
  session: { sessionId: to, replacesId },
});

describe('the subscription book after a session is re-keyed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('a subscription keeps notifying after its session is re-keyed, under the URI the central wrote', async () => {
    const { subs, bus, notified, world } = book();
    await subs.subscribe('aasc://sessions/s1/answer');
    reKey(world, 's1', 'n1');
    bus.emit(reKeyUpdate('n1', 's1'));
    due();
    notified.length = 0;

    bus.emit({ type: 'chat_grew', sessionId: 'n1' });
    due();

    expect(notified).toEqual(['aasc://sessions/s1/answer']);
  });

  it('tells a status subscription of the re-key itself: the card changed', async () => {
    const { subs, bus, notified, world } = book();
    await subs.subscribe('aasc://sessions/s1');
    reKey(world, 's1', 'n1');

    bus.emit(reKeyUpdate('n1', 's1'));
    due();

    expect(notified).toEqual(['aasc://sessions/s1']);
  });

  it('follows every resource of the session, and only the one it bound', async () => {
    const { subs, bus, notified, world } = book();
    for (const uri of [
      'aasc://sessions/s1/answer',
      'aasc://sessions/s1/conversation',
      'aasc://sessions/s1/queue',
      'aasc://sessions/s2/answer',
    ]) {
      await subs.subscribe(uri);
    }
    reKey(world, 's1', 'n1');
    bus.emit(reKeyUpdate('n1', 's1'));
    due();
    notified.length = 0;

    bus.emit({ type: 'chat_grew', sessionId: 'n1' });
    bus.emit({ type: 'queue_update', sessionId: 'n1' });
    bus.emit({ type: 'chat_grew', sessionId: 's2' });
    due();

    expect([...notified].sort()).toEqual([
      'aasc://sessions/s1/answer',
      'aasc://sessions/s1/conversation',
      'aasc://sessions/s1/queue',
      'aasc://sessions/s2/answer',
    ]);
  });

  it('matches the whole id the subscription is bound to, not the short id the URI was written with', async () => {
    const world = freshWorld();
    world.sessions.push(makeSession('0123456789abcdef'));
    const { subs, bus, notified } = book(undefined, world);
    await subs.subscribe('aasc://sessions/01234567/answer');
    reKey(world, '0123456789abcdef', 'fedcba9876543210');
    bus.emit(reKeyUpdate('fedcba9876543210', '0123456789abcdef'));
    due();
    notified.length = 0;

    bus.emit({ type: 'chat_grew', sessionId: 'fedcba9876543210' });
    due();

    expect(notified).toEqual(['aasc://sessions/01234567/answer']);
  });

  it('keeps its slot and its feed, and is let go by the URI as it was written', async () => {
    const { subs, bus, world } = book();
    await subs.subscribe('aasc://sessions/s1/answer');
    reKey(world, 's1', 'n1');

    bus.emit(reKeyUpdate('n1', 's1'));

    expect(subs.count()).toBe(1);
    expect(bus.listenerCount()).toBe(1);
    subs.unsubscribe('aasc://sessions/s1/answer');
    expect(subs.count()).toBe(0);
    expect(bus.listenerCount()).toBe(0);
  });

  it('adds nothing to the book: a book at the cap stays at it', async () => {
    const { subs, bus, world } = book();
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) {
      await subs.subscribe(`aasc://sessions/s1/changes/${i}`);
    }
    reKey(world, 's1', 'n1');

    bus.emit(reKeyUpdate('n1', 's1'));

    expect(subs.count()).toBe(MAX_SUBSCRIPTIONS);
  });

  it('follows a chain of re-keys (s1, then n1, then n2)', async () => {
    const { subs, bus, notified, world } = book();
    await subs.subscribe('aasc://sessions/s1/answer');
    reKey(world, 's1', 'n1');
    bus.emit(reKeyUpdate('n1', 's1'));
    reKey(world, 'n1', 'n2');
    bus.emit(reKeyUpdate('n2', 'n1'));
    due();
    notified.length = 0;

    bus.emit({ type: 'chat_grew', sessionId: 'n2' });
    due();
    expect(notified).toEqual(['aasc://sessions/s1/answer']);

    // The ids it left behind name nothing any more.
    notified.length = 0;
    bus.emit({ type: 'chat_grew', sessionId: 'n1' });
    bus.emit({ type: 'chat_grew', sessionId: 's1' });
    due();
    expect(notified).toEqual([]);
  });

  it('a subscription made under the new id is its own resource, told under its own URI', async () => {
    const { subs, bus, notified, world } = book();
    await subs.subscribe('aasc://sessions/s1/answer');
    reKey(world, 's1', 'n1');
    bus.emit(reKeyUpdate('n1', 's1'));
    due();
    await subs.subscribe('aasc://sessions/n1/answer');
    notified.length = 0;

    bus.emit({ type: 'chat_grew', sessionId: 'n1' });
    due();

    expect([...notified].sort()).toEqual(['aasc://sessions/n1/answer', 'aasc://sessions/s1/answer']);
  });

  describe('the scope is still checked on every notification', () => {
    it('a re-keyed card the room does not list yet is not told of, until it does', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions/s1/answer');
      reKey(world, 's1', 'n1'); // the room's mirror still lists s1
      bus.emit(reKeyUpdate('n1', 's1'));
      bus.emit({ type: 'chat_grew', sessionId: 'n1' });
      due();
      expect(notified).toEqual([]);

      world.rooms[0].sessionIds.push('n1'); // the window filed the card under its new id
      bus.emit({ type: 'chat_grew', sessionId: 'n1' });
      due();
      expect(notified).toEqual(['aasc://sessions/s1/answer']);
    });

    it('an update that claims to replace the id with a session outside the scope opens nothing', async () => {
      const { subs, bus, notified } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions/s1/answer');
      await subs.subscribe('aasc://sessions/s1');

      // s2 is in room r2: whatever an update says it replaces, what happens to it is no news to this central.
      bus.emit(reKeyUpdate('s2', 's1'));
      bus.emit({ type: 'chat_grew', sessionId: 's2' });
      bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
      due();

      expect(notified).toEqual([]);
    });
  });

  describe('is a re-key only when the update says so', () => {
    it.each([
      ['no replacesId', { sessionId: 'n1' }],
      ['an empty replacesId', { sessionId: 'n1', replacesId: '' }],
      ['a replacesId that is not text', { sessionId: 'n1', replacesId: 7 }],
      ['a replacesId that is the card’s own id', { sessionId: 's1', replacesId: 's1' }],
      ['a replacesId of another session', { sessionId: 'n1', replacesId: 's2' }],
    ])('%s binds nothing to the new id', async (_name, session) => {
      const { subs, bus, notified, world } = book();
      world.sessions.push(makeSession('n1'));
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'session_update', session });
      due();
      notified.length = 0;
      bus.emit({ type: 'chat_grew', sessionId: 'n1' });
      due();

      expect(notified).toEqual([]);
    });

    it('a replacesId on any other kind of broadcast is not a re-key', async () => {
      const { subs, bus, notified, world } = book();
      world.sessions.push(makeSession('n1'));
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'chat_grew', sessionId: 'n1', session: { sessionId: 'n1', replacesId: 's1' }, replacesId: 's1' });
      bus.emit({ type: 'queue_update', sessionId: 'n1', replacesId: 's1' });
      due();
      notified.length = 0;
      bus.emit({ type: 'chat_grew', sessionId: 'n1' });
      due();

      expect(notified).toEqual([]);
    });

    it('a session update that is not an object is read as nothing', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'session_update', session: 'n1', replacesId: 's1' });
      bus.emit({ type: 'session_update', session: null });
      bus.emit({ type: 'session_update' });
      due();
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();

      expect(notified).toEqual(['aasc://sessions/s1/answer']);
    });
  });

  describe('a removal after the re-key', () => {
    it('is told to the status subscription under its old URI, and then the subscription is dropped', async () => {
      const { subs, bus, notified, world } = book();
      await subs.subscribe('aasc://sessions/s1');
      await subs.subscribe('aasc://sessions/s1/answer');
      reKey(world, 's1', 'n1');
      bus.emit(reKeyUpdate('n1', 's1'));
      due();
      notified.length = 0;
      world.sessions = world.sessions.filter((s) => s.sessionId !== 'n1');

      bus.emit({ type: 'session_removed', sessionId: 'n1' });
      due();

      expect(notified).toEqual(['aasc://sessions/s1']);
      expect(subs.count()).toBe(0);
    });
  });
});
