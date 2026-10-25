// queueWiring.ts — the server's own queue store (queueOps.ts `QueueStore`), built from the live pieces: the
// `session_queues` table and the WebSocket broadcast. A queue write is stored and then told to every window exactly as
// `PUT /sessions/:id/queue` does it (apiRouter.ts): `queue_update` with the whole list and automation, the stored
// `updatedAt`, and an origin. The origin is the central's own (`mcp:<centralId>`), so a window applies the update
// instead of mistaking it for its own echo. `broadcast` resolves the session itself and skips every remote device that
// session is hidden from.
//
// A write is refused, before anything is stored, while the AASC window's last save of that queue was refused
// (queuePutRefusals.ts, Ruling 54): the window still holds edits the server never got, and this write would replace them.
//
// Kept apart from queueOps.ts and the tools so that they stay testable without SQLite or a socket: this module imports
// both, and the tools load it only when the first queue write runs (tools/queueWriteKit.ts `serverQueueStore`), the way
// apiRouter.ts loads wsManager. test/mcp/queueWiring.test.ts mocks what it imports.

import { WS_TYPES } from '../constants.js';
import * as db from '../db.js';
import { broadcast } from '../wsManager.js';
import type { QueueAutomationLike, QueueItemLike, QueueStore } from './queueOps.js';
import { lastQueuePutRefused } from './queuePutRefusals.js';
import { ToolError } from './types.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const unsavedQueue = (): ToolError =>
  new ToolError(
    'UNAVAILABLE',
    'This queue’s last save from the AASC window failed, so AASC can’t change it safely.',
    'Open AASC and fix the queue first.',
  );

/** The queue store on the live server. */
export function serverQueueStore(): QueueStore {
  return {
    read(sessionId) {
      const record = db.getSessionQueue(sessionId);
      if (record === null) return { items: [], automation: null };
      return {
        items: record.items as QueueItemLike[],
        automation: isRecord(record.automation) ? (record.automation as QueueAutomationLike) : null,
      };
    },
    write(sessionId, items, automation, originClientId) {
      if (lastQueuePutRefused(sessionId)) throw unsavedQueue();
      const record = db.upsertSessionQueue(sessionId, items, automation);
      broadcast({
        type: WS_TYPES.QUEUE_UPDATE,
        sessionId,
        items: record.items,
        automation: record.automation,
        updatedAt: record.updatedAt,
        originClientId,
      });
    },
  };
}
