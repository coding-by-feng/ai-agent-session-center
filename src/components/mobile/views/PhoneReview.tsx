/**
 * PhoneReview — the REVIEW tab on a phone (AASC-20, feature 7): saved
 * explanations and translations in one column, search and Filters (mode,
 * archived, favourites) at the top. A row opens the entry full screen (alias,
 * source, conversation, notes, archive, delete) instead of expanding in the
 * list; the star stays on the row, a 44px toggle of its own.
 *
 * The entries live in this device's IndexedDB (useReviewLog), so nothing here
 * asks the Mac for anything.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DbTranslationLog } from '@/lib/db';
import type { ListFilters } from '@/lib/translationLog';
import {
  ARCHIVE_OPTIONS,
  FAVORITE_HINT,
  MODE_ICONS,
  MODE_LABELS,
  MODE_OPTIONS,
  NO_MATCH_HINT,
  NO_SOURCE,
  PHONE_EMPTY_HINT,
  SEARCH_DEBOUNCE_MS,
  countEntries,
  metaLine,
  sourceTextOf,
  type ArchiveFilter,
  type ModeFilter,
} from '@/lib/reviewEntry';
import { useReviewLog } from '@/hooks/useReviewLog';
import { EntryDetail, StarGlyph } from '@/components/review/ReviewEntry';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import StaleNote from '@/components/ui/StaleNote';
import { showToast } from '@/components/ui/ToastContainer';
import PhoneViewBar from './PhoneViewBar';
import styles from '@/styles/modules/PhoneViews.module.css';

const entryName = (row: DbTranslationLog): string => row.alias || MODE_LABELS[row.mode];

export default function PhoneReview() {
  // A deep link (/review?uuid=…, from a highlight in a file) opens that entry,
  // with archived ones listed so it can be found.
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkUuid = searchParams.get('uuid');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [archived, setArchivedFilter] = useState<ArchiveFilter>(deepLinkUuid ? 'all' : 'active');
  const [search, setSearch] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [openUuid, setOpenUuid] = useState<string | null>(deepLinkUuid);
  const [deleting, setDeleting] = useState<string | null>(null);

  const filters = useMemo<ListFilters>(
    () => ({ mode, archived, favorite: favoriteOnly || undefined, search }),
    [mode, archived, favoriteOnly, search],
  );
  const { rows, loaded, loadError, reload, archive, remove, favorite, saveAlias, saveNotes } = useReviewLog(filters);

  // The url param is a one-shot: drop it once the entry it names is listed.
  useEffect(() => {
    const target = searchParams.get('uuid');
    if (!target || !rows.some((r) => r.uuid === target)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('uuid');
    setSearchParams(next, { replace: true });
  }, [rows, searchParams, setSearchParams]);

  const active = (mode !== 'all' ? 1 : 0) + (archived !== 'active' ? 1 : 0) + (favoriteOnly ? 1 : 0);
  const clearFilters = useCallback(() => {
    setMode('all');
    setArchivedFilter('active');
    setFavoriteOnly(false);
  }, []);

  const openRow = openUuid ? rows.find((r) => r.uuid === openUuid) : undefined;
  const closeEntry = useCallback(() => setOpenUuid(null), []);
  const cancelDelete = useCallback(() => setDeleting(null), []);

  // Archiving from the sheet can take the entry out of the list it was opened
  // from ("Active only"): close it and say what happened.
  const archiveFromSheet = useCallback(async (uuid: string, isArchived: boolean) => {
    await archive(uuid, isArchived);
    setOpenUuid(null);
    showToast(isArchived ? 'Entry restored' : 'Entry archived', 'info');
  }, [archive]);

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const ok = await remove(deleting);
    setDeleting(null);
    if (!ok) return;
    setOpenUuid(null);
    reload();
    showToast('Entry deleted', 'info');
  }, [deleting, remove, reload]);

  const filtersMayHide = active > 0 || search.trim() !== '';

  const body = () => {
    if (!loaded) return <EmptyState busy fill title="Loading saved entries…" />;
    if (loadError && rows.length === 0) {
      return (
        <EmptyState
          fill
          tone="error"
          title="Could not read your saved entries"
          hint={loadError}
          action={<Button onClick={reload}>Retry</Button>}
        />
      );
    }
    if (rows.length === 0) {
      return filtersMayHide
        ? <EmptyState fill title="No entries match these filters" hint={NO_MATCH_HINT} />
        : <EmptyState fill title="No saved entries yet" hint={PHONE_EMPTY_HINT} />;
    }
    return (
      <>
        {loadError && <StaleNote onRetry={reload} />}
        <ul className={styles.list} role="list" aria-label="Saved entries">
          {rows.map((row) => (
            <ReviewRow key={row.uuid} row={row} onOpen={setOpenUuid} onFavorite={favorite} />
          ))}
        </ul>
      </>
    );
  };

  return (
    <div className={styles.view} data-testid="phone-review">
      <PhoneViewBar
        searchLabel="Search saved entries"
        searchPlaceholder="Search…"
        search={search}
        onSearch={setSearch}
        searchDebounceMs={SEARCH_DEBOUNCE_MS}
        activeFilters={active}
        onClearFilters={clearFilters}
        summary={loaded && rows.length > 0 ? `${countEntries(rows.length)} saved on this device` : 'Saved on this device'}
        filters={(
          <>
            <Field label="Mode" className={styles.sheetField}>
              <NativeSelect value={mode} onChange={setMode} options={MODE_OPTIONS} />
            </Field>
            <Field label="Show" className={styles.sheetField}>
              <NativeSelect value={archived} onChange={setArchivedFilter} options={ARCHIVE_OPTIONS} />
            </Field>
            <Button
              pressed={favoriteOnly}
              icon={<StarGlyph filled={favoriteOnly} />}
              onClick={() => setFavoriteOnly((v) => !v)}
            >
              Favorites only
            </Button>
          </>
        )}
      />
      <div className={styles.scroll}>{body()}</div>

      {openRow && (
        <BottomSheet open onClose={closeEntry} title={entryName(openRow)} fullHeight>
          <div className={styles.detail} data-testid="review-detail">
            <div className={styles.detailScroll}>
              <div className={styles.detailMeta}>
                <span>{MODE_ICONS[openRow.mode]} {MODE_LABELS[openRow.mode]}</span>
                <span>→ {openRow.nativeLanguage}</span>
                <span>{metaLine(openRow)}</span>
              </div>
              <Button
                className={styles.detailFavorite}
                pressed={openRow.favorite === 1}
                icon={<StarGlyph filled={openRow.favorite === 1} />}
                onClick={() => void favorite(openRow.uuid, openRow.favorite === 1)}
              >
                Favorite
              </Button>
              <p className={styles.fieldHint}>{FAVORITE_HINT}</p>
              {/* Keyed: alias and notes are uncontrolled drafts of THIS entry. */}
              <EntryDetail
                key={openRow.uuid}
                row={openRow}
                onAlias={saveAlias}
                onNotes={saveNotes}
                onArchive={(uuid, isArchived) => void archiveFromSheet(uuid, isArchived)}
                onDelete={setDeleting}
                className={styles.reviewDetailBody}
              />
            </div>
          </div>
        </BottomSheet>
      )}
      <ConfirmSheet
        open={deleting !== null}
        title="Delete this saved entry?"
        message="Its source, response and notes are removed from this device. This cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={cancelDelete}
      />
    </div>
  );
}

function ReviewRow({ row, onOpen, onFavorite }: {
  row: DbTranslationLog;
  onOpen: (uuid: string) => void;
  onFavorite: (uuid: string, isFavorite: boolean) => void;
}) {
  const favorited = row.favorite === 1;
  const titleId = useId();
  return (
    <li className={styles.row}>
      <IconButton
        className={styles.rowStar}
        tone="warning"
        pressed={favorited}
        label="Favorite"
        tooltip={false}
        aria-describedby={titleId}
        onClick={() => onFavorite(row.uuid, favorited)}
      >
        <StarGlyph filled={favorited} />
      </IconButton>
      <button type="button" className={styles.rowButton} onClick={() => onOpen(row.uuid)}>
        <span className={styles.rowTop}>
          <span aria-hidden="true">{MODE_ICONS[row.mode]}</span>
          <span className={styles.rowTitle} id={titleId}>{entryName(row)}</span>
          <Chip tone="info">→ {row.nativeLanguage}</Chip>
          {row.archived === 1 && <Chip>archived</Chip>}
        </span>
        <span className={styles.rowMeta}>{metaLine(row)}</span>
        <span className={styles.rowText}>{(sourceTextOf(row) || NO_SOURCE).slice(0, 220)}</span>
      </button>
    </li>
  );
}
