/**
 * Translation log persistence helpers.
 *
 * Backs the REVIEW tab. Records are created when the user clicks any of the
 * four select-to-translate buttons (spawn time) and updated with the captured
 * AI response when the corresponding floating session is closed.
 */
import { db, type DbTranslationLog } from './db';
import { stripAnsi } from './ansi';

const RESPONSE_CAP_BYTES = 256 * 1024; // safety cap so IndexedDB stays small

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — sufficient for client-only ids
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type NewTranslationLog = Omit<
  DbTranslationLog,
  'id' | 'uuid' | 'response' | 'notes' | 'archived' | 'createdAt' | 'updatedAt'
> & { uuid?: string };

/** Create a draft log with no captured response. Returns the assigned uuid. */
export async function createLog(input: NewTranslationLog): Promise<string> {
  const now = Date.now();
  const id = input.uuid ?? uuid();
  await db.translationLogs.add({
    ...input,
    uuid: id,
    response: '',
    notes: '',
    archived: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Find by uuid (the stable id we use across spawn-time and close-time). */
export async function findByUuid(uuidValue: string): Promise<DbTranslationLog | undefined> {
  return db.translationLogs.where('uuid').equals(uuidValue).first();
}

/** Find by the floating terminal id (used when the float is closed). */
export async function findByFloatTerminalId(terminalId: string): Promise<DbTranslationLog | undefined> {
  return db.translationLogs.where('floatTerminalId').equals(terminalId).first();
}

/** Patch fields on an existing log. */
export async function updateLog(uuidValue: string, patch: Partial<DbTranslationLog>): Promise<void> {
  const row = await findByUuid(uuidValue);
  if (!row || row.id === undefined) return;
  await db.translationLogs.update(row.id, { ...patch, updatedAt: Date.now() });
}

/**
 * Capture a response from raw terminal output. Strips ANSI, trims whitespace,
 * caps the size, and persists to the matching log entry (looked up by
 * floatTerminalId).
 */
export async function captureResponse(floatTerminalId: string, rawOutput: string): Promise<void> {
  const row = await findByFloatTerminalId(floatTerminalId);
  if (!row || row.id === undefined) return;
  const cleaned = stripAnsi(rawOutput).trim();
  const capped = cleaned.length > RESPONSE_CAP_BYTES
    ? cleaned.slice(cleaned.length - RESPONSE_CAP_BYTES)
    : cleaned;
  await db.translationLogs.update(row.id, {
    response: capped,
    updatedAt: Date.now(),
  });
}

export interface ListFilters {
  mode?: DbTranslationLog['mode'] | 'all';
  archived?: 'all' | 'active' | 'archived';
  originSessionId?: string;
  search?: string;
}

/** List logs matching filters, newest first. */
export async function listLogs(filters: ListFilters = {}): Promise<DbTranslationLog[]> {
  let collection = db.translationLogs.orderBy('createdAt').reverse();
  if (filters.mode && filters.mode !== 'all') {
    collection = collection.filter((row) => row.mode === filters.mode);
  }
  if (filters.archived === 'active') {
    collection = collection.filter((row) => row.archived === 0);
  } else if (filters.archived === 'archived') {
    collection = collection.filter((row) => row.archived === 1);
  }
  if (filters.originSessionId) {
    collection = collection.filter((row) => row.originSessionId === filters.originSessionId);
  }
  const rows = await collection.toArray();
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase();
    return rows.filter((row) =>
      row.selection.toLowerCase().includes(q) ||
      row.response.toLowerCase().includes(q) ||
      row.contextLine.toLowerCase().includes(q) ||
      row.notes.toLowerCase().includes(q) ||
      row.filePath.toLowerCase().includes(q),
    );
  }
  return rows;
}

export async function setArchived(uuidValue: string, archived: boolean): Promise<void> {
  await updateLog(uuidValue, { archived: archived ? 1 : 0 });
}

export async function setNotes(uuidValue: string, notes: string): Promise<void> {
  await updateLog(uuidValue, { notes });
}

export async function deleteLog(uuidValue: string): Promise<void> {
  const row = await findByUuid(uuidValue);
  if (!row || row.id === undefined) return;
  await db.translationLogs.delete(row.id);
}
