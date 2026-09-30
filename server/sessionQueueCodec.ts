/**
 * sessionQueueCodec — JSON encode/decode for the shared per-session queue.
 *
 * Pure and import-free (no better-sqlite3, no Express) so it can be unit
 * tested directly. That matters here specifically: `server/db.ts` opens
 * better-sqlite3 at module scope, and the native binding is built for
 * Electron's ABI, so every existing server test stubs `db.js` out entirely
 * rather than loading it. Any logic left inside db.ts is therefore effectively
 * untestable — and the encode/decode step is the one part of this feature
 * where a bug silently destroys user data rather than failing loudly.
 */

/** Parsed queue record handed to callers. */
export interface SessionQueueRecord {
  sessionId: string;
  items: unknown[];
  automation: unknown | null;
  updatedAt: number;
}

/** The stored row shape. */
export interface SessionQueueRow {
  session_id: string;
  items: string;
  automation: string | null;
  updated_at: number;
}

/** Serialize for storage. Split out so encode and decode stay symmetrical. */
export function encodeQueue(
  items: unknown[],
  automation: unknown | null,
): { items: string; automation: string | null } {
  return {
    items: JSON.stringify(items),
    // `undefined` and `null` both mean "no automation recorded" — normalized
    // to SQL NULL so a round-trip can't turn one into the literal string
    // "undefined", which would then fail to parse on the way back out.
    automation: automation == null ? null : JSON.stringify(automation),
  };
}

/**
 * Parse a stored row.
 *
 * Returns null on anything malformed rather than throwing: these rows are read
 * in bulk for client hydration, and one corrupt row must not take down the
 * whole request and leave every device with no queue at all. A dropped row
 * degrades to "this session syncs from local state", which is recoverable; a
 * thrown error is not.
 */
export function decodeQueueRow(row: SessionQueueRow | undefined | null): SessionQueueRecord | null {
  if (!row) return null;
  let items: unknown;
  try {
    items = JSON.parse(row.items);
  } catch {
    return null;
  }
  // A non-array `items` would break every consumer downstream (they all map
  // or spread it), so it is rejected here rather than propagated.
  if (!Array.isArray(items)) return null;

  let automation: unknown = null;
  if (row.automation != null) {
    try {
      automation = JSON.parse(row.automation);
    } catch {
      // Malformed automation alone does NOT discard the row — the items are
      // the valuable part, and losing a paused flag is far cheaper than
      // losing a queue of prompts.
      automation = null;
    }
  }

  return {
    sessionId: row.session_id,
    items,
    automation,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
  };
}
