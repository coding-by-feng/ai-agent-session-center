/**
 * AiPopupHistory — per-session list of the AI-popup (floating translate /
 * explain / vocab) sub-sessions spawned FROM the current session. Filtered by
 * originSessionId. Mirrors the expandable-row UI from ReviewView (favorite ★,
 * alias, notes, archive, delete, copy response).
 *
 * On a phone (AASC-20) every control is a 44px target, delete confirms in a
 * sheet instead of `confirm()`, and a popup that is still running gets an Open
 * button that brings it back up in its full-height sheet.
 */
import { useCallback, useEffect, useState } from 'react';
import { ConfirmSheet } from '@/components/ui/BottomSheet';
import { useIsMobile } from '@/lib/platform';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import {
  listByOriginSession,
  setArchived,
  setNotes,
  setFavorite,
  setAlias,
  deleteLog,
} from '@/lib/translationLog';
import type { DbTranslationLog } from '@/lib/db';
import { reviewEntryLanguage } from '@/lib/reviewEntry';
import PopupResponse from './PopupResponse';
import styles from '@/styles/modules/AiPopupHistory.module.css';

const MODE_LABELS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': 'Explain (learning)',
  'explain-native': 'Explain (native)',
  'vocab-native': 'Vocabulary (native)',
  'translate-selection-learning': 'Translate → learning',
  'translate-selection-native': 'Translate → native',
  'translate-answer': 'Translate answer',
  'translate-file': 'Translate file',
  custom: 'Custom prompt',
};

const MODE_ICONS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': '🔎',
  'explain-native': '🌐',
  'vocab-native': '📖',
  'translate-selection-learning': '🔤',
  'translate-selection-native': '🔤',
  'translate-answer': '⤴',
  'translate-file': '📝',
  custom: '✦',
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatDate(ts);
}

interface AiPopupHistoryProps {
  sessionId: string;
  projectPath?: string;
}

export default function AiPopupHistory({ sessionId }: AiPopupHistoryProps) {
  const [rows, setRows] = useState<DbTranslationLog[]>([]);
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);
  const isPhone = useIsMobile();
  /** A phone's delete waits on a confirm sheet; this is the row it would delete. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const liveFloats = useFloatingSessionsStore((s) => s.floats);
  const showOnPhone = useFloatingSessionsStore((s) => s.setPhoneShown);

  const reload = useCallback(() => {
    let cancelled = false;
    listByOriginSession(sessionId).then((result) => {
      if (!cancelled) setRows(result);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => reload(), [reload]);

  const handleArchive = useCallback(
    async (uuid: string, isArchived: boolean) => {
      await setArchived(uuid, !isArchived);
      reload();
    },
    [reload],
  );

  const removeRow = useCallback(
    async (uuid: string) => {
      await deleteLog(uuid);
      if (expandedUuid === uuid) setExpandedUuid(null);
      reload();
    },
    [expandedUuid, reload],
  );

  const handleDelete = useCallback(
    async (uuid: string) => {
      if (isPhone) {
        setConfirmDelete(uuid);
        return;
      }
      if (!confirm('Delete this AI popup record? This cannot be undone.')) return;
      await removeRow(uuid);
    },
    [isPhone, removeRow],
  );
  const cancelDelete = useCallback(() => setConfirmDelete(null), []);

  const handleNotesChange = useCallback(
    async (uuid: string, value: string) => {
      await setNotes(uuid, value);
      reload();
    },
    [reload],
  );

  const handleFavorite = useCallback(
    async (uuid: string, isFav: boolean) => {
      await setFavorite(uuid, !isFav);
      reload();
    },
    [reload],
  );

  const handleAlias = useCallback(
    async (uuid: string, value: string) => {
      await setAlias(uuid, value.trim());
      reload();
    },
    [reload],
  );

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        No AI popups from this session yet
        {isPhone && <span className={styles.emptyHint}>Select text in Chat, the Terminal or a project file and tap Ask AI.</span>}
      </div>
    );
  }

  return (
    <div className={styles.list}>
      {isPhone && (
        <ConfirmSheet
          open={confirmDelete !== null}
          title="Delete this AI popup record?"
          message="Its source, response and notes are deleted from this device. This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            const uuid = confirmDelete;
            setConfirmDelete(null);
            if (uuid) void removeRow(uuid);
          }}
          onCancel={cancelDelete}
        />
      )}
      {rows.map((row) => {
        const expanded = expandedUuid === row.uuid;
        const sourceText =
          row.mode === 'translate-file' ? row.fileContent || row.filePath : row.selection;
        const running = isPhone && liveFloats.some((f) => f.terminalId === row.floatTerminalId);
        return (
          <div key={row.uuid} className={`${styles.row}${expanded ? ` ${styles.rowExpanded}` : ''}`}>
            <div className={styles.rowHeaderWrap}>
              <button
                type="button"
                className={styles.favToggle}
                aria-pressed={row.favorite === 1}
                title={row.favorite === 1 ? 'Unfavorite' : 'Favorite'}
                onClick={() => handleFavorite(row.uuid, row.favorite === 1)}
              >
                {row.favorite === 1 ? '★' : '☆'}
              </button>
              <button
                type="button"
                className={styles.rowHeader}
                onClick={() => setExpandedUuid(expanded ? null : row.uuid)}
                aria-expanded={expanded}
              >
                <span className={styles.modeIcon} aria-hidden>
                  {MODE_ICONS[row.mode]}
                </span>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    {row.alias ? (
                      <span className={styles.aliasLabel}>{row.alias}</span>
                    ) : (
                      <span className={styles.modeLabel}>{MODE_LABELS[row.mode]}</span>
                    )}
                    {reviewEntryLanguage(row) && <span className={styles.langChip}>→ {reviewEntryLanguage(row)}</span>}
                  </div>
                  <div className={styles.rowMeta}>
                    <span>{relativeTime(row.createdAt)}</span>
                    {running && <span className={styles.runningChip}>● running</span>}
                  </div>
                  <div className={styles.rowSnippet}>
                    {(sourceText || '(no source captured)').slice(0, 180)}
                  </div>
                </div>
                <span className={styles.expandIcon} aria-hidden>
                  {expanded ? '▾' : '▸'}
                </span>
              </button>
            </div>

            {expanded && (
              <div className={styles.detail}>
                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Alias</div>
                  <input
                    type="text"
                    className={styles.aliasInput}
                    defaultValue={row.alias}
                    placeholder="Short label for this record"
                    onBlur={(e) => {
                      if (e.target.value.trim() !== row.alias) handleAlias(row.uuid, e.target.value);
                    }}
                  />
                </div>

                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Source</div>
                  <pre className={styles.body}>{sourceText || '(no source captured)'}</pre>
                </div>

                <PopupResponse response={row.response} label="Response" />

                <div className={styles.section}>
                  <div className={styles.sectionLabel}>Notes</div>
                  <textarea
                    className={styles.notes}
                    rows={2}
                    defaultValue={row.notes}
                    placeholder="Personal notes (saved automatically)"
                    onBlur={(e) => {
                      if (e.target.value !== row.notes) handleNotesChange(row.uuid, e.target.value);
                    }}
                  />
                </div>

                <div className={styles.actions}>
                  {running && (
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.openBtn}`}
                      onClick={() => showOnPhone(row.floatTerminalId)}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.actionBtn}
                    onClick={() => handleArchive(row.uuid, row.archived === 1)}
                  >
                    {row.archived === 1 ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${styles.danger}`}
                    onClick={() => handleDelete(row.uuid)}
                  >
                    Delete
                  </button>
                  <span className={styles.timestamp}>Saved {formatDate(row.createdAt)}</span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
