/**
 * ReviewEntry — one REVIEW entry's parts: the favourite star, its source, and
 * the expanded body (alias, source, conversation, notes, archive and delete).
 * The desktop shows the body under its row; the phone shows it full screen.
 */
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import Button from '@/components/ui/Button';
import PopupResponse from '@/components/session/PopupResponse';
import type { DbTranslationLog } from '@/lib/db';
import { NO_SOURCE, sourceTextOf, stamp } from '@/lib/reviewEntry';
import styles from '@/styles/modules/ReviewView.module.css';

/** The favourites mark: an outline star, filled while on. Sized by its button. */
export function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

/** What was selected, plus the line around it when that adds something. */
export function SourceSection({ row }: { row: DbTranslationLog }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionLabel}>Source</div>
      {row.mode === 'translate-file' && row.filePath && (
        <div className={styles.filePath}>{row.filePath}</div>
      )}
      <pre className={styles.source}>{sourceTextOf(row) || NO_SOURCE}</pre>
      {row.contextLine && row.contextLine !== row.selection && (
        <div className={styles.contextLine}>
          <span className={styles.metaLabel}>Surrounding line</span>
          {row.contextLine}
        </div>
      )}
    </div>
  );
}

export interface EntryDetailProps {
  /** Extra class on the body (the phone's full-screen sheet drops the list indent). */
  className?: string;
  row: DbTranslationLog;
  onAlias: (uuid: string, value: string) => void;
  onNotes: (uuid: string, value: string) => void;
  onArchive: (uuid: string, isArchived: boolean) => void;
  onDelete: (uuid: string) => void;
}

/** The expanded body of a row: alias, source, conversation, notes, actions. */
export function EntryDetail({ row, onAlias, onNotes, onArchive, onDelete, className }: EntryDetailProps) {
  const saved = stamp(row.createdAt);
  const updated = stamp(row.updatedAt);
  return (
    <div className={className ? `${styles.detail} ${className}` : styles.detail}>
      <label className={styles.section}>
        <span className={styles.sectionLabel}>Alias</span>
        <TextInput
          className={styles.aliasInput}
          defaultValue={row.alias}
          placeholder="Short label for this record (shown here and in the file highlight)"
          onBlur={(e) => {
            if (e.target.value.trim() !== row.alias) onAlias(row.uuid, e.target.value);
          }}
        />
      </label>

      <SourceSection row={row} />

      <PopupResponse response={row.response} label="Conversation" />

      <label className={styles.section}>
        <span className={styles.sectionLabel}>Notes</span>
        <TextArea
          className={styles.notes}
          rows={2}
          defaultValue={row.notes}
          placeholder="Personal notes for review (saved automatically)"
          onBlur={(e) => {
            if (e.target.value !== row.notes) onNotes(row.uuid, e.target.value);
          }}
        />
      </label>

      <div className={styles.actions}>
        <Button size="sm" onClick={() => onArchive(row.uuid, row.archived === 1)}>
          {row.archived === 1 ? 'Unarchive' : 'Archive'}
        </Button>
        <Button size="sm" variant="danger" onClick={() => onDelete(row.uuid)}>
          Delete
        </Button>
        <span className={styles.timestamp}>
          Saved {saved}
          {updated !== saved && ` · Updated ${updated}`}
        </span>
      </div>
    </div>
  );
}
