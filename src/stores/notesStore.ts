/**
 * Per-session notes cache for the NOTES tab.
 *
 * The NOTES tab mounts on demand, so its component state can't back the count
 * badge in the tab bar — the badge has to be right before the tab is ever
 * opened. Notes themselves live server-side (SQLite, shared across clients), so
 * this store is a cache of `/api/db/sessions/:id/notes`, never the source of
 * truth: every mutation goes through the API and only lands here once the
 * server accepted it.
 */
import { create } from 'zustand';
import { authFetch } from '@/hooks/useAuth';
import type { DbNoteRow } from '@/types';

export interface SessionNote {
  id: number;
  sessionId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** Stable empty array so selectors don't hand React a new identity each render. */
export const EMPTY_NOTES: SessionNote[] = [];

/** The API speaks snake_case SQLite rows; the UI speaks camelCase. */
function fromRow(row: DbNoteRow): SessionNote {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isNoteRow(row: unknown): row is DbNoteRow {
  return typeof (row as DbNoteRow | null)?.id === 'number';
}

/** Newest first — the order the NOTES tab lists them in. */
const byNewest = (a: SessionNote, b: SessionNote): number => b.createdAt - a.createdAt;

export interface UploadedMedia {
  id: string;
  url: string;
  mime: string;
  bytes: number;
}

interface NotesState {
  /** sessionId → notes, newest first. Absent until loaded for that session. */
  notes: Map<string, SessionNote[]>;
  /** Fetch the session's notes into the cache. Resolves false on any failure. */
  loadNotes: (sessionId: string) => Promise<boolean>;
  /** Persist a new note, then prepend it. Resolves false on any failure. */
  addNote: (sessionId: string, text: string) => Promise<boolean>;
  /** Persist an edit in place, keeping list order. Resolves false on failure. */
  updateNote: (sessionId: string, noteId: number, text: string) => Promise<boolean>;
  /** Delete a note server-side, then drop it. Resolves false on any failure. */
  deleteNote: (sessionId: string, noteId: number) => Promise<boolean>;
  /**
   * Upload one image/video and return its stored URL. Media is persisted
   * immediately — before the note is saved — so the editor can insert a real
   * URL at the caret; unreferenced uploads are swept server-side after an hour.
   */
  uploadMedia: (
    sessionId: string,
    file: { name: string; dataUrl: string },
  ) => Promise<{ ok: true; media: UploadedMedia } | { ok: false; error: string }>;
}

function setSessionNotes(
  notes: Map<string, SessionNote[]>,
  sessionId: string,
  next: SessionNote[],
): Map<string, SessionNote[]> {
  const copy = new Map(notes);
  copy.set(sessionId, next);
  return copy;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: new Map(),

  loadNotes: async (sessionId) => {
    if (!sessionId) return false;
    try {
      const resp = await authFetch(
        `/api/db/sessions/${encodeURIComponent(sessionId)}/notes`,
      );
      if (!resp.ok) return false;
      const data: unknown = await resp.json();
      // The endpoint returns a bare row array; tolerate a wrapped shape too.
      const rows: unknown[] = Array.isArray(data)
        ? data
        : ((data as { notes?: unknown[] } | null)?.notes ?? []);
      const parsed = rows.filter(isNoteRow).map(fromRow).sort(byNewest);
      set((s) => ({ notes: setSessionNotes(s.notes, sessionId, parsed) }));
      return true;
    } catch {
      return false;
    }
  },

  addNote: async (sessionId, text) => {
    const trimmed = text.trim();
    if (!sessionId || !trimmed) return false;
    try {
      const resp = await authFetch(
        `/api/db/sessions/${encodeURIComponent(sessionId)}/notes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed }),
        },
      );
      if (!resp.ok) return false;
      const row: unknown = await resp.json();
      // The POST echoes the inserted row, so the list stays current without a
      // second round-trip; an unexpected body falls back to a full reload.
      if (!isNoteRow(row)) return get().loadNotes(sessionId);
      set((s) => ({
        notes: setSessionNotes(s.notes, sessionId, [
          fromRow(row),
          ...(s.notes.get(sessionId) ?? EMPTY_NOTES),
        ]),
      }));
      return true;
    } catch {
      return false;
    }
  },

  updateNote: async (sessionId, noteId, text) => {
    const trimmed = text.trim();
    if (!sessionId || !trimmed) return false;
    try {
      const resp = await authFetch(`/api/db/notes/${noteId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (!resp.ok) return false;
      const row: unknown = await resp.json();
      if (!isNoteRow(row)) return get().loadNotes(sessionId);
      const updated = fromRow(row);
      set((s) => {
        const existing = s.notes.get(sessionId);
        if (!existing) return s;
        // Replace in place: an edit must not reshuffle the list under the
        // cursor, and `createdAt` (which drives the order) hasn't changed.
        return {
          notes: setSessionNotes(
            s.notes,
            sessionId,
            existing.map((n) => (n.id === noteId ? updated : n)),
          ),
        };
      });
      return true;
    } catch {
      return false;
    }
  },

  uploadMedia: async (sessionId, file) => {
    if (!sessionId) return { ok: false, error: 'No session' };
    try {
      const resp = await authFetch(
        `/api/db/sessions/${encodeURIComponent(sessionId)}/note-media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, dataUrl: file.dataUrl }),
        },
      );
      const body: unknown = await resp.json().catch(() => null);
      if (!resp.ok) {
        const msg = (body as { error?: string } | null)?.error;
        return { ok: false, error: msg || 'Upload failed' };
      }
      const media = body as UploadedMedia | null;
      if (!media?.url) return { ok: false, error: 'Upload failed' };
      return { ok: true, media };
    } catch {
      return { ok: false, error: 'Network error during upload' };
    }
  },

  deleteNote: async (sessionId, noteId) => {
    try {
      // Route is /api/db/notes/:id — notes are deleted by row id, NOT nested
      // under the session (a session-nested URL 404s and the note survives).
      const resp = await authFetch(`/api/db/notes/${noteId}`, { method: 'DELETE' });
      if (!resp.ok) return false;
      set((s) => {
        const existing = s.notes.get(sessionId);
        if (!existing) return s;
        return {
          notes: setSessionNotes(
            s.notes,
            sessionId,
            existing.filter((n) => n.id !== noteId),
          ),
        };
      });
      return true;
    } catch {
      return false;
    }
  },
}));
