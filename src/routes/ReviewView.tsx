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
import type { ListFilters } from '@/lib/translationLog';
import { useReviewLog } from '@/hooks/useReviewLog';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import {
  ARCHIVE_OPTIONS,
  EMPTY_HINT,
  FAVORITE_HINT,
  MODE_ICONS,
  MODE_LABELS,
  MODE_OPTIONS,
  NO_MATCH_HINT,
  NO_SOURCE,
  SEARCH_DEBOUNCE_MS,
  SUMMARY_LABEL,
  countEntries,
  metaLine,
  sourceTextOf,
  type ArchiveFilter,
  type ModeFilter,
} from '@/lib/reviewEntry';
import { EntryDetail, StarGlyph, type EntryDetailProps } from '@/components/review/ReviewEntry';
import { useIsMobile } from '@/lib/platform';
import PhoneReview from '@/components/mobile/views/PhoneReview';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import SearchInput from '@/components/ui/SearchInput';
import StaleNote from '@/components/ui/StaleNote';
import styles from '@/styles/modules/ReviewView.module.css';

/** A row's expand button — where focus goes when a neighbouring row is deleted. */
const ROW_TOGGLE = '[data-entry-toggle]';

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

/**
 * The REVIEW tab. A phone gets its own one-column view (PhoneReview, AASC-20):
 * an entry opens full screen instead of expanding in the list.
 */
export default function ReviewView() {
  return useIsMobile() ? <PhoneReview /> : <DesktopReview />;
}

function DesktopReview() {
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

  const {
    rows,
    loaded,
    loadError,
    reload,
    archive: handleArchive,
    saveNotes: handleNotesChange,
    favorite: handleFavorite,
    saveAlias: handleAlias,
    remove,
  } = useReviewLog(filters);

  const handleDelete = useCallback(async (uuid: string) => {
    if (!confirm('Delete this saved entry? This cannot be undone.')) return;
    if (!(await remove(uuid))) return;
    // The focused Delete leaves with its row: hand focus to a neighbouring
    // row, or to the search box when none is left.
    focusSiblingAfterRemoval(
      rowRefs.current.get(uuid),
      ROW_TOGGLE,
      viewRef.current?.querySelector<HTMLElement>('[data-search-input]'),
    );
    if (expandedUuid === uuid) setExpandedUuid(null);
    reload();
  }, [expandedUuid, remove, reload]);

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
