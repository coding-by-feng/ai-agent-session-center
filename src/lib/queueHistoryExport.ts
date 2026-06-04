/**
 * Queue-history export / import — pure serialization + validation helpers.
 *
 * Lives apart from the Zustand store so the format and parser can be unit-
 * tested without spinning up React or Dexie. The store layer reads bytes
 * from a File and entries from memory; everything in between is here.
 *
 * File envelope:
 *   {
 *     schema:     'aasc-queue-history',
 *     version:    1,
 *     exportedAt: ISO 8601 UTC string,
 *     count:      number,
 *     entries:    Array<ExportedEntry>
 *   }
 *
 * Each ExportedEntry mirrors a QueueHistoryEntry minus its database `id`
 * (re-minted on import so two devices' histories don't collide).
 */

import type { QueueItem } from '@/stores/queueStore';
import type { QueueHistoryEntry } from '@/stores/queueHistoryStore';

export const EXPORT_SCHEMA = 'aasc-queue-history';
export const EXPORT_VERSION = 1;
/** Hard cap on file size accepted at import (uncompressed JSON, byte length).
 *  50 MB is generous for ~500 entries with screenshots. */
export const MAX_IMPORT_SIZE = 50 * 1024 * 1024;

export interface ExportedEntry {
  alias?: string;
  item: QueueItem;
  sourceSessionTitle?: string;
  sourceSessionId?: string;
  usedCount: number;
  createdAt: number;
  lastUsedAt?: number | null;
}

export interface ExportedFile {
  schema: typeof EXPORT_SCHEMA;
  version: number;
  exportedAt: string;
  count: number;
  entries: ExportedEntry[];
}

export type ImportResult =
  | { ok: true; file: ExportedFile; skipped: number }
  | { ok: false; error: ImportError };

export type ImportError =
  | 'too-large'
  | 'invalid-json'
  | 'wrong-schema'
  | 'newer-version'
  | 'malformed';

/**
 * Serialize a list of in-memory QueueHistoryEntry to a JSON string ready
 * for download. Strips the DB `id` so re-importing the file mints fresh ids.
 */
export function serializeEntries(entries: QueueHistoryEntry[]): string {
  const exported: ExportedFile = {
    schema: EXPORT_SCHEMA,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries: entries.map((e) => ({
      alias: e.alias ?? undefined,
      item: e.item,
      sourceSessionTitle: e.sourceSessionTitle ?? undefined,
      sourceSessionId: e.sourceSessionId ?? undefined,
      usedCount: e.usedCount,
      createdAt: e.createdAt,
      lastUsedAt: e.lastUsedAt ?? undefined,
    })),
  };
  return JSON.stringify(exported, null, 2);
}

/** Default download filename derived from the current date. */
export function defaultExportFilename(now: Date = new Date()): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `queue-history-${yyyy}-${mm}-${dd}.json`;
}

/**
 * Parse a JSON string read from an imported file. Returns either:
 * - `{ ok: true, file, skipped }` with the validated envelope (skipped =
 *   per-entry rows we silently dropped because they were missing required
 *   fields, e.g. text/createdAt/item), or
 * - `{ ok: false, error }` with a structured error so the UI can show a
 *   meaningful toast.
 */
export function parseImportFile(text: string, byteLength?: number): ImportResult {
  if (byteLength != null && byteLength > MAX_IMPORT_SIZE) {
    return { ok: false, error: 'too-large' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'malformed' };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schema !== EXPORT_SCHEMA) {
    return { ok: false, error: 'wrong-schema' };
  }
  if (typeof obj.version !== 'number') {
    return { ok: false, error: 'malformed' };
  }
  if (obj.version > EXPORT_VERSION) {
    return { ok: false, error: 'newer-version' };
  }
  if (!Array.isArray(obj.entries)) {
    return { ok: false, error: 'malformed' };
  }

  const validEntries: ExportedEntry[] = [];
  let skipped = 0;
  for (const rawEntry of obj.entries) {
    const entry = coerceEntry(rawEntry);
    if (entry) validEntries.push(entry);
    else skipped++;
  }

  const file: ExportedFile = {
    schema: EXPORT_SCHEMA,
    version: obj.version,
    exportedAt:
      typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date(0).toISOString(),
    count: validEntries.length,
    entries: validEntries,
  };
  return { ok: true, file, skipped };
}

/**
 * Validate + normalize a single entry. Returns null when required fields are
 * missing so the caller can count it as "skipped" rather than failing the
 * whole import on one bad row.
 */
function coerceEntry(raw: unknown): ExportedEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const item = obj.item;
  if (!item || typeof item !== 'object') return null;
  const itemObj = item as Record<string, unknown>;
  if (typeof itemObj.text !== 'string' || itemObj.text.length === 0) return null;
  if (typeof itemObj.createdAt !== 'number') return null;

  // Heal loop entries with a missing/invalid interval so they aren't deleted
  // on first fire after import. Sanitize rather than reject — the prompt text
  // is the valuable part; the interval just falls back to the 60s default.
  if (itemObj.type === 'loop') {
    const iv = itemObj.intervalMs;
    if (typeof iv !== 'number' || !Number.isFinite(iv) || iv <= 0) {
      itemObj.intervalMs = 60_000;
    }
  }

  const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : itemObj.createdAt;
  const usedCount = typeof obj.usedCount === 'number' ? obj.usedCount : 0;
  const lastUsedAt =
    typeof obj.lastUsedAt === 'number'
      ? obj.lastUsedAt
      : obj.lastUsedAt === null
        ? null
        : undefined;
  const sourceSessionTitle =
    typeof obj.sourceSessionTitle === 'string' ? obj.sourceSessionTitle : undefined;
  const sourceSessionId =
    typeof obj.sourceSessionId === 'string' ? obj.sourceSessionId : undefined;
  const alias =
    typeof obj.alias === 'string' && obj.alias.trim().length > 0
      ? obj.alias
      : undefined;

  return {
    alias,
    item: itemObj as unknown as QueueItem,
    sourceSessionTitle,
    sourceSessionId,
    usedCount,
    createdAt,
    lastUsedAt,
  };
}

/**
 * Trigger a browser download of `text` as `filename`. Lives here (not in the
 * React layer) so non-React code paths can reuse it.
 */
export function downloadAsFile(text: string, filename: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser has a chance to start the download. 1s is
  // arbitrary but matches the pattern most file-saver libraries use.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
