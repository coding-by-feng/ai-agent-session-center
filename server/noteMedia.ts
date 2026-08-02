/**
 * Storage for images/video embedded in session notes.
 *
 * Bytes live on disk under `<data dir>/note-media/`; only metadata goes in
 * SQLite (`note_media`). A note's text stores nothing but a URL
 * (`![shot.png](/api/note-media/<id>)`), so a 40 MB screen recording costs a
 * ~40-byte row instead of a 55 MB base64 blob that every notes fetch reloads.
 *
 * Deliberately NOT modelled on `/api/queue-images`: that endpoint writes to
 * /tmp and deletes anything older than 24h, which is correct for handing a path
 * to a CLI and fatal for a note you expect to read next month.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import * as db from './db.js';
import log from './logger.js';

const __noteMediaDirname = dirname(fileURLToPath(import.meta.url));
/** Mirrors db.ts: packaged Electron sets APP_USER_DATA, dev falls back to ./data. */
const DATA_DIR = process.env.APP_USER_DATA
  ? join(process.env.APP_USER_DATA, 'data')
  : join(__noteMediaDirname, '..', 'data');
export const NOTE_MEDIA_DIR = join(DATA_DIR, 'note-media');

/** Per-file ceiling. Generous enough for a short screen recording. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * An upload is only reachable once its id appears in a saved note, so anything
 * older than this with no reference is an abandoned paste. Short enough to keep
 * the directory tidy, long enough that a slowly-written note is never swept.
 */
export const ORPHAN_TTL_MS = 60 * 60 * 1000;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * MIME → file extension. Allowlist, not a blocklist: an unknown type is
 * rejected rather than guessed at.
 *
 * SVG is deliberately absent — it can carry script, and these files are served
 * same-origin, so an inline SVG would be a stored-XSS vector. Screenshots and
 * recordings are the actual use case.
 */
const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
};

/** Ids are ours (hex), never client input — this guard is what keeps `join` safe. */
const ID_RE = /^[a-f0-9]{32}$/;

const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i;

export interface SavedNoteMedia {
  id: string;
  url: string;
  mime: string;
  bytes: number;
}

export type SaveMediaError = 'invalid-data-url' | 'unsupported-type' | 'too-large' | 'write-failed';

export type SaveMediaResult =
  | { ok: true; media: SavedNoteMedia }
  | { ok: false; error: SaveMediaError };

/** Public URL for a stored media id. Kept here so the route and the client agree. */
export function noteMediaUrl(id: string): string {
  return `/api/note-media/${id}`;
}

/**
 * Decode a base64 data URL and persist it. Validates type and size *before*
 * writing, so a rejected upload never leaves a file behind.
 */
export function saveNoteMedia(
  sessionId: string,
  name: string,
  dataUrl: string,
): SaveMediaResult {
  const match = DATA_URL_RE.exec(dataUrl);
  if (!match) return { ok: false, error: 'invalid-data-url' };

  const mime = match[1].toLowerCase();
  const ext = ALLOWED_MIME[mime];
  if (!ext) return { ok: false, error: 'unsupported-type' };

  let buf: Buffer;
  try {
    buf = Buffer.from(match[2], 'base64');
  } catch {
    return { ok: false, error: 'invalid-data-url' };
  }
  if (buf.length === 0) return { ok: false, error: 'invalid-data-url' };
  if (buf.length > MAX_MEDIA_BYTES) return { ok: false, error: 'too-large' };

  const id = randomBytes(16).toString('hex');
  try {
    mkdirSync(NOTE_MEDIA_DIR, { recursive: true });
    writeFileSync(mediaPath(id, ext), buf);
  } catch (err) {
    log.error('note-media', `write failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: 'write-failed' };
  }

  db.addNoteMedia({
    id,
    session_id: sessionId,
    name: name.slice(0, 255) || null,
    mime,
    ext,
    bytes: buf.length,
    created_at: Date.now(),
  });

  return { ok: true, media: { id, url: noteMediaUrl(id), mime, bytes: buf.length } };
}

function mediaPath(id: string, ext: string): string {
  // Flat layout, filename derived only from our own hex id + an allowlisted
  // extension. Nesting under the session id would put caller-supplied text in
  // the path for no gain.
  return join(NOTE_MEDIA_DIR, `${id}.${ext}`);
}

export interface ResolvedNoteMedia {
  path: string;
  mime: string;
  name: string | null;
}

/** Locate a stored file for serving. Returns null for unknown/malformed ids. */
export function resolveNoteMedia(id: string): ResolvedNoteMedia | null {
  if (!ID_RE.test(id)) return null;
  const row = db.getNoteMedia(id);
  if (!row) return null;
  const path = mediaPath(row.id, row.ext);
  if (!existsSync(path)) return null;
  return { path, mime: row.mime, name: row.name };
}

function removeMediaFile(id: string, ext: string): void {
  try {
    rmSync(mediaPath(id, ext), { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Delete uploads that no note references and that are past the TTL.
 *
 * Editing is what makes this mandatory rather than nice-to-have: removing an
 * image from a note's text orphans its bytes immediately, so without a sweep
 * the directory only ever grows.
 */
export function sweepOrphanNoteMedia(): number {
  let removed = 0;
  try {
    const stale = db.getNoteMediaOlderThan(Date.now() - ORPHAN_TTL_MS);
    for (const row of stale) {
      if (db.isNoteMediaReferenced(row.id)) continue;
      removeMediaFile(row.id, row.ext);
      db.deleteNoteMediaRow(row.id);
      removed++;
    }
  } catch (err) {
    log.error('note-media', `sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (removed > 0) log.info('note-media', `swept ${removed} orphaned upload(s)`);
  return removed;
}

/** Drop every upload belonging to a session (used when the session is deleted). */
export function deleteNoteMediaForSession(sessionId: string): void {
  try {
    for (const row of db.getNoteMediaBySession(sessionId)) {
      removeMediaFile(row.id, row.ext);
      db.deleteNoteMediaRow(row.id);
    }
  } catch (err) {
    log.error('note-media', `session cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Total bytes on disk — surfaced for diagnostics, not used in request paths. */
export function noteMediaDiskUsage(): number {
  try {
    return db.getNoteMediaOlderThan(Number.MAX_SAFE_INTEGER).reduce((sum, row) => {
      try {
        return sum + statSync(mediaPath(row.id, row.ext)).size;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

export function startNoteMediaSweeper(): void {
  sweepOrphanNoteMedia();
  setInterval(sweepOrphanNoteMedia, SWEEP_INTERVAL_MS).unref();
}
