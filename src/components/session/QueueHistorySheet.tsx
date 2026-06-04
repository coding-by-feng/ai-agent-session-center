/**
 * QueueHistorySheet — global "favorites" sheet for queue items.
 *
 * Opens when the user clicks the 📚 icon in a session's QUEUE header. Lists
 * every saved record with View / Edit / Apply controls.
 *
 * - **View** opens a compact read-only preview (in-sheet).
 * - **Edit** opens the same QueueItemEditModal used for live queue items, but
 *   the save writes back to the history record (not any session's queue).
 * - **Apply** clones the saved snapshot into the *currently viewed* session's
 *   queue immediately (no session picker — the target is implicit from
 *   wherever the sheet was opened).
 *
 * The sheet is a self-contained overlay (ESC + click-outside to close) so it
 * doesn't fight the existing Modal store used by other panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QueueItem, QueueItemType } from '@/stores/queueStore';
import { useQueueHistoryStore, type QueueHistoryEntry } from '@/stores/queueHistoryStore';
import { useSessionStore } from '@/stores/sessionStore';
import { itemType, formatInterval, totalChainSteps } from '@/lib/queueScheduler';
import {
  serializeEntries,
  parseImportFile,
  defaultExportFilename,
  downloadAsFile,
  type ExportedFile,
  type ImportError,
} from '@/lib/queueHistoryExport';
import { showToast } from '@/components/ui/ToastContainer';
import QueueItemEditModal from './QueueItemEditModal';
import styles from '@/styles/modules/QueueHistory.module.css';

interface QueueHistorySheetProps {
  open: boolean;
  onClose: () => void;
  /** Session that "Apply" will land in. */
  currentSessionId: string;
  currentSessionTitle: string;
}

type FilterType = 'all' | QueueItemType;
type SortMode = 'recent' | 'used' | 'created';

export default function QueueHistorySheet({
  open,
  onClose,
  currentSessionId,
  currentSessionTitle,
}: QueueHistorySheetProps) {
  const entries = useQueueHistoryStore((s) => s.entries);
  const removeEntry = useQueueHistoryStore((s) => s.removeEntry);
  const updateEntry = useQueueHistoryStore((s) => s.updateEntry);
  const setAlias = useQueueHistoryStore((s) => s.setAlias);
  const applyToSession = useQueueHistoryStore((s) => s.applyToSession);
  const bulkImport = useQueueHistoryStore((s) => s.bulkImport);

  // Reactive selector so QueueItemEditModal always gets a fresh projectPath
  // even if the session updates while the sheet is open.
  const currentProjectPath = useSessionStore(
    (s) => s.sessions.get(currentSessionId)?.projectPath ?? null,
  );

  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [sortMode, setSortMode] = useState<SortMode>('recent');

  /** Import preview — the parsed file shown to the user before commit. Null
   *  while no import is in progress, or while picking. */
  const [importPreview, setImportPreview] = useState<
    | {
        filename: string;
        file: ExportedFile;
        skipped: number;
      }
    | null
  >(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [viewEntry, setViewEntry] = useState<QueueHistoryEntry | null>(null);
  const [editEntry, setEditEntry] = useState<QueueHistoryEntry | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);

  // ESC closes the topmost layer first (view → edit → sheet)
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (editEntry) { setEditEntry(null); return; }
      if (viewEntry) { setViewEntry(null); return; }
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, viewEntry, editEntry, onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (typeFilter !== 'all' && itemType(e.item) !== typeFilter) return false;
      if (!q) return true;
      const hay = `${e.alias ?? ''} ${e.item.text} ${e.sourceSessionTitle ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
    if (sortMode === 'used') {
      filtered.sort((a, b) => b.usedCount - a.usedCount);
    } else if (sortMode === 'created') {
      filtered.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      // 'recent' — last used first, falling back to createdAt
      filtered.sort((a, b) => {
        const la = a.lastUsedAt ?? a.createdAt;
        const lb = b.lastUsedAt ?? b.createdAt;
        return lb - la;
      });
    }
    return filtered;
  }, [entries, filter, typeFilter, sortMode]);

  const handleApply = useCallback(
    async (entry: QueueHistoryEntry) => {
      await applyToSession(entry.id, currentSessionId);
      showToast('Added to queue', 'info', 1500);
    },
    [applyToSession, currentSessionId],
  );

  const handleRemove = useCallback(
    async (entry: QueueHistoryEntry) => {
      await removeEntry(entry.id);
      showToast('Removed from history', 'info', 1500);
    },
    [removeEntry],
  );

  const handleEditSave = useCallback(
    async (patch: Partial<QueueItem>) => {
      if (!editEntry) return;
      await updateEntry(editEntry.id, patch);
      setEditEntry(null);
      showToast('History entry updated', 'info', 1500);
    },
    [editEntry, updateEntry],
  );

  // ---- Export: dump every entry to a JSON file the browser downloads. ----
  const handleExport = useCallback(() => {
    if (entries.length === 0) {
      showToast('Nothing to export — history is empty', 'info', 2000);
      return;
    }
    try {
      const text = serializeEntries(entries);
      downloadAsFile(text, defaultExportFilename());
      showToast(`Exported ${entries.length} entries`, 'info', 1800);
    } catch {
      showToast('Export failed', 'error', 2500);
    }
  }, [entries]);

  // ---- Import: pick a file → parse → preview → confirm commits. ----
  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChosen = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so picking the same file again re-fires onChange.
      if (e.target) e.target.value = '';
      if (!file) return;

      let text: string;
      try {
        text = await file.text();
      } catch {
        showToast('Could not read file', 'error', 2500);
        return;
      }
      const result = parseImportFile(text, file.size);
      if (!result.ok) {
        showToast(importErrorMessage(result.error), 'error', 3000);
        return;
      }
      setImportPreview({
        filename: file.name,
        file: result.file,
        skipped: result.skipped,
      });
    },
    [],
  );

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview) return;
    const written = await bulkImport(
      importPreview.file.entries.map((e) => ({
        alias: e.alias ?? null,
        item: e.item,
        sourceSessionTitle: e.sourceSessionTitle ?? null,
        sourceSessionId: e.sourceSessionId ?? null,
        usedCount: e.usedCount,
        createdAt: e.createdAt,
        lastUsedAt: e.lastUsedAt ?? null,
      })),
    );
    setImportPreview(null);
    if (written === 0) {
      showToast('Import failed', 'error', 3000);
    } else if (written < importPreview.file.entries.length) {
      showToast(
        `Imported ${written} of ${importPreview.file.entries.length} (some rows rejected)`,
        'info',
        3000,
      );
    } else {
      showToast(`Imported ${written} entries`, 'info', 1800);
    }
  }, [importPreview, bulkImport]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className={styles.overlay}
      onClick={handleOverlayClick}
    >
      <div className={styles.panel} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <h3>📚 Queue history</h3>
          <div className={styles.headerActions}>
            <button
              className={styles.headerIconBtn}
              onClick={handleExport}
              title="Export all queue history to a JSON file"
              aria-label="Export queue history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </button>
            <button
              className={styles.headerIconBtn}
              onClick={handlePickFile}
              title="Import queue history from a JSON file (entries are appended)"
              aria-label="Import queue history"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => { void handleFileChosen(e); }}
            />
            <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>

        <div className={styles.targetStrip} title="Apply will add to this session">
          <span className={styles.targetLabel}>Adding to:</span>
          <span className={styles.targetSession}>{currentSessionTitle || currentSessionId.slice(0, 8)}</span>
        </div>

        <div className={styles.controlsRow}>
          <input
            className={styles.filterInput}
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <select
            className={styles.controlSelect}
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as FilterType)}
            title="Filter by type"
          >
            <option value="all">All types</option>
            <option value="once">Once</option>
            <option value="loop">Loop</option>
            <option value="schedule">Schedule</option>
          </select>
          <select
            className={styles.controlSelect}
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            title="Sort order"
          >
            <option value="recent">Recent</option>
            <option value="used">Most used</option>
            <option value="created">Newest saved</option>
          </select>
        </div>

        <div className={styles.body}>
          {entries.length === 0 ? (
            <div className={styles.empty}>
              No saved items yet. Click the ★ next to a queue item to save it for later.
            </div>
          ) : visible.length === 0 ? (
            <div className={styles.empty}>No entries match the current filter.</div>
          ) : (
            visible.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                onView={() => setViewEntry(entry)}
                onEdit={() => setEditEntry(entry)}
                onApply={() => handleApply(entry)}
                onRemove={() => handleRemove(entry)}
                onSetAlias={(alias) => { void setAlias(entry.id, alias); }}
              />
            ))
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerStats}>
            {entries.length === 0
              ? ''
              : `${visible.length} of ${entries.length}`}
          </span>
          <button className={styles.btnGhost} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {/* Read-only preview */}
      {viewEntry && (
        <QueueHistoryViewModal
          entry={viewEntry}
          onClose={() => setViewEntry(null)}
          onApply={() => {
            void handleApply(viewEntry);
            setViewEntry(null);
          }}
        />
      )}

      {/* Edit entry — reuses QueueItemEditModal. Autocomplete is bound to
       *  the current session's CLI + project so `/` commands and `@` file
       *  lookups stay meaningful while editing a globally-saved entry. */}
      {editEntry && (
        <QueueItemEditModal
          item={editEntry.item}
          title="Edit history entry"
          onClose={() => setEditEntry(null)}
          onSave={(patch) => { void handleEditSave(patch); }}
          onDelete={() => {
            void removeEntry(editEntry.id);
            setEditEntry(null);
            showToast('Removed from history', 'info', 1500);
          }}
          /* Loop/Schedule are always editable here — autoSend doesn't gate history. */
          autoSendEnabled={true}
          sessionId={currentSessionId}
          projectPath={currentProjectPath}
        />
      )}

      {/* Import preview / confirmation. Sits on top of the sheet because the
       *  user shouldn't be interacting with the list while pending commit. */}
      {importPreview && (
        <ImportPreviewModal
          preview={importPreview}
          existingCount={entries.length}
          onCancel={() => setImportPreview(null)}
          onConfirm={() => { void handleConfirmImport(); }}
        />
      )}
    </div>
  );
}

function importErrorMessage(err: ImportError): string {
  switch (err) {
    case 'too-large':
      return 'File too large (> 50 MB)';
    case 'invalid-json':
      return "Couldn't parse file — not valid JSON";
    case 'wrong-schema':
      return 'Not a queue-history file';
    case 'newer-version':
      return 'File was created by a newer version of AASC — upgrade to import';
    case 'malformed':
      return 'Malformed queue-history file';
  }
}

// ---------------------------------------------------------------------------
// Single row
// ---------------------------------------------------------------------------

function HistoryRow({
  entry,
  onView,
  onEdit,
  onApply,
  onRemove,
  onSetAlias,
}: {
  entry: QueueHistoryEntry;
  onView: () => void;
  onEdit: () => void;
  onApply: () => void;
  onRemove: () => void;
  /** Persist a new alias (empty string clears it). */
  onSetAlias: (alias: string) => void;
}) {
  const t = itemType(entry.item);
  const typeLabel =
    t === 'loop'
      ? `⟳ Loop ${entry.item.intervalMs ? formatInterval(entry.item.intervalMs) : ''}`.trim()
      : t === 'schedule'
        ? '🕐 Schedule'
        : '▢ Once';
  const totalSteps = totalChainSteps(entry.item);
  const preview = entry.item.text.length > 120
    ? entry.item.text.slice(0, 120) + '…'
    : entry.item.text;

  // Inline alias editing. `aliasCommittedRef` guards against a double-commit
  // when Enter/Escape is followed by the input's blur event.
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const aliasCommittedRef = useRef(false);

  const startAlias = () => {
    setAliasDraft(entry.alias ?? '');
    aliasCommittedRef.current = false;
    setEditingAlias(true);
  };
  const commitAlias = () => {
    if (aliasCommittedRef.current) return;
    aliasCommittedRef.current = true;
    setEditingAlias(false);
    const next = aliasDraft.trim();
    // Only write when the value actually changed (avoids a redundant DB write).
    if (next !== (entry.alias ?? '')) onSetAlias(next);
  };
  const cancelAlias = () => {
    aliasCommittedRef.current = true; // suppress the trailing blur commit
    setEditingAlias(false);
  };

  return (
    <div className={styles.row}>
      <div className={styles.rowAliasLine}>
        {editingAlias ? (
          <input
            className={styles.rowAliasInput}
            value={aliasDraft}
            autoFocus
            maxLength={80}
            placeholder="Name this saved item…"
            onChange={(e) => setAliasDraft(e.target.value)}
            onBlur={commitAlias}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitAlias(); }
              else if (e.key === 'Escape') { e.preventDefault(); cancelAlias(); }
            }}
          />
        ) : entry.alias ? (
          <button
            className={styles.rowAlias}
            onClick={startAlias}
            title="Rename this saved item"
          >
            <span className={styles.rowAliasText}>{entry.alias}</span>
            <span className={styles.rowAliasPencil} aria-hidden>✎</span>
          </button>
        ) : (
          <button
            className={styles.rowAliasEmpty}
            onClick={startAlias}
            title="Add a name for this saved item"
          >
            + Add name
          </button>
        )}
      </div>
      <div className={styles.rowMain}>
        <span className={styles.rowTypeChip}>{typeLabel}</span>
        <span className={styles.rowText} title={entry.item.text}>{preview}</span>
      </div>
      <div className={styles.rowMeta}>
        {entry.sourceSessionTitle && (
          <span className={styles.rowSource}>
            from &ldquo;{entry.sourceSessionTitle}&rdquo;
          </span>
        )}
        <span className={styles.rowDate}>
          saved {new Date(entry.createdAt).toLocaleDateString()}
        </span>
        {entry.usedCount > 0 && (
          <span className={styles.rowUsed}>used {entry.usedCount}×</span>
        )}
        {totalSteps > 1 && (
          <span className={styles.rowChain}>· {totalSteps} steps</span>
        )}
      </div>
      <div className={styles.rowActions}>
        <button className={styles.btnGhost} onClick={onView} title="Preview">
          View
        </button>
        <button className={styles.btnGhost} onClick={onEdit} title="Edit saved entry">
          Edit
        </button>
        <button className={styles.btnPrimary} onClick={onApply} title="Add to current session's queue">
          + Apply
        </button>
        <button className={styles.btnDanger} onClick={onRemove} title="Remove from history">
          🗑
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View modal — small read-only preview
// ---------------------------------------------------------------------------

function QueueHistoryViewModal({
  entry,
  onClose,
  onApply,
}: {
  entry: QueueHistoryEntry;
  onClose: () => void;
  onApply: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onClose();
    },
    [onClose],
  );

  const t = itemType(entry.item);
  const before = entry.item.beforeChain ?? [];
  const after = entry.item.afterChain ?? [];

  return (
    <div ref={overlayRef} className={styles.viewOverlay} onClick={handleOverlayClick}>
      <div className={styles.viewPanel} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <h3>Preview</h3>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className={styles.viewBody}>
          {entry.alias && <Field label="Name">{entry.alias}</Field>}
          <Field label="Type">
            {t === 'loop'
              ? `⟳ Loop`
              : t === 'schedule'
                ? '🕐 Schedule'
                : '▢ Once'}
          </Field>
          {t === 'loop' && entry.item.intervalMs && (
            <Field label="Interval">{formatInterval(entry.item.intervalMs)}</Field>
          )}
          {t === 'schedule' && entry.item.runAt && (
            <Field label="Runs at">{new Date(entry.item.runAt).toLocaleString()}</Field>
          )}
          <Field label="Main text">
            <pre className={styles.viewText}>{entry.item.text}</pre>
          </Field>
          {before.length > 0 && (
            <Field label="Before chain">
              <ol className={styles.viewChainList}>
                {before.map((s) => (
                  <li key={s.id}>{s.text}</li>
                ))}
              </ol>
            </Field>
          )}
          {after.length > 0 && (
            <Field label="After chain">
              <ol className={styles.viewChainList}>
                {after.map((s) => (
                  <li key={s.id}>{s.text}</li>
                ))}
              </ol>
            </Field>
          )}
          {entry.sourceSessionTitle && (
            <Field label="Saved from">&ldquo;{entry.sourceSessionTitle}&rdquo;</Field>
          )}
          <Field label="Saved on">{new Date(entry.createdAt).toLocaleString()}</Field>
          <Field label="Used">
            {entry.usedCount > 0
              ? `${entry.usedCount}×${entry.lastUsedAt ? ` (last ${new Date(entry.lastUsedAt).toLocaleString()})` : ''}`
              : 'never'}
          </Field>
        </div>
        <div className={styles.footer}>
          <span />
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={onClose}>Close</button>
            <button className={styles.btnPrimary} onClick={onApply}>+ Apply</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.viewField}>
      <span className={styles.viewFieldLabel}>{label}</span>
      <div className={styles.viewFieldValue}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Import preview / confirm modal
// ---------------------------------------------------------------------------

function ImportPreviewModal({
  preview,
  existingCount,
  onCancel,
  onConfirm,
}: {
  preview: { filename: string; file: ExportedFile; skipped: number };
  existingCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) onCancel();
    },
    [onCancel],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const exportedAt = (() => {
    try {
      return new Date(preview.file.exportedAt).toLocaleString();
    } catch {
      return preview.file.exportedAt;
    }
  })();

  const importCount = preview.file.entries.length;

  return (
    <div ref={overlayRef} className={styles.viewOverlay} onClick={handleOverlayClick}>
      <div className={styles.viewPanel} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <h3>Import queue history</h3>
          <button className={styles.closeBtn} onClick={onCancel} aria-label="Cancel">
            ✕
          </button>
        </div>
        <div className={styles.viewBody}>
          <Field label="File">{preview.filename}</Field>
          <Field label="Exported">{exportedAt}</Field>
          <Field label="Entries">{importCount}</Field>
          {preview.skipped > 0 && (
            <Field label="Skipped">
              {preview.skipped} (missing required fields)
            </Field>
          )}
          <Field label="Existing history">
            {existingCount === 0
              ? 'empty — these will be your first saved entries'
              : `${existingCount} entries — imports are appended, your existing entries are untouched`}
          </Field>
        </div>
        <div className={styles.footer}>
          <span />
          <div className={styles.footerRight}>
            <button className={styles.btnGhost} onClick={onCancel}>Cancel</button>
            <button
              className={styles.btnPrimary}
              onClick={onConfirm}
              disabled={importCount === 0}
            >
              Import {importCount}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
