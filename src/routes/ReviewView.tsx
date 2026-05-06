/**
 * ReviewView — saved explanations and translations.
 *
 * Lists every entry produced by the select-to-translate / explain feature.
 * Each row can be expanded inline to view the source, the captured AI
 * response, and a small notes textarea. Filters: mode, archived, search.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  listLogs,
  setArchived,
  setNotes,
  deleteLog,
  type ListFilters,
} from '@/lib/translationLog';
import type { DbTranslationLog } from '@/lib/db';
import styles from '@/styles/modules/ReviewView.module.css';

const MODE_LABELS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': 'Explain (learning)',
  'explain-native': 'Explain (native)',
  'translate-answer': 'Translate answer',
  'translate-file': 'Translate file',
};

const MODE_ICONS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': '🔎',
  'explain-native': '🌐',
  'translate-answer': '⤴',
  'translate-file': '📝',
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
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

export default function ReviewView() {
  const [mode, setMode] = useState<ListFilters['mode']>('all');
  const [archived, setArchivedFilter] = useState<ListFilters['archived']>('active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedUuid, setExpandedUuid] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<ListFilters>(
    () => ({ mode, archived, search: debouncedSearch }),
    [mode, archived, debouncedSearch],
  );

  const [rows, setRows] = useState<DbTranslationLog[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    listLogs(filters).then((result) => {
      if (!cancelled) setRows(result);
    });
    return () => { cancelled = true; };
  }, [filters, reloadTick]);

  // Periodic refresh — picks up response captures from float-close handlers and
  // newly-saved entries from background spawns. Cheap (single IndexedDB read).
  useEffect(() => {
    const interval = setInterval(reload, 4000);
    return () => clearInterval(interval);
  }, [reload]);

  const handleArchive = useCallback(async (uuid: string, isArchived: boolean) => {
    await setArchived(uuid, !isArchived);
    reload();
  }, [reload]);

  const handleDelete = useCallback(async (uuid: string) => {
    if (!confirm('Delete this saved entry? This cannot be undone.')) return;
    await deleteLog(uuid);
    if (expandedUuid === uuid) setExpandedUuid(null);
    reload();
  }, [expandedUuid, reload]);

  const handleNotesChange = useCallback(async (uuid: string, value: string) => {
    await setNotes(uuid, value);
    reload();
  }, [reload]);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
  }, []);

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.title}>SAVED EXPLANATIONS &amp; TRANSLATIONS</div>
        <div className={styles.filters}>
          <input
            type="search"
            className={styles.search}
            placeholder="Search source, response, notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className={styles.select}
            value={mode}
            onChange={(e) => setMode(e.target.value as ListFilters['mode'])}
          >
            <option value="all">All modes</option>
            <option value="explain-learning">{MODE_LABELS['explain-learning']}</option>
            <option value="explain-native">{MODE_LABELS['explain-native']}</option>
            <option value="translate-answer">{MODE_LABELS['translate-answer']}</option>
            <option value="translate-file">{MODE_LABELS['translate-file']}</option>
          </select>
          <select
            className={styles.select}
            value={archived}
            onChange={(e) => setArchivedFilter(e.target.value as ListFilters['archived'])}
          >
            <option value="active">Active only</option>
            <option value="archived">Archived only</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <p>No saved entries yet.</p>
          <p className={styles.hint}>
            Select text in the terminal or in a markdown file and click 🔎 / 🌐, or use
            the &ldquo;Translate previous answer&rdquo; / &ldquo;Translate file&rdquo; toolbar buttons.
            Your explanations and translations will be saved here for review.
          </p>
        </div>
      ) : (
        <div className={styles.list}>
          {rows.map((row) => {
            const expanded = expandedUuid === row.uuid;
            const sourceText = row.mode === 'translate-file'
              ? row.fileContent || row.filePath
              : row.selection;
            return (
              <div key={row.uuid} className={`${styles.row}${expanded ? ` ${styles.rowExpanded}` : ''}`}>
                <button
                  type="button"
                  className={styles.rowHeader}
                  onClick={() => setExpandedUuid(expanded ? null : row.uuid)}
                  aria-expanded={expanded}
                >
                  <span className={styles.modeIcon} aria-hidden>{MODE_ICONS[row.mode]}</span>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      <span className={styles.modeLabel}>{MODE_LABELS[row.mode]}</span>
                      <span className={styles.langChip}>→ {row.nativeLanguage}</span>
                      {row.archived === 1 && <span className={styles.archivedChip}>archived</span>}
                    </div>
                    <div className={styles.rowMeta}>
                      <span>{row.originProjectName || 'unknown project'}</span>
                      {row.originSessionTitle && <span>· {row.originSessionTitle}</span>}
                      <span>· {relativeTime(row.createdAt)}</span>
                    </div>
                    <div className={styles.rowSnippet}>
                      {(sourceText || '(no source captured)').slice(0, 220)}
                    </div>
                  </div>
                  <span className={styles.expandIcon} aria-hidden>{expanded ? '▾' : '▸'}</span>
                </button>

                {expanded && (
                  <div className={styles.detail}>
                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>Source</div>
                      {row.mode === 'translate-file' && row.filePath && (
                        <div className={styles.filePath}>{row.filePath}</div>
                      )}
                      <pre className={styles.body}>{sourceText || '(no source captured)'}</pre>
                      {row.contextLine && row.contextLine !== row.selection && (
                        <div className={styles.contextLine}>
                          <span className={styles.metaLabel}>Surrounding line:</span> {row.contextLine}
                        </div>
                      )}
                    </div>

                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>
                        AI response
                        {row.response && (
                          <button
                            type="button"
                            className={styles.linkBtn}
                            onClick={() => handleCopy(row.response)}
                          >
                            copy
                          </button>
                        )}
                      </div>
                      <pre className={styles.body}>
                        {row.response || '(response not captured — close the floating session to capture it)'}
                      </pre>
                    </div>

                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>Notes</div>
                      <textarea
                        className={styles.notes}
                        rows={2}
                        defaultValue={row.notes}
                        placeholder="Personal notes for review (saved automatically)"
                        onBlur={(e) => {
                          if (e.target.value !== row.notes) handleNotesChange(row.uuid, e.target.value);
                        }}
                      />
                    </div>

                    <div className={styles.actions}>
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
                      <span className={styles.timestamp}>
                        Saved {formatDate(row.createdAt)}
                        {row.updatedAt !== row.createdAt && ` · Updated ${formatDate(row.updatedAt)}`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
