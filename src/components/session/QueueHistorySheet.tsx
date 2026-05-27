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
import { itemType, formatInterval, totalChainSteps } from '@/lib/queueScheduler';
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
  const applyToSession = useQueueHistoryStore((s) => s.applyToSession);

  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [sortMode, setSortMode] = useState<SortMode>('recent');

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
      const hay = `${e.item.text} ${e.sourceSessionTitle ?? ''}`.toLowerCase();
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
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ✕
          </button>
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

      {/* Edit entry — reuses QueueItemEditModal */}
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
        />
      )}
    </div>
  );
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
}: {
  entry: QueueHistoryEntry;
  onView: () => void;
  onEdit: () => void;
  onApply: () => void;
  onRemove: () => void;
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

  return (
    <div className={styles.row}>
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
