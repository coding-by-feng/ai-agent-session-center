/**
 * The one note editor — used by both the compose box at the top of the NOTES
 * tab and the in-place edit of an existing note.
 *
 * Deliberately a single component for both mount points. The prompt queue has a
 * documented scar from the alternative (a second, "lighter" in-row editor that
 * rendered as an unusable sliver with a clipped dropdown); a note editor
 * carrying a WRITE/PREVIEW toggle, paste-to-upload and attachment chips would
 * go the same way if it were reimplemented inline.
 */
import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { useNotesStore } from '@/stores/notesStore';
import {
  fileToDataUrl,
  insertAtCaret,
  mediaFilesFrom,
  mediaMarkdown,
} from '@/lib/noteMedia';
import styles from '@/styles/modules/DetailPanel.module.css';

// Same lazy boundary as the rendered note — see NoteMarkdown's header comment.
const NoteMarkdown = lazy(() => import('./NoteMarkdown'));

interface NoteEditorProps {
  sessionId: string;
  projectPath?: string;
  /** Starting text — non-empty when editing an existing note. */
  initialText?: string;
  placeholder?: string;
  submitLabel?: string;
  busyLabel?: string;
  /** Return true if the text was accepted; the editor clears/closes only then. */
  onSubmit: (text: string) => Promise<boolean>;
  /** Present in edit mode; renders a CANCEL button and enables Esc. */
  onCancel?: () => void;
  /** Compose mode clears itself after a successful save; edit mode closes instead. */
  clearOnSubmit?: boolean;
  autoFocus?: boolean;
}

type Mode = 'write' | 'preview';

export default function NoteEditor({
  sessionId,
  projectPath,
  initialText = '',
  placeholder = 'Add a note...  (Markdown supported — paste or drop an image/video)',
  submitLabel = 'SAVE NOTE',
  busyLabel = 'SAVING...',
  onSubmit,
  onCancel,
  clearOnSubmit = false,
  autoFocus = false,
}: NoteEditorProps) {
  const [text, setText] = useState(initialText);
  /** Mirrors `text` so sequential uploads can each build on the previous insert. */
  const textRef = useRef(initialText);
  const [mode, setMode] = useState<Mode>('write');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = saving || uploading > 0;

  /**
   * Upload each file and drop its Markdown at the caret. Media is persisted
   * before the note is — an upload the user never saves is reclaimed by the
   * server's orphan sweep, which is far cheaper than holding bytes in memory
   * until submit.
   */
  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading((n) => n + files.length);
      try {
        for (const file of files) {
          try {
            const dataUrl = await fileToDataUrl(file);
            const result = await useNotesStore
              .getState()
              .uploadMedia(sessionId, { name: file.name, dataUrl });
            if (!result.ok) {
              showToast(result.error, 'error');
              continue;
            }
            // Read the current text from a ref, not from state: this loop
            // uploads files one after another and each insert must build on the
            // previous one. (Doing it in a setText updater would work but puts
            // the caret side-effect inside a function React may call twice.)
            const caret = textareaRef.current?.selectionStart ?? textRef.current.length;
            const next = insertAtCaret(
              textRef.current,
              caret,
              mediaMarkdown(file.name, result.media.url),
            );
            textRef.current = next.text;
            setText(next.text);
            // Put the caret after the inserted block once React has painted,
            // otherwise the next paste lands at position 0.
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (el) {
                el.focus();
                el.setSelectionRange(next.caret, next.caret);
              }
            });
          } catch {
            showToast(`Could not read ${file.name}`, 'error');
          } finally {
            setUploading((n) => Math.max(0, n - 1));
          }
        }
      } catch {
        setUploading(0);
      }
    },
    [sessionId],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = mediaFilesFrom(e.clipboardData?.files);
      if (files.length === 0) return;
      // Only swallow the event when we actually took the files, so pasting
      // text alongside an image still works.
      e.preventDefault();
      void attachFiles(files);
    },
    [attachFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const files = mediaFilesFrom(e.dataTransfer?.files);
      setDragging(false);
      if (files.length === 0) return;
      e.preventDefault();
      void attachFiles(files);
    },
    [attachFiles],
  );

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setSaving(true);
    try {
      const ok = await onSubmit(trimmed);
      if (ok && clearOnSubmit) {
        textRef.current = '';
        setText('');
        setMode('write');
      }
    } finally {
      setSaving(false);
    }
  }, [text, busy, onSubmit, clearOnSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSubmit();
        return;
      }
      if (e.key === 'Escape' && onCancel) {
        // Stop here: the panel's own Escape handler would otherwise close
        // search / exit maximized while the user only meant "cancel this edit".
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    },
    [handleSubmit, onCancel],
  );

  return (
    <div className={styles.noteEditor}>
      <div className={styles.noteEditorTabs}>
        <button
          type="button"
          className={`${styles.noteEditorTab}${mode === 'write' ? ` ${styles.noteEditorTabActive}` : ''}`}
          onClick={() => setMode('write')}
        >
          WRITE
        </button>
        <button
          type="button"
          className={`${styles.noteEditorTab}${mode === 'preview' ? ` ${styles.noteEditorTabActive}` : ''}`}
          onClick={() => setMode('preview')}
          disabled={!text.trim()}
          title={text.trim() ? 'Preview rendered Markdown' : 'Nothing to preview yet'}
        >
          PREVIEW
        </button>
        <span className={styles.noteEditorHint}>⌘⏎ save{onCancel ? ' · Esc cancel' : ''}</span>
      </div>

      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          className={`${styles.noteTextarea}${dragging ? ` ${styles.noteTextareaDrop}` : ''}`}
          placeholder={placeholder}
          rows={4}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            textRef.current = e.target.value;
            setText(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={() => setDragging(false)}
        />
      ) : (
        <div className={styles.notePreview}>
          <Suspense fallback={<div className={styles.tabEmpty}>Loading preview…</div>}>
            <NoteMarkdown text={text} projectPath={projectPath} />
          </Suspense>
        </div>
      )}

      <div className={styles.noteEditorActions}>
        {uploading > 0 && (
          <span className={styles.noteUploading}>
            Uploading {uploading} file{uploading === 1 ? '' : 's'}…
          </span>
        )}
        {onCancel && (
          <button className={styles.ctrlBtn} onClick={onCancel} disabled={saving}>
            CANCEL
          </button>
        )}
        <button
          className={`${styles.ctrlBtn} ${styles.saveNote}`}
          onClick={handleSubmit}
          disabled={busy || !text.trim()}
        >
          {saving ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}
