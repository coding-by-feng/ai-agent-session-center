/**
 * ReviewView — the REVIEW tab: saved explanations and translations.
 *
 * Lists every entry produced by the select-to-translate / explain feature.
 * Each row expands inline to show the source, the captured AI response, an
 * alias and a notes box. Filters: search, mode, archived state, favourites.
 *
 * Controls and marks come from the shared primitives in `@/components/ui`;
 * ReviewView.module.css only lays them out.
 */
import { useEffect, useId, useMemo, useState, useCallback, useRef } from 'react';
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
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import { formatDate } from '@/lib/historyFormat';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import SearchInput from '@/components/ui/SearchInput';
import StaleNote from '@/components/ui/StaleNote';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import { showToast } from '@/components/ui/ToastContainer';
import PopupResponse from '@/components/session/PopupResponse';
import styles from '@/styles/modules/ReviewView.module.css';

type ModeFilter = DbTranslationLog['mode'] | 'all';
type ArchiveFilter = NonNullable<ListFilters['archived']>;

const SEARCH_DEBOUNCE_MS = 200;
const POLL_MS = 4000;
const SUMMARY_LABEL = 'Saved explanations & translations';
const NO_SOURCE = '(no source captured)';
// The "Translate previous answer" / "Translate file" toolbar buttons this hint
// used to point at no longer exist (no trigger anywhere in src/); the selection
// popup's 🔎 / 🌐 still match.
const EMPTY_HINT =
  'Select text in the terminal or in a markdown file and click 🔎 / 🌐. ' +
  'Your explanations and translations will be saved here for review.';
const NO_MATCH_HINT = 'Try a broader search, or change the Mode, Show or Favorites filter.';
const FAVORITE_HINT = 'Highlights it in the source file.';
/** A row's expand button — where focus goes when a neighbouring row is deleted. */
const ROW_TOGGLE = '[data-entry-toggle]';

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

// Every mode, from the label map. The list used to skip the two live
// translate-selection modes (the ones the popup still creates) while offering
// two that only old entries carry — so the commonest entries could not be
// filtered to. Old modes stay listed: their entries still exist.
const MODE_OPTIONS: readonly NativeSelectOption<ModeFilter>[] = [
  { value: 'all', label: 'All modes' },
  ...(Object.keys(MODE_LABELS) as DbTranslationLog['mode'][]).map((m) => ({ value: m, label: MODE_LABELS[m] })),
];

const ARCHIVE_OPTIONS: readonly NativeSelectOption<ArchiveFilter>[] = [
  { value: 'active', label: 'Active only' },
  { value: 'archived', label: 'Archived only' },
  { value: 'all', label: 'All' },
];

/** "Oct 7, 21:08": 24-hour like every other tab, no seconds, the year only when it is not this one. */
const stamp = (ts: number): string => formatDate(ts, Date.now());

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  return stamp(ts);
}

function countEntries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

/** Project, session and age on one line. A no-break space keeps each "·" with the word before it. */
function metaLine(row: DbTranslationLog): string {
  return [row.originProjectName || 'unknown project', row.originSessionTitle, relativeTime(row.createdAt)]
    .filter(Boolean)
    .join(' · ');
}

function sourceTextOf(row: DbTranslationLog): string {
  return row.mode === 'translate-file' ? row.fileContent || row.filePath : row.selection;
}

/** The favourites mark: an outline star, filled while on. Sized by its button. */
function StarGlyph({ filled }: { filled: boolean }) {
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
function SourceSection({ row }: { row: DbTranslationLog }) {
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

interface EntryDetailProps {
  row: DbTranslationLog;
  onAlias: (uuid: string, value: string) => void;
  onNotes: (uuid: string, value: string) => void;
  onArchive: (uuid: string, isArchived: boolean) => void;
  onDelete: (uuid: string) => void;
}

/** The expanded body of a row: alias, source, conversation, notes, actions. */
function EntryDetail({ row, onAlias, onNotes, onArchive, onDelete }: EntryDetailProps) {
  const saved = stamp(row.createdAt);
  const updated = stamp(row.updatedAt);
  return (
    <div className={styles.detail}>
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

interface EntryRowProps extends EntryDetailProps {
  expanded: boolean;
  onToggle: (uuid: string) => void;
  onFavorite: (uuid: string, isFavorite: boolean) => void;
  setRowRef: (uuid: string, el: HTMLLIElement | null) => void;
}

function EntryRow({ expanded, onToggle, onFavorite, setRowRef, ...detail }: EntryRowProps) {
  const { row } = detail;
  const favorited = row.favorite === 1;
  // The star is described by the row's title, so a list of stars is not N
  // identical "Favorite" buttons to a screen reader.
  const titleId = useId();
  return (
    <li
      ref={(el) => setRowRef(row.uuid, el)}
      className={`${styles.row}${expanded ? ` ${styles.rowExpanded}` : ''}`}
    >
      <div className={styles.rowHeaderWrap}>
        {/* A sibling of the expand button, not a child: a button cannot hold a button.
            One constant name: aria-pressed carries on/off, and a toggle whose
            name flips with its state reads as two different buttons. */}
        <IconButton
          className={styles.favToggle}
          tone="warning"
          pressed={favorited}
          label="Favorite"
          description={FAVORITE_HINT}
          aria-describedby={titleId}
          onClick={() => onFavorite(row.uuid, favorited)}
        >
          <StarGlyph filled={favorited} />
        </IconButton>
        <button
          type="button"
          className={styles.rowHeader}
          data-entry-toggle=""
          onClick={() => onToggle(row.uuid)}
          aria-expanded={expanded}
        >
          <span className={styles.modeIcon} aria-hidden>{MODE_ICONS[row.mode]}</span>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={titleId}>
              {row.alias
                ? <span className={styles.aliasLabel} title={row.alias}>{row.alias}</span>
                : <span className={styles.modeLabel}>{MODE_LABELS[row.mode]}</span>}
              <Chip tone="info">→ {row.nativeLanguage}</Chip>
              {row.archived === 1 && <Chip>archived</Chip>}
            </span>
            <span className={styles.rowMeta}>{metaLine(row)}</span>
            <span className={styles.rowSnippet}>
              {(sourceTextOf(row) || NO_SOURCE).slice(0, 220)}
            </span>
          </span>
          <span className={styles.expandIcon} aria-hidden>{expanded ? '▾' : '▸'}</span>
        </button>
      </div>
      {expanded && <EntryDetail {...detail} />}
    </li>
  );
}

export default function ReviewView() {
  // Deep-link from the md-highlight click (/review?uuid=…) — ReviewView is always
  // mounted fresh by that navigation, so we seed initial state from the param
  // (expand + widen the archived filter so the record is visible) and scroll to
  // it once loaded, rather than mutating state inside an effect.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkUuid = searchParams.get('uuid');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [archived, setArchivedFilter] = useState<ArchiveFilter>(deepLinkUuid ? 'all' : 'active');
  // SearchInput debounces, so this is already the settled query.
  const [search, setSearch] = useState('');
  const [expandedUuid, setExpandedUuid] = useState<string | null>(deepLinkUuid);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const viewRef = useRef<HTMLDivElement>(null);

  const filters = useMemo<ListFilters>(
    () => ({ mode, archived, favorite: favoriteOnly || undefined, search }),
    [mode, archived, favoriteOnly, search],
  );

  const [rows, setRows] = useState<DbTranslationLog[]>([]);
  // False until the first read settles: before it, an empty list is not yet
  // "nothing saved" (that state used to flash on every visit).
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  // A failed IndexedDB read used to leave an empty list (reading as "nothing
  // saved yet") and an unhandled rejection; it now says so, with a Retry. A
  // failure with rows already on screen keeps them and says they are stale.
  useEffect(() => {
    let cancelled = false;
    listLogs(filters).then(
      (result) => {
        if (cancelled) return;
        setRows(result);
        setLoadError(null);
        setLoaded(true);
      },
      (err: unknown) => {
        if (cancelled) return;
        setLoadError(errorText(err));
        setLoaded(true);
      },
    );
    return () => { cancelled = true; };
  }, [filters, reloadTick]);

  // Periodic refresh — picks up response captures from float-close handlers and
  // newly-saved entries from background spawns. Cheap (single IndexedDB read).
  useEffect(() => {
    const interval = setInterval(reload, POLL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  /** One write, then a re-read. A failed write says so (a toast) instead of
   *  an unhandled rejection — notes saved on blur were otherwise lost silently. */
  const persist = useCallback(async (write: Promise<unknown>, failure: string) => {
    try {
      await write;
    } catch (err) {
      showToast(`${failure}: ${errorText(err)}`, 'error');
    }
    reload();
  }, [reload]);

  const handleArchive = useCallback(
    (uuid: string, isArchived: boolean) =>
      persist(setArchived(uuid, !isArchived), isArchived ? 'Could not unarchive the entry' : 'Could not archive the entry'),
    [persist],
  );

  const handleDelete = useCallback(async (uuid: string) => {
    if (!confirm('Delete this saved entry? This cannot be undone.')) return;
    try {
      await deleteLog(uuid);
    } catch (err) {
      showToast(`Could not delete the entry: ${errorText(err)}`, 'error');
      return;
    }
    // The focused Delete leaves with its row: hand focus to a neighbouring
    // row, or to the search box when none is left.
    focusSiblingAfterRemoval(
      rowRefs.current.get(uuid),
      ROW_TOGGLE,
      viewRef.current?.querySelector<HTMLElement>('[data-search-input]'),
    );
    if (expandedUuid === uuid) setExpandedUuid(null);
    reload();
  }, [expandedUuid, reload]);

  const handleNotesChange = useCallback(
    (uuid: string, value: string) => persist(setNotes(uuid, value), 'Could not save your notes'),
    [persist],
  );

  const handleFavorite = useCallback(
    (uuid: string, isFav: boolean) => persist(setFavorite(uuid, !isFav), 'Could not change the favorite'),
    [persist],
  );

  const handleAlias = useCallback(
    (uuid: string, value: string) => persist(setAlias(uuid, value.trim()), 'Could not save the alias'),
    [persist],
  );

  const toggleExpanded = useCallback(
    (uuid: string) => setExpandedUuid((current) => (current === uuid ? null : uuid)),
    [],
  );

  const setRowRef = useCallback((uuid: string, el: HTMLLIElement | null) => {
    if (el) rowRefs.current.set(uuid, el);
    else rowRefs.current.delete(uuid);
  }, []);

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

  // Can the filters be what hides everything? "Show: All" only widens the list,
  // and the default "Active only" looks the same as nothing saved at all (telling
  // them apart would take a second query), so neither counts.
  const filtersMayHide =
    mode !== 'all' || favoriteOnly || archived === 'archived' || search.trim() !== '';
  const summary = rows.length > 0 ? `${SUMMARY_LABEL} · ${countEntries(rows.length)}` : SUMMARY_LABEL;

  return (
    <div ref={viewRef} className={styles.view}>
      <div className={styles.header}>
        <div className={styles.toolbar}>
          <SearchInput
            variant="field"
            className={styles.search}
            ariaLabel="Search saved entries"
            placeholder="Search source, response, notes…"
            debounceMs={SEARCH_DEBOUNCE_MS}
            onChange={setSearch}
          />
          <Field label="Mode">
            <NativeSelect value={mode} onChange={setMode} options={MODE_OPTIONS} />
          </Field>
          <Field label="Show">
            <NativeSelect value={archived} onChange={setArchivedFilter} options={ARCHIVE_OPTIONS} />
          </Field>
          <Button
            pressed={favoriteOnly}
            icon={<StarGlyph filled={favoriteOnly} />}
            title="Show only favorited entries"
            onClick={() => setFavoriteOnly((v) => !v)}
          >
            Favorites
          </Button>
        </div>
        <p className={styles.summary}>{summary}</p>
      </div>

      <div className={styles.body}>
        {!loaded ? (
          <EmptyState busy fill title="Loading saved entries…" />
        ) : loadError && rows.length === 0 ? (
          <EmptyState
            fill
            tone="error"
            title="Could not read your saved entries"
            hint={loadError}
            action={<Button onClick={reload}>Retry</Button>}
          />
        ) : rows.length === 0 ? (
          filtersMayHide ? (
            <EmptyState fill title="No entries match these filters" hint={NO_MATCH_HINT} />
          ) : (
            <EmptyState fill title="No saved entries yet" hint={EMPTY_HINT} />
          )
        ) : (
          <>
            {loadError && <StaleNote onRetry={reload} />}
            {/* role="list": Safari/VoiceOver drops list semantics once list-style is none. */}
            <ul className={styles.list} role="list" aria-label="Saved entries">
            {rows.map((row) => (
              <EntryRow
                key={row.uuid}
                row={row}
                expanded={expandedUuid === row.uuid}
                onToggle={toggleExpanded}
                onFavorite={handleFavorite}
                onAlias={handleAlias}
                onNotes={handleNotesChange}
                onArchive={handleArchive}
                onDelete={handleDelete}
                setRowRef={setRowRef}
              />
            ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
