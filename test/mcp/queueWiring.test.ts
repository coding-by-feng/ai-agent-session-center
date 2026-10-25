// test/mcp/queueWiring.test.ts — the server's own queue store (server/mcp/queueWiring.ts): `db.getSessionQueue` /
// `db.upsertSessionQueue` and the `queue_update` broadcast, written the way `PUT /sessions/:id/queue` writes them,
// with the origin `mcp:<centralId>` so the desktop window does not take the central's own write for its echo. The
// database and the WebSocket manager are mocked: no test opens SQLite or a socket.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyQueueOp, addItem } from '../../server/mcp/queueOps.js';
import { automationOf, item, NOW, queueOf } from './queueFixtures.js';

const live = vi.hoisted(() => ({
  rows: new Map<string, { sessionId: string; items: unknown[]; automation: unknown; updatedAt: number }>(),
  events: [] as string[],
  clock: 5_000,
  failUpsert: false,
  sent: [] as Array<Record<string, unknown>>,
  aliases: new Map<string, string>(),
}));

vi.mock('../../server/db.js', () => ({
  getSessionQueue: (sessionId: string) => {
    live.events.push(`db.get ${sessionId}`);
    return live.rows.get(sessionId) ?? null;
  },
  upsertSessionQueue: (sessionId: string, items: unknown[], automation: unknown) => {
    live.events.push(`db.upsert ${sessionId}`);
    if (live.failUpsert) throw new Error('SQLITE_FULL: /Users/someone/secret.db');
    live.clock += 1;
    const record = { sessionId, items, automation: automation ?? null, updatedAt: live.clock };
    live.rows.set(sessionId, record);
    return record;
  },
}));
vi.mock('../../server/sessionStore.js', () => ({
  resolveSessionId: (id: string) => live.aliases.get(id) ?? id,
}));
vi.mock('../../server/wsManager.js', () => ({
  broadcast: (message: Record<string, unknown>) => {
    live.events.push(`broadcast ${String(message.type)}`);
    live.sent.push(message);
  },
}));

import { lastQueuePutRefused, recordQueuePut } from '../../server/mcp/queuePutRefusals.js';
import { serverQueueStore } from '../../server/mcp/queueWiring.js';

beforeEach(() => {
  live.rows.clear();
  live.events.length = 0;
  live.sent.length = 0;
  live.failUpsert = false;
  live.aliases.clear();
});

describe('the server’s queue store', () => {
  it('reads the stored items and automation of a session', () => {
    live.rows.set('s1', { sessionId: 's1', items: queueOf(1, 2), automation: automationOf({ paused: true }), updatedAt: 9 });

    const row = serverQueueStore().read('s1');

    expect(row.items).toEqual(queueOf(1, 2));
    expect(row.automation).toEqual(automationOf({ paused: true }));
  });

  it('reads a session the server holds no queue for as an empty queue with no automation', () => {
    expect(serverQueueStore().read('nobody')).toEqual({ items: [], automation: null });
  });

  it('reads stored automation that is not a record as none', () => {
    live.rows.set('s1', { sessionId: 's1', items: [], automation: 'garbage', updatedAt: 9 });

    expect(serverQueueStore().read('s1').automation).toBeNull();
  });

  it('stores the row, then broadcasts queue_update as the PUT route does, carrying the stored record', () => {
    const items = queueOf(1, 2);
    const automation = automationOf();

    serverQueueStore().write('s1', items, automation, 'mcp:central-1');

    expect(live.events).toEqual(['db.upsert s1', 'broadcast queue_update']);
    expect(live.sent).toEqual([
      { type: 'queue_update', sessionId: 's1', items, automation, updatedAt: 5_001, originClientId: 'mcp:central-1' },
    ]);
    expect(live.rows.get('s1')?.items).toEqual(items);
  });

  it('broadcast carries originClientId mcp:<id> when a tool’s op is applied through it', () => {
    live.rows.set('s1', { sessionId: 's1', items: [item(1)], automation: null, updatedAt: 9 });

    applyQueueOp(serverQueueStore(), 's1', (state) => addItem(state, { sessionId: 's1', text: 'hi', disabled: true }, NOW), 'mcp:central-7');

    expect(live.sent).toHaveLength(1);
    expect(live.sent[0]).toMatchObject({ type: 'queue_update', sessionId: 's1', originClientId: 'mcp:central-7' });
    expect((live.sent[0].items as unknown[]).length).toBe(2);
  });

  it('writes a null automation as null, never as undefined', () => {
    serverQueueStore().write('s1', [], null, 'mcp:central-1');

    expect(live.sent[0].automation).toBeNull();
  });

  it('tells nobody when the database refuses the write, and lets the failure through', () => {
    live.failUpsert = true;

    expect(() => serverQueueStore().write('s1', queueOf(1), null, 'mcp:central-1')).toThrow(/SQLITE_FULL/);
    expect(live.sent).toEqual([]);
  });

  it('stores and tells nothing while the window’s last save of that queue was refused, then writes once one goes through', () => {
    recordQueuePut('s-unsaved', false);

    let refusal: unknown = null;
    try {
      serverQueueStore().write('s-unsaved', queueOf(1), null, 'mcp:central-1');
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toMatchObject({
      code: 'UNAVAILABLE',
      message: 'This queue’s last save from the AASC window failed, so AASC can’t change it safely.',
      hint: 'Open AASC and fix the queue first.',
    });
    expect(live.events).toEqual([]);

    recordQueuePut('s-unsaved', true);
    serverQueueStore().write('s-unsaved', queueOf(1), null, 'mcp:central-1');
    expect(live.events).toEqual(['db.upsert s-unsaved', 'broadcast queue_update']);
  });
});

describe('the sessions whose last queue save was refused', () => {
  it('marks a session on a refused save and clears it on the next good one', () => {
    recordQueuePut('m1', false);
    expect(lastQueuePutRefused('m1')).toBe(true);

    recordQueuePut('m1', true);
    expect(lastQueuePutRefused('m1')).toBe(false);
  });

  it('keeps a mark through more refused saves, and marks only the session refused', () => {
    recordQueuePut('m2', false);
    recordQueuePut('m2', false);
    recordQueuePut('m3', true);

    expect(lastQueuePutRefused('m2')).toBe(true);
    expect(lastQueuePutRefused('m3')).toBe(false);
    expect(lastQueuePutRefused('never-saved')).toBe(false);
  });

  it('remembers at most a thousand sessions, forgetting the oldest mark first', () => {
    for (let n = 0; n < 1_001; n += 1) recordQueuePut(`flood-${n}`, false);

    expect(lastQueuePutRefused('flood-0')).toBe(false);
    expect(lastQueuePutRefused('flood-1')).toBe(true);
    expect(lastQueuePutRefused('flood-1000')).toBe(true);
  });
});

describe('a refused save is keyed by the session it saves, and cleared by its own window (P4-32 M3)', () => {
  it('a mark made under an old id blocks a central that writes the re-keyed id, and the new id clears it', () => {
    live.aliases.set('old-key', 'new-key');

    recordQueuePut('old-key', false);
    expect(lastQueuePutRefused('new-key')).toBe(true);
    expect(lastQueuePutRefused('old-key')).toBe(true);

    recordQueuePut('new-key', true);
    expect(lastQueuePutRefused('old-key')).toBe(false);
    expect(lastQueuePutRefused('new-key')).toBe(false);
  });

  it('another window’s accepted save does not clear the window whose save was refused', () => {
    recordQueuePut('k1', false, 'win-A');
    recordQueuePut('k1', true, 'win-B');
    expect(lastQueuePutRefused('k1')).toBe(true);

    recordQueuePut('k1', true, 'win-A');
    expect(lastQueuePutRefused('k1')).toBe(false);
  });

  it('keeps the session marked until every window that was refused has saved', () => {
    recordQueuePut('k2', false, 'win-A');
    recordQueuePut('k2', false, 'win-B');

    recordQueuePut('k2', true, 'win-A');
    expect(lastQueuePutRefused('k2')).toBe(true);
    recordQueuePut('k2', true, 'win-B');
    expect(lastQueuePutRefused('k2')).toBe(false);
  });

  it('a save whose window is not named clears the session, as before', () => {
    recordQueuePut('k3', false, 'win-A');
    recordQueuePut('k3', true);
    expect(lastQueuePutRefused('k3')).toBe(false);
  });
});
