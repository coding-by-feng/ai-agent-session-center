// queueSent.ts — which prompts the prompt queue sent, kept on the Mac (AASC-20).
//
// The CONVERSATION tab badges a prompt that the queue sent. That record lived in
// each browser's localStorage, so the phone never saw the badge for prompts the
// Mac's queue sent. The Mac now keeps it: the sender posts each send, and every
// window reads the records for the session it shows.
//
// Records carry prompt text, so they are per session: a remote device reads them
// only through `/sessions/:id/…` (the visibility gate) and the live
// `queue_sent` broadcast is skipped for devices the session is hidden from. A
// record stays with the session across a re-key (term-* → Claude's id, resume):
// it is read back by resolving the id it was stored under.
//
// Matching stays in src/lib/queueSentLog.ts (text head + time window); this
// module only stores what the client would have kept, normalized the same way.

import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { appendQueueSent, QUEUE_SENT_CAP, type QueueSent } from '../src/lib/queueSentLog.js';

export interface QueueSentRecord extends QueueSent {
  sessionId: string;
}

export interface QueueSentStore {
  add(rec: QueueSentRecord): void;
  all(): QueueSentRecord[];
}

/** Keep only the newest records overall; the badge is a hint, not a history. */
export const QUEUE_SENT_KEEP = QUEUE_SENT_CAP * 4;

export function memoryQueueSentStore(): QueueSentStore {
  let rows: QueueSentRecord[] = [];
  return {
    add: (rec) => { rows = [...rows, { ...rec }].slice(-QUEUE_SENT_KEEP); },
    all: () => rows.map((r) => ({ ...r })),
  };
}

export function sqliteQueueSentStore(db: Database.Database): QueueSentStore {
  db.exec(`CREATE TABLE IF NOT EXISTS queue_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  )`);
  const insert = db.prepare('INSERT INTO queue_sent (session_id, text, sent_at) VALUES (?, ?, ?)');
  const prune = db.prepare('DELETE FROM queue_sent WHERE id <= (SELECT MAX(id) FROM queue_sent) - ?');
  const all = db.prepare('SELECT session_id, text, sent_at FROM queue_sent ORDER BY id');
  return {
    add: (rec) => {
      insert.run(rec.sessionId, rec.text, rec.sentAt);
      prune.run(QUEUE_SENT_KEEP);
    },
    all: () => (all.all() as Array<{ session_id: string; text: string; sent_at: number }>)
      .map((r) => ({ sessionId: r.session_id, text: r.text, sentAt: r.sent_at })),
  };
}

const sentSchema = z.object({
  text: z.string().min(1).max(256 * 1024),
  sentAt: z.number().int().positive().optional(),
});

export interface QueueSentRouterDeps {
  /** The store, opened on first use (the SQLite handle may not exist at import time). */
  store: () => QueueSentStore;
  /** The id a stored session id now goes by (term-* → Claude's id), or itself. */
  resolveSessionId: (sessionId: string) => string;
  broadcast: (msg: { sessionId: string; text: string; sentAt: number }) => void;
  now?: () => number;
}

/**
 * Mounted on the API router AFTER its `/sessions/:id` visibility gate, so a
 * remote device can neither read nor add records for a session it can't see.
 */
export function createQueueSentRouter(deps: QueueSentRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;

  router.get('/sessions/:id/queue/sent', (req, res) => {
    const target = deps.resolveSessionId(String(req.params.id));
    const sent = deps.store().all()
      .filter((r) => r.sessionId === target || deps.resolveSessionId(r.sessionId) === target)
      .slice(-QUEUE_SENT_CAP)
      .map(({ text, sentAt }) => ({ text, sentAt }));
    res.json({ success: true, sent });
  });

  router.post('/sessions/:id/queue/sent', (req, res) => {
    const body = sentSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ success: false, error: 'A send needs its text' }); return; }
    // The same normalization and head cut the client applies, so stored records
    // match exactly as the per-device log did.
    const [rec] = appendQueueSent([], { text: body.data.text, sentAt: body.data.sentAt ?? now() });
    if (!rec) { res.json({ success: true, stored: false }); return; }
    const sessionId = deps.resolveSessionId(String(req.params.id));
    deps.store().add({ sessionId, ...rec });
    deps.broadcast({ sessionId, ...rec });
    res.json({ success: true, stored: true });
  });

  return router;
}
