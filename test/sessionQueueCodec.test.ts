/**
 * Encode/decode for the shared per-session queue.
 *
 * This is the one part of the shared-queue feature where a bug silently
 * destroys user data instead of failing loudly: a dropped field means a
 * queued prompt (or its schedule) quietly disappears on the next sync.
 *
 * It lives in its own module precisely so it can be tested — `server/db.ts`
 * opens better-sqlite3 at module scope against Electron's ABI, so every other
 * server test stubs `db.js` out entirely and cannot exercise anything left
 * inside it.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeQueue,
  decodeQueueRow,
  type SessionQueueRow,
} from '../server/sessionQueueCodec.js';

function rowFrom(items: unknown[], automation: unknown | null): SessionQueueRow {
  const enc = encodeQueue(items, automation);
  return {
    session_id: 's1',
    items: enc.items,
    automation: enc.automation,
    updated_at: 1700000000000,
  };
}

describe('encodeQueue / decodeQueueRow round-trip', () => {
  it('preserves every field of a fully-populated queue item', () => {
    // The reason items are stored as opaque JSON rather than normalized
    // columns: a normalized schema silently drops fields it doesn't know
    // about. This asserts the full QueueItem surface survives a round-trip.
    const item = {
      id: 42,
      sessionId: 's1',
      text: 'run the tests',
      position: 0,
      createdAt: 1700000000000,
      type: 'loop',
      intervalMs: 300000,
      nextFireAt: 1700000300000,
      lastFiredAt: 1699999700000,
      totalFires: 7,
      beforeChain: [{ id: 1, text: 'setup' }],
      afterChain: [{ id: 2, text: 'teardown' }],
      excludeWindows: [{ id: 1, startHHMM: '22:00', endHHMM: '07:00' }],
      execState: 'idle',
      execStepIdx: 2,
      historyId: 99,
      disabled: true,
      firstFireOfDay: '09:00',
      images: [{ name: 'shot.png', dataUrl: 'data:image/png;base64,AAAA' }],
    };
    const got = decodeQueueRow(rowFrom([item], null));
    expect(got?.items).toEqual([item]);
  });

  it('preserves an unknown future field without needing a schema change', () => {
    // The whole argument for the JSON-blob design — a field added to
    // QueueItem later must survive without touching the server.
    const item = { id: 1, text: 'x', someFieldAddedNextYear: { nested: true } };
    expect(decodeQueueRow(rowFrom([item], null))?.items).toEqual([item]);
  });

  it('round-trips the automation config', () => {
    const automation = {
      paused: true, autoSend: false, autoEnter: true, idleGuard: true,
      skipWhenPrompting: true, autoResume: false, resumeMaxRetries: 5,
      resumePrompt: 'keep going',
      loopExcludeWindows: [{ id: 3, startHHMM: '01:00', endHHMM: '05:00' }],
    };
    expect(decodeQueueRow(rowFrom([], automation))?.automation).toEqual(automation);
  });

  it('preserves item ORDER, which is the queue\'s meaning', () => {
    const items = [{ id: 1, position: 0 }, { id: 2, position: 1 }, { id: 3, position: 2 }];
    expect(decodeQueueRow(rowFrom(items, null))?.items).toEqual(items);
  });

  it('distinguishes an EMPTY queue from a missing record', () => {
    // Load-bearing: once a user clears their queue on one device, that empty
    // state must sync. If empty decoded as null, the other device would treat
    // it as "server has nothing" and re-seed its stale local copy,
    // resurrecting the items the user just deleted.
    const decoded = decodeQueueRow(rowFrom([], null));
    expect(decoded).not.toBeNull();
    expect(decoded?.items).toEqual([]);
  });

  it('returns null for a missing row', () => {
    expect(decodeQueueRow(undefined)).toBeNull();
    expect(decodeQueueRow(null)).toBeNull();
  });
});

describe('encodeQueue', () => {
  it('normalizes null and undefined automation to SQL NULL', () => {
    // Not cosmetic: JSON.stringify(undefined) is the VALUE undefined, which
    // SQLite would reject or coerce — and the string "undefined" would then
    // fail to parse coming back out.
    expect(encodeQueue([], null).automation).toBeNull();
    expect(encodeQueue([], undefined).automation).toBeNull();
  });

  it('serializes items to a parseable JSON array', () => {
    expect(JSON.parse(encodeQueue([{ id: 1 }], null).items)).toEqual([{ id: 1 }]);
  });
});

describe('decodeQueueRow — malformed input', () => {
  const base = { session_id: 's1', automation: null, updated_at: 1 };

  it('returns null rather than throwing on corrupt items JSON', () => {
    // These rows are read in BULK for client hydration; one corrupt row must
    // not throw and leave every device with no queue at all.
    expect(decodeQueueRow({ ...base, items: '{not json' })).toBeNull();
  });

  it('rejects items JSON that parses but is not an array', () => {
    // Every consumer maps/spreads `items`; a non-array would break them all
    // downstream, far from the actual cause.
    expect(decodeQueueRow({ ...base, items: '{"a":1}' })).toBeNull();
    expect(decodeQueueRow({ ...base, items: '"a string"' })).toBeNull();
    expect(decodeQueueRow({ ...base, items: 'null' })).toBeNull();
  });

  it('KEEPS the items when only the automation JSON is corrupt', () => {
    // Deliberate asymmetry: the prompts are the valuable part. Losing a
    // paused flag is far cheaper than discarding a queue of prompts.
    const decoded = decodeQueueRow({
      session_id: 's1', items: '[{"id":1}]', automation: '{bad', updated_at: 5,
    });
    expect(decoded?.items).toEqual([{ id: 1 }]);
    expect(decoded?.automation).toBeNull();
  });

  it('defaults a non-numeric updated_at to 0 instead of propagating it', () => {
    const decoded = decodeQueueRow({
      session_id: 's1', items: '[]', automation: null,
      updated_at: undefined as unknown as number,
    });
    expect(decoded?.updatedAt).toBe(0);
  });
});
