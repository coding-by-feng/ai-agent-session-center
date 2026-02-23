/**
 * NotesTab provides CRUD for session notes via API.
 * Ported from the notes tab logic in public/js/detailPanel.js.
 */
import { useState, useCallback, useEffect } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/DetailPanel.module.css';

interface Note {
  id: number;
  sessionId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

interface NotesTabProps {
  sessionId: string;
}

export default function NotesTab({ sessionId }: NotesTabProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const [loadError, setLoadError] = useState(false);

  // #5: Load notes with error feedback
  const loadNotes = useCallback(async () => {
    try {
      setLoadError(false);
      const resp = await fetch(`/api/db/sessions/${sessionId}/notes`);
      if (resp.ok) {
        const data = await resp.json();
        setNotes(data.notes || []);
      } else {
        setLoadError(true);
        showToast('Failed to load notes', 'error');
      }
    } catch {
      setLoadError(true);
      showToast('Network error loading notes', 'error');
    }
  }, [sessionId]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const handleSave = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const resp = await fetch(`/api/db/sessions/${sessionId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      });
      if (resp.ok) {
        setText('');
        await loadNotes();
      } else {
        showToast('Failed to save note', 'error');
      }
    } catch {
      showToast('Failed to save note', 'error');
    } finally {
      setSaving(false);
    }
  }, [sessionId, text, saving, loadNotes]);

  const handleDelete = useCallback(
    async (noteId: number) => {
      try {
        await fetch(`/api/db/sessions/${sessionId}/notes/${noteId}`, {
          method: 'DELETE',
        });
        await loadNotes();
      } catch {
        showToast('Failed to delete note', 'error');
      }
    },
    [sessionId, loadNotes],
  );

  return (
    <div>
      {/* Compose area */}
      <div className={styles.notesCompose}>
        <textarea
          className={styles.noteTextarea}
          placeholder="Add a note..."
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              handleSave();
            }
          }}
        />
        <button
          className={`${styles.ctrlBtn} ${styles.saveNote}`}
          onClick={handleSave}
          disabled={saving || !text.trim()}
        >
          {saving ? 'SAVING...' : 'SAVE NOTE'}
        </button>
      </div>

      {/* Notes list */}
      {notes.length > 0 ? (
        notes
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((note) => (
            <div key={note.id} className={styles.noteEntry}>
              <div className={styles.noteMeta}>
                <span className={styles.noteTime}>
                  {formatTime(note.createdAt)}
                </span>
                <button
                  className={styles.noteDelete}
                  onClick={() => handleDelete(note.id)}
                  title="Delete note"
                >
                  DELETE
                </button>
              </div>
              <div className={styles.noteText}>{note.text}</div>
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
