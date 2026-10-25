// test/mcp/resourceBook.test.ts — what a broadcast does to the subscription book (server/mcp/resourceSubscriptions.ts),
// under fake timers: which broadcast reaches which of the 18 URIs, how plan usage is told apart from the rest of a
// session update, and what the book remembers of the central's scope. No server, no endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { globalInput, roomInput } from './centralFixtures.js';
import { book, due } from './resourceBookWorld.js';
import { freshWorld, MEDIA, RES } from './resourceWorld.js';
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

  describe('which broadcast reaches which URI', () => {
    const URIS = [
      'aasc://sessions',
      'aasc://sessions/s1',
      'aasc://sessions/s1/conversation',
      'aasc://sessions/s1/answer',
      'aasc://sessions/s1/changes',
      'aasc://sessions/s1/changes/0',
      'aasc://sessions/s1/terminal',
      'aasc://sessions/s1/queue',
      'aasc://sessions/s1/subagents/a-1',
      'aasc://tasks/T1',
      'aasc://rooms',
      `aasc://resources/${RES}`,
      `aasc://resources/${RES}/file`,
      'aasc://snippets',
      'aasc://history/h1',
      `aasc://notes/media/${MEDIA}`,
      'aasc://plan-usage',
      'aasc://workspace',
    ];

    async function subscribedToAll() {
      const b = book();
      for (const uri of URIS) await b.subs.subscribe(uri);
      return b;
    }

    const CASES: Array<[string, Record<string, unknown>, string[]]> = [
      [
        'session_update',
        { type: 'session_update', session: { sessionId: 's1' } },
        ['aasc://sessions', 'aasc://sessions/s1', 'aasc://sessions/s1/subagents/a-1'],
      ],
      [
        'session_removed',
        { type: 'session_removed', sessionId: 's1' },
        ['aasc://sessions', 'aasc://sessions/s1'],
      ],
      [
        'chat_grew',
        { type: 'chat_grew', sessionId: 's1' },
        [
          'aasc://sessions/s1/conversation',
          'aasc://sessions/s1/answer',
          'aasc://sessions/s1/changes',
          'aasc://sessions/s1/changes/0',
        ],
      ],
      [
        'queue_update',
        { type: 'queue_update', sessionId: 's1', items: [] },
        ['aasc://sessions/s1/queue'],
      ],
      [
        'snippets_update',
        { type: 'snippets_update', revision: 3, snippets: [] },
        ['aasc://snippets'],
      ],
      // rooms_update never reaches the feed in this build; were it sent, the rooms resource is not one it names.
      ['rooms_update', { type: 'rooms_update', rooms: [], revision: 2 }, []],
      ['a broadcast about nothing a resource shows', { type: 'hook_stats', stats: {} }, []],
      ['presence_update', { type: 'presence_update' }, []],
      ['terminal_output', { type: 'terminal_output', terminalId: 'term-1', data: 'x' }, []],
    ];

    it.each(CASES)(
      '%s tells the subscribers of exactly what it changes',
      async (_name, message, expected) => {
        const { bus, notified } = await subscribedToAll();

        bus.emit(message as { type: string });
        due();

        expect([...notified].sort()).toEqual([...expected].sort());
      },
    );

    it('tells the subscribers of one session’s resources only of that session', async () => {
      const { bus, notified, world } = await subscribedToAll();
      world.sessions.push(makeSession('s9'));

      bus.emit({ type: 'chat_grew', sessionId: 's9' });
      bus.emit({ type: 'queue_update', sessionId: 's9' });
      bus.emit({ type: 'session_update', session: { sessionId: 's9' } });
      due();

      // Only the list of sessions, which a new session changes.
      expect(notified).toEqual(['aasc://sessions']);
    });

    it('ignores a broadcast that carries no session id, or a malformed one', async () => {
      const { bus, notified, world } = await subscribedToAll();
      // A session whose id is longer than any a hook may give: a broadcast naming it names no session.
      world.sessions.push(makeSession('x'.repeat(300)));

      for (const message of [
        { type: 'chat_grew' },
        { type: 'chat_grew', sessionId: 7 },
        { type: 'queue_update', sessionId: '' },
        { type: 'session_update' },
        { type: 'session_update', session: 'x' },
        { type: 'session_update', session: {} },
        { type: 'session_removed', sessionId: 'x'.repeat(300) },
      ]) {
        bus.emit(message);
      }
      due();

      expect(notified).toEqual([]);
    });
  });

  describe('plan usage', () => {
    const update = (cli: string, asOf: number | null) => ({
      type: 'session_update',
      session: {
        sessionId: 's1',
        ...(asOf === null ? {} : { planUsage: { cli, asOf, windows: [] } }),
      },
    });

    it('is news when a CLI reports newer numbers, and not when the same report rides another update', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://plan-usage');

      bus.emit(update('claude', 100));
      due();
      expect(notified).toEqual(['aasc://plan-usage']);

      notified.length = 0;
      bus.emit(update('claude', 100));
      bus.emit(update('claude', 90));
      bus.emit(update('claude', null));
      due();
      expect(notified).toEqual([]);

      bus.emit(update('claude', 200));
      due();
      expect(notified).toEqual(['aasc://plan-usage']);
    });

    it('keeps each CLI’s last report apart', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://plan-usage');
      bus.emit(update('claude', 100));
      due();
      notified.length = 0;

      bus.emit(update('codex', 50));
      due();

      expect(notified).toEqual(['aasc://plan-usage']);
    });

    it('is not news to a subscriber that could already have read the report: the store holds it at subscribe', async () => {
      const world = freshWorld();
      world.sessions[0].planUsage = {
        cli: 'claude',
        asOf: 100,
        windows: [{ minutes: 300, usedPercent: 10, resetsAt: null }],
      };
      const { subs, bus, notified } = book(globalInput(), world);
      await subs.subscribe('aasc://plan-usage');

      // The report the store already holds, riding another update of the session: nothing the subscriber lacks.
      bus.emit(update('claude', 100));
      bus.emit(update('claude', 99));
      due();
      expect(notified).toEqual([]);

      bus.emit(update('claude', 101));
      due();
      expect(notified).toEqual(['aasc://plan-usage']);
    });

    it('takes the newest report of each CLI from the store, from every session and not only the ones in scope', async () => {
      const world = freshWorld();
      const report = (cli: 'claude' | 'codex', asOf: number) => ({
        cli,
        asOf,
        windows: [{ minutes: 300, usedPercent: 10, resetsAt: null }],
      });
      world.sessions[0].planUsage = report('claude', 100);
      // s2 is not in the room r1; its codex report is account-wide all the same.
      world.sessions[1].planUsage = report('codex', 50);
      // An older report of the same CLI on a third session: it is the newest one that counts.
      world.sessions.push(makeSession('s3', { planUsage: report('claude', 80) }));
      const { subs, bus, notified } = book(roomInput('r1'), world);
      await subs.subscribe('aasc://plan-usage');

      bus.emit(update('codex', 50));
      bus.emit(update('claude', 100));
      bus.emit(update('claude', 90));
      due();
      expect(notified).toEqual([]);

      bus.emit(update('codex', 51));
      due();
      expect(notified).toEqual(['aasc://plan-usage']);
    });

    it('keeps what each subscription has seen apart: the resource under another spelling is still told', async () => {
      const { subs, bus, notified } = book();
      await subs.subscribe('aasc://plan-usage');
      // The URL parser lowercases the scheme, so this names the same resource: its own subscription.
      await subs.subscribe('AASC://plan-usage');

      bus.emit(update('claude', 100));
      due();

      expect([...notified].sort()).toEqual(['AASC://plan-usage', 'aasc://plan-usage']);
      notified.length = 0;
      bus.emit(update('claude', 100));
      due();
      expect(notified).toEqual([]);
    });

    it('is account-wide: a session out of scope that carries a new report is still news', async () => {
      const { subs, bus, notified } = book(roomInput('r1'));
      await subs.subscribe('aasc://plan-usage');

      bus.emit({
        type: 'session_update',
        session: { sessionId: 's2', planUsage: { cli: 'claude', asOf: 7, windows: [] } },
      });
      due();

      expect(notified).toEqual(['aasc://plan-usage']);
    });
  });

  describe('scope', () => {
    it('hears nothing of a session outside the central’s scope', async () => {
      const { subs, bus, notified } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1');
      await subs.subscribe('aasc://sessions/s1/answer');

      bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
      bus.emit({ type: 'session_removed', sessionId: 's2' });
      bus.emit({ type: 'chat_grew', sessionId: 's2' });
      due();
      expect(notified).toEqual([]);

      bus.emit({ type: 'session_update', session: { sessionId: 's1' } });
      due();
      expect([...notified].sort()).toEqual(['aasc://sessions', 'aasc://sessions/s1']);
    });

    it('hears of a session that joins the scope: the list changed', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      world.rooms[0].sessionIds.push('s2');

      bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
      due();

      expect(notified).toEqual(['aasc://sessions']);
    });

    it('hears of a session that leaves the scope in the list, but not in the session’s own resources', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1');
      await subs.subscribe('aasc://sessions/s1/answer');
      world.rooms[0].sessionIds.length = 0;

      bus.emit({ type: 'session_update', session: { sessionId: 's1' } });
      bus.emit({ type: 'chat_grew', sessionId: 's1' });
      due();

      expect(notified).toEqual(['aasc://sessions']);
    });

    it('hears of a removal of a session that was in scope, which the store no longer holds, and of no other', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1');
      world.sessions = world.sessions.filter((s) => s.sessionId !== 's1');

      bus.emit({ type: 'session_removed', sessionId: 's1' });
      bus.emit({ type: 'session_removed', sessionId: 's2' });
      bus.emit({ type: 'session_removed', sessionId: 'never-seen' });
      due();

      expect([...notified].sort()).toEqual(['aasc://sessions', 'aasc://sessions/s1']);
    });

    it('remembers the scope between broadcasts, so a removal after a join is heard', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      world.rooms[0].sessionIds.push('s2');
      bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
      due();
      notified.length = 0;
      world.sessions = world.sessions.filter((s) => s.sessionId !== 's2');

      bus.emit({ type: 'session_removed', sessionId: 's2' });
      due();

      expect(notified).toEqual(['aasc://sessions']);
    });

    it('remembers a session that joined the scope since the last look once it is subscribed to, so its removal is heard', async () => {
      const { subs, bus, notified, world } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      // s2 joins the room: no broadcast says so, and nothing has looked at the scope since the book began.
      world.rooms[0].sessionIds.push('s2');
      await subs.subscribe('aasc://sessions/s2');
      world.sessions = world.sessions.filter((s) => s.sessionId !== 's2');

      bus.emit({ type: 'session_removed', sessionId: 's2' });
      due();

      expect([...notified].sort()).toEqual(['aasc://sessions', 'aasc://sessions/s2']);
    });

    it('goes by the central’s scope as the registry holds it now, and says nothing once the central is gone', async () => {
      const { subs, bus, notified, registry, central } = book(roomInput('r1'));
      await subs.subscribe('aasc://sessions');
      await subs.subscribe('aasc://sessions/s1');
      registry.revoke(central.centralId);

      expect(() =>
        bus.emit({ type: 'session_update', session: { sessionId: 's1' } }),
      ).not.toThrow();
      due();

      expect(notified).toEqual([]);
    });
  });
});
