// test/mcp/resourceSubscriptions.test.ts — resources/subscribe through the real /mcp endpoint
// (server/mcp/resourceSubscriptions.ts, resources.ts): subscribe, a broadcast, `notifications/resources/updated`,
// the scope check, the debounce and the end of the MCP session. The SDK's client talks real HTTP to the endpoint.
// The subscription book's finer rules, under fake timers, are in resourceBook.test.ts and resourceBook.rules.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { globalInput, projectInput, roomInput } from './centralFixtures.js';
import { runCleanups } from './endpointHarness.js';
import {
  connectAs,
  freshWorld,
  listenForUpdates,
  PATIENT,
  refused,
  SHORT_DEBOUNCE_MS,
  startWorld,
  untilHeard,
  wait,
} from './resourceWorld.js';

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

afterEach(runCleanups);

describe('resources/subscribe through the endpoint', () => {
  it('subscribe then a chat_grew broadcast sends notifications/resources/updated', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);

    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));

    // The URI the client subscribed to, spelled as it wrote it, and nothing else.
    expect(new Set(heard)).toEqual(new Set(['aasc://sessions/s1/answer']));
  });

  it('tells a client of a session’s status, of the session list and of the queue as they change', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);
    for (const uri of [
      'aasc://sessions',
      'aasc://sessions/s1',
      'aasc://sessions/s1/queue',
      'aasc://snippets',
    ]) {
      await client.subscribeResource({ uri });
    }

    await untilHeard(heard, () =>
      started.h.bus.emit({ type: 'session_update', session: { sessionId: 's1' } }),
    );
    await wait(SHORT_DEBOUNCE_MS * 3);
    expect(new Set(heard)).toEqual(new Set(['aasc://sessions', 'aasc://sessions/s1']));

    heard.length = 0;
    started.h.bus.emit({ type: 'queue_update', sessionId: 's1' });
    started.h.bus.emit({ type: 'snippets_update', revision: 2, snippets: [] });
    await vi.waitFor(
      () =>
        expect(new Set(heard)).toEqual(new Set(['aasc://sessions/s1/queue', 'aasc://snippets'])),
      PATIENT,
    );
  });

  it('no update for an out-of-scope session', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, roomInput('r1'));
    const heard = listenForUpdates(client);
    await client.subscribeResource({ uri: 'aasc://sessions' });
    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    // Make sure the event stream is open before the silence is judged: an update sent before it is dropped anyway.
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));
    await wait(SHORT_DEBOUNCE_MS * 4);
    heard.length = 0;

    // s2 is not in the room: none of what happens to it is news.
    started.h.bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
    started.h.bus.emit({ type: 'chat_grew', sessionId: 's2' });
    started.h.bus.emit({ type: 'queue_update', sessionId: 's2' });
    started.h.bus.emit({ type: 'session_removed', sessionId: 's2' });
    await wait(SHORT_DEBOUNCE_MS * 6);
    expect(heard).toEqual([]);

    // What happens to s1 is, on the same stream.
    started.h.bus.emit({ type: 'session_update', session: { sessionId: 's1' } });
    await vi.waitFor(() => expect(heard).toEqual(['aasc://sessions']), PATIENT);
  });

  it('refuses a subscription to a URI the central could not read, as it refuses the read', async () => {
    const started = await startWorld();
    const room = await connectAs(started, roomInput('r1'));
    const codex = await connectAs(started, globalInput({ cli: 'codex' }));

    const outside = await refused(
      room.client.subscribeResource({ uri: 'aasc://sessions/s2/answer' }),
    );
    expect(outside.code).toBe(ErrorCode.InvalidParams);
    expect(outside.message).toContain('NOT_IN_SCOPE');
    for (const uri of ['aasc://rooms', 'aasc://nothing', 'aasc://sessions/s1/changes/abc']) {
      expect((await refused(codex.client.subscribeResource({ uri }))).code, uri).toBe(
        ErrorCode.InvalidParams,
      );
    }
    // Refused ones leave nothing listening.
    expect(started.h.bus.listenerCount()).toBe(0);
  });

  it('updates are debounced: a burst of broadcasts is one notification', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);
    await client.subscribeResource({ uri: 'aasc://sessions/s1/conversation' });
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));
    await wait(SHORT_DEBOUNCE_MS * 4);
    heard.length = 0;

    for (let i = 0; i < 20; i += 1) started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' });
    await wait(SHORT_DEBOUNCE_MS * 6);

    expect(heard).toEqual(['aasc://sessions/s1/conversation']);
  });

  it('stops telling a client of a URI it unsubscribed from', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);
    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await client.subscribeResource({ uri: 'aasc://sessions/s1/conversation' });
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));
    await wait(SHORT_DEBOUNCE_MS * 4);
    heard.length = 0;

    await client.unsubscribeResource({ uri: 'aasc://sessions/s1/answer' });
    started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' });
    await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0), PATIENT);
    await wait(SHORT_DEBOUNCE_MS * 4);

    expect(new Set(heard)).toEqual(new Set(['aasc://sessions/s1/conversation']));
    // Unsubscribing from what was never subscribed is not an error.
    await client.unsubscribeResource({ uri: 'aasc://sessions/s1/queue' });
    await client.unsubscribeResource({ uri: 'aasc://nothing' });
  });

  it('subscriptions end with the session: the DELETE closes the feed and nothing is sent after it', async () => {
    const started = await startWorld();
    const { client, transport, central } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);
    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await client.subscribeResource({ uri: 'aasc://sessions' });
    expect(started.h.bus.listenerCount()).toBe(1);
    expect(started.h.router.openSessionCount(central.centralId)).toBe(1);
    started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' });

    await transport.terminateSession();

    await vi.waitFor(() => expect(started.h.bus.listenerCount()).toBe(0), PATIENT);
    heard.length = 0;
    started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' });
    await wait(SHORT_DEBOUNCE_MS * 4);
    expect(heard).toEqual([]);
  });

  it('subscriptions end with the session when its central is revoked, and each session has its own', async () => {
    const started = await startWorld();
    const first = await connectAs(started, globalInput());
    const second = await connectAs(started, roomInput('r1'));
    await first.client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await second.client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    expect(started.h.bus.listenerCount()).toBe(1);

    started.h.registry.revoke(first.central.centralId);

    // One feed, shared by the hub; it stays while one session still listens, and its listener is the second's.
    expect(started.h.router.openSessionCount(first.central.centralId)).toBe(0);
    expect(started.h.router.openSessionCount(second.central.centralId)).toBe(1);
    expect(started.h.bus.listenerCount()).toBe(1);
    const heard = listenForUpdates(second.client);
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));
    expect(new Set(heard)).toEqual(new Set(['aasc://sessions/s1/answer']));
  });

  it('tells each central of what is in its own scope only, though they share the feed', async () => {
    const started = await startWorld();
    const global = await connectAs(started, globalInput());
    const room = await connectAs(started, roomInput('r1'));
    const heardByGlobal = listenForUpdates(global.client);
    const heardByRoom = listenForUpdates(room.client);
    await global.client.subscribeResource({ uri: 'aasc://sessions' });
    await room.client.subscribeResource({ uri: 'aasc://sessions' });
    await untilHeard(heardByGlobal, () =>
      started.h.bus.emit({ type: 'session_update', session: { sessionId: 's1' } }),
    );
    await untilHeard(heardByRoom, () =>
      started.h.bus.emit({ type: 'session_update', session: { sessionId: 's1' } }),
    );
    await wait(SHORT_DEBOUNCE_MS * 4);
    heardByGlobal.length = 0;
    heardByRoom.length = 0;

    started.h.bus.emit({ type: 'session_update', session: { sessionId: 's2' } });
    await vi.waitFor(() => expect(heardByGlobal).toEqual(['aasc://sessions']), PATIENT);
    await wait(SHORT_DEBOUNCE_MS * 4);

    expect(heardByRoom).toEqual([]);
  });

  it('a subscription keeps notifying after its session is re-keyed, under the URI the client wrote', async () => {
    const world = freshWorld();
    const started = await startWorld(world);
    const { client } = await connectAs(started, globalInput());
    const heard = listenForUpdates(client);
    await client.subscribeResource({ uri: 'aasc://sessions/s1/answer' });
    await untilHeard(heard, () => started.h.bus.emit({ type: 'chat_grew', sessionId: 's1' }));
    await wait(SHORT_DEBOUNCE_MS * 4);
    heard.length = 0;

    // The worker is cleared: its card is the same session under a new id, and the update says which id it replaces.
    world.sessions = world.sessions.map((s) => (s.sessionId === 's1' ? { ...s, sessionId: 'n1' } : s));
    started.h.bus.emit({ type: 'session_update', session: { sessionId: 'n1', replacesId: 's1' } });
    started.h.bus.emit({ type: 'chat_grew', sessionId: 'n1' });

    await vi.waitFor(() => expect(heard).toEqual(['aasc://sessions/s1/answer']), PATIENT);
  });

  it('refuses a subscription for a project central to a session outside its folder, and takes one inside', async () => {
    const started = await startWorld();
    const { client } = await connectAs(started, projectInput('/a/proj'));

    await client.subscribeResource({ uri: 'aasc://sessions/s1' });
    const err = await refused(client.subscribeResource({ uri: 'aasc://sessions/s2' }));

    expect(err.message).toContain('NOT_IN_SCOPE');
  });
});
