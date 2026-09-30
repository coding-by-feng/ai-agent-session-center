/**
 * The REAL SQLite storage path for the shared queue.
 *
 * The codec tests cover encode/decode in isolation; this covers that the
 * table, the prepared statements and the cascade actually work against a live
 * better-sqlite3 database — the integration the codec tests cannot reach.
 *
 * `APP_USER_DATA` is redirected to a throwaway directory BEFORE importing
 * db.ts, because db.ts resolves its path and opens the database at module
 * scope. Without that, this suite would read and write the user's real
 * sessions.db.
 *
 * The better-sqlite3 native binding is usually built for ELECTRON's ABI (any
 * `electron:build` leaves it that way), where it cannot load under system
 * Node. Like `test/dbMigrateSession.test.ts`, these skip in that case rather
 * than failing the run. To actually execute them:
 *
 *     npm rebuild better-sqlite3     # switch the binding to the Node ABI
 *     npx vitest run test/sessionQueueDb.test.ts
 *     npm run electron:rebuild       # put it back for the app
 *
 * Unlike the sibling suite, the catch below re-throws anything that is NOT an
 * ABI mismatch. A bare `catch { db = null }` silently converts ANY import
 * failure into a skip — including a typo in the import path, which is exactly
 * how an earlier revision of this file "passed" by skipping 8/8 forever.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP = mkdtempSync(join(tmpdir(), 'aasc-queue-db-'));
process.env.APP_USER_DATA = TMP;

let db: typeof import('../server/db.js') | null = null;

const SID = 'queue-test-session';
const SID2 = 'queue-test-session-2';

beforeAll(async () => {
  try {
    db = await import('../server/db.js');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only an ABI mismatch is an acceptable reason to skip.
    if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(msg)) {
      throw err;
    }
    db = null;
  }
});

afterAll(() => {
  db?.closeDb();
  rmSync(TMP, { recursive: true, force: true });
});

describe('session_queues table (live SQLite)', () => {
  beforeEach(() => {
    if (!db) return;
    db.deleteSessionQueue(SID);
    db.deleteSessionQueue(SID2);
  });

  it('returns null for a session the server has never heard of', (ctx) => {
    if (!db) return ctx.skip();
    // Distinct from "an empty queue" — this is what makes the client seed
    // from its local IndexedDB instead of blanking a queue the user can see.
    expect(db.getSessionQueue(SID)).toBeNull();
  });

  it('persists and reads back a full queue item through SQLite', (ctx) => {
    if (!db) return ctx.skip();
    const item = {
      id: 42, sessionId: SID, text: 'run the tests', position: 0,
      createdAt: 1700000000000, type: 'loop', intervalMs: 300000,
      beforeChain: [{ id: 1, text: 'setup' }],
      images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }],
    };
    db.upsertSessionQueue(SID, [item], null);
    expect(db.getSessionQueue(SID)!.items).toEqual([item]);
  });

  it('persists automation alongside the items', (ctx) => {
    if (!db) return ctx.skip();
    const automation = { paused: true, autoSend: false, autoEnter: true };
    db.upsertSessionQueue(SID, [{ id: 1 }], automation);
    const got = db.getSessionQueue(SID)!;
    expect(got.automation).toEqual(automation);
    expect(got.items).toEqual([{ id: 1 }]);
  });

  it('upsert REPLACES rather than appending', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSessionQueue(SID, [{ id: 1 }, { id: 2 }], null);
    db.upsertSessionQueue(SID, [{ id: 3 }], null);
    expect(db.getSessionQueue(SID)!.items).toEqual([{ id: 3 }]);
  });

  it('stores an explicitly empty queue as a real record', (ctx) => {
    if (!db) return ctx.skip();
    // A clear on one device has to propagate; if this read back as null the
    // other device would re-seed and resurrect the deleted items.
    db.upsertSessionQueue(SID, [], null);
    expect(db.getSessionQueue(SID)!.items).toEqual([]);
  });

  it('keeps sessions independent', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSessionQueue(SID, [{ id: 1 }], null);
    db.upsertSessionQueue(SID2, [{ id: 2 }], null);
    expect(db.getSessionQueue(SID)!.items).toEqual([{ id: 1 }]);
    expect(db.getSessionQueue(SID2)!.items).toEqual([{ id: 2 }]);
  });

  it('getAllSessionQueues returns every queue, for one-shot boot hydration', (ctx) => {
    if (!db) return ctx.skip();
    db.upsertSessionQueue(SID, [{ id: 1 }], null);
    db.upsertSessionQueue(SID2, [{ id: 2 }], null);
    const ids = db.getAllSessionQueues().map((q) => q.sessionId);
    expect(ids).toContain(SID);
    expect(ids).toContain(SID2);
  });

  it('deleteSessionCascade drops the queue too', (ctx) => {
    if (!db) return ctx.skip();
    // session_queues has no FK to sessions (it can be written before the
    // session row exists), so without the explicit delete it would outlive
    // the session forever.
    db.upsertSessionQueue(SID, [{ id: 1 }], null);
    db.deleteSessionCascade(SID);
    expect(db.getSessionQueue(SID)).toBeNull();
  });
});
