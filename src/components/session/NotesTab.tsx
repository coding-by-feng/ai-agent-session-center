/**
 * NotesTab — per-session notes: compose, list, edit in place, delete.
 *
 * The list lives in `notesStore` rather than component state: this tab mounts
 * on demand, but the count badge on the NOTES tab has to be right before it is
 * ever opened. Note bodies are Markdown, rendered by the lazily-loaded
 * `NoteMarkdown`; both editors are the same `NoteEditor`.
 */
import { Suspense, lazy, useState, useCallback, useEffect } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { useNotesStore, EMPTY_NOTES } from '@/stores/notesStore';
import NoteEditor from './NoteEditor';
import styles from '@/styles/modules/DetailPanel.module.css';

// See NoteMarkdown's header: this boundary is what keeps the react-markdown
// stack out of the eager entry chunk that DetailPanel (and so NotesTab) is in.
const NoteMarkdown = lazy(() => import('./NoteMarkdown'));

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

interface NotesTabProps {
  sessionId: string;
  projectPath?: string;
}

export default function NotesTab({ sessionId, projectPath }: NotesTabProps) {
  // Already sorted newest-first by the store — never re-sort here, that would
  // mutate the stored array in place.
  const notes = useNotesStore((s) => s.notes.get(sessionId) ?? EMPTY_NOTES);
  const [loadError, setLoadError] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  // #5: Load notes with error feedback. Used by the retry link; the mount load
  // has its own copy so it can ignore a response that arrives after the user
  // has already switched sessions.
  const loadNotes = useCallback(async () => {
    const ok = await useNotesStore.getState().loadNotes(sessionId);
    setLoadError(!ok);
    if (!ok) showToast('Failed to load notes', 'error');
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void useNotesStore.getState().loadNotes(sessionId).then((ok) => {
      if (cancelled) return;
      setLoadError(!ok);
      if (!ok) showToast('Failed to load notes', 'error');
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // An edit open on one session must not survive into another — derived rather
  // than reset in an effect, which also closes the editor if the note it points
  // at disappears (deleted here, or by another client viewing the same session).
  const activeEditId = notes.some((n) => n.id === editingId) ? editingId : null;

  const handleCreate = useCallback(
    async (text: string) => {
      const ok = await useNotesStore.getState().addNote(sessionId, text);
      if (!ok) showToast('Failed to save note', 'error');
      return ok;
    },
    [sessionId],
  );

  const handleUpdate = useCallback(
    async (noteId: number, text: string) => {
      const ok = await useNotesStore.getState().updateNote(sessionId, noteId, text);
      if (ok) {
        setEditingId(null);
      } else {
        showToast('Failed to update note', 'error');
      }
      return ok;
    },
    [sessionId],
  );

  const handleDelete = useCallback(
    async (noteId: number) => {
      const ok = await useNotesStore.getState().deleteNote(sessionId, noteId);
      if (!ok) showToast('Failed to delete note', 'error');
    },
    [sessionId],
  );

  return (
    <div>
      {/* Compose area */}
      <div className={styles.notesCompose}>
        <NoteEditor
          sessionId={sessionId}
          projectPath={projectPath}
          onSubmit={handleCreate}
          clearOnSubmit
        />
      </div>

      {/* Notes list */}
      {notes.length > 0 ? (
        notes.map((note) => (
          <div key={note.id} className={styles.noteEntry}>
            <div className={styles.noteMeta}>
              <span className={styles.noteTime}>
                {formatTime(note.createdAt)}
                {note.updatedAt > note.createdAt && (
                  <span className={styles.noteEdited}> · edited {formatTime(note.updatedAt)}</span>
                )}
              </span>
              {activeEditId !== note.id && (
                <span className={styles.noteActions}>
                  <button
                    className={styles.noteAction}
                    onClick={() => setEditingId(note.id)}
                    title="Edit note"
                  >
                    EDIT
                  </button>
                  <button
                    className={styles.noteDelete}
                    onClick={() => handleDelete(note.id)}
                    title="Delete note"
                  >
                    DELETE
                  </button>
                </span>
              )}
            </div>
            {activeEditId === note.id ? (
              <NoteEditor
                // Remount per note so the editor starts from that note's text.
                key={`edit-${note.id}`}
                sessionId={sessionId}
                projectPath={projectPath}
                initialText={note.text}
                submitLabel="SAVE"
                onSubmit={(text) => handleUpdate(note.id, text)}
                onCancel={() => setEditingId(null)}
                autoFocus
              />
            ) : (
              <Suspense fallback={<div className={styles.noteText}>{note.text}</div>}>
                <NoteMarkdown text={note.text} projectPath={projectPath} />
              </Suspense>
            )}
          </div>
        ))
      ) : loadError ? (
        <div className={styles.tabEmpty}>Failed to load notes — <button onClick={loadNotes} style={{ background: 'none', border: 'none', color: 'var(--accent-cyan)', cursor: 'pointer', fontFamily: 'inherit' }}>retry</button></div>
      ) : (
        <div className={styles.tabEmpty}>No notes yet</div>
      )}
    </div>
  );
}
