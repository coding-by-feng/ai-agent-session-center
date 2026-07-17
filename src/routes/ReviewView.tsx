/**
 * ReviewView — saved explanations and translations.
 *
 * Lists every entry produced by the select-to-translate / explain feature.
 * Each row can be expanded inline to view the source, the captured AI
 * response, and a small notes textarea. Filters: mode, archived, search.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router';
import {
  listLogs,
  setArchived,
  setNotes,
  setFavorite,
  setAlias,
  deleteLog,
  type ListFilters,
} from '@/lib/translationLog';
import type { DbTranslationLog } from '@/lib/db';
import PopupResponse from '@/components/session/PopupResponse';
import styles from '@/styles/modules/ReviewView.module.css';

const MODE_LABELS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': 'Explain (learning)',
  'explain-native': 'Explain (native)',
  'vocab-native': 'Vocabulary (native)',
  'translate-selection-learning': 'Translate → learning',
  'translate-selection-native': 'Translate → native',
  'translate-answer': 'Translate answer',
  'translate-file': 'Translate file',
  'custom': 'Custom prompt',
};

const MODE_ICONS: Record<DbTranslationLog['mode'], string> = {
  'explain-learning': '🔎',
  'explain-native': '🌐',
  'vocab-native': '📖',
  'translate-selection-learning': '🔤',
  'translate-selection-native': '🔤',
  'translate-answer': '⤴',
  'translate-file': '📝',
  'custom': '✦',
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
  // Deep-link from the md-highlight click (/review?uuid=…) — ReviewView is always
  // mounted fresh by that navigation, so we seed initial state from the param
  // (expand + widen the archived filter so the record is visible) and scroll to
  // it once loaded, rather than mutating state inside an effect.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkUuid = searchParams.get('uuid');
  const [mode, setMode] = useState<ListFilters['mode']>('all');
  const [archived, setArchivedFilter] = useState<ListFilters['archived']>(deepLinkUuid ? 'all' : 'active');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [expandedUuid, setExpandedUuid] = useState<string | null>(deepLinkUuid);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const filters = useMemo<ListFilters>(
    () => ({ mode, archived, favorite: favoriteOnly || undefined, search: debouncedSearch }),
    [mode, archived, favoriteOnly, debouncedSearch],
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

  const handleFavorite = useCallback(async (uuid: string, isFav: boolean) => {
    await setFavorite(uuid, !isFav);
    reload();
  }, [reload]);

  const handleAlias = useCallback(async (uuid: string, value: string) => {
    await setAlias(uuid, value.trim());
    reload();
  }, [reload]);

  // Once the deep-linked record is loaded, scroll to it and drop the url param.
  // The param itself is the one-shot flag — clearing it ends the scroll.
  useEffect(() => {
    const target = searchParams.get('uuid');
    if (!target || !rows.some((r) => r.uuid === target)) return;
    requestAnimationFrame(() => {
      rowRefs.current.get(target)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    const next = new URLSearchParams(searchParams);
    next.delete('uuid');
    setSearchParams(next, { replace: true });
  }, [rows, searchParams, setSearchParams]);

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
            <option value="vocab-native">{MODE_LABELS['vocab-native']}</option>
            <option value="translate-answer">{MODE_LABELS['translate-answer']}</option>
            <option value="translate-file">{MODE_LABELS['translate-file']}</option>
            <option value="custom">{MODE_LABELS['custom']}</option>
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
          <button
            type="button"
            className={`${styles.favFilter}${favoriteOnly ? ` ${styles.favFilterActive}` : ''}`}
            aria-pressed={favoriteOnly}
            onClick={() => setFavoriteOnly((v) => !v)}
            title="Show only favorited entries"
          >
            {favoriteOnly ? '★' : '☆'} Favorites
          </button>
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
              <div
                key={row.uuid}
                ref={(el) => { if (el) rowRefs.current.set(row.uuid, el); else rowRefs.current.delete(row.uuid); }}
                className={`${styles.row}${expanded ? ` ${styles.rowExpanded}` : ''}`}
              >
                <div className={styles.rowHeaderWrap}>
                  <button
                    type="button"
                    className={styles.favToggle}
                    aria-pressed={row.favorite === 1}
                    title={row.favorite === 1 ? 'Unfavorite' : 'Favorite — highlights it in the source file'}
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
                  <span className={styles.modeIcon} aria-hidden>{MODE_ICONS[row.mode]}</span>
                  <div className={styles.rowMain}>
                    <div className={styles.rowTitle}>
                      {row.alias
                        ? <span className={styles.aliasLabel}>{row.alias}</span>
                        : <span className={styles.modeLabel}>{MODE_LABELS[row.mode]}</span>}
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
                </div>

                {expanded && (
                  <div className={styles.detail}>
                    <div className={styles.section}>
                      <div className={styles.sectionLabel}>Alias</div>
                      <input
                        type="text"
                        className={styles.aliasInput}
                        defaultValue={row.alias}
                        placeholder="Short label for this record (shown here and in the file highlight)"
                        onBlur={(e) => {
                          if (e.target.value.trim() !== row.alias) handleAlias(row.uuid, e.target.value);
                        }}
                      />
                    </div>

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

                    <PopupResponse response={row.response} label="Conversation" />

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
