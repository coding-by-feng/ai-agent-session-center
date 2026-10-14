/**
 * useReviewLog — the REVIEW tab's entries (IndexedDB, this device only) and
 * their writes, for the desktop view and the phone's.
 *
 * The list re-reads every POLL_MS: a response captured when a floating session
 * closes, or an entry saved by a background spawn, shows up without a reload.
 * A failed read keeps the rows already on screen and reports `loadError`; a
 * failed write says so in a toast instead of an unhandled rejection (notes
 * saved on blur were otherwise lost silently).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listLogs,
  setAlias,
  setArchived,
  setFavorite,
  setNotes,
  deleteLog,
  type ListFilters,
} from '@/lib/translationLog';
import type { DbTranslationLog } from '@/lib/db';
import { POLL_MS, errorText } from '@/lib/reviewEntry';
import { showToast } from '@/components/ui/ToastContainer';

export interface ReviewLog {
  rows: DbTranslationLog[];
  /** False until the first read settles: an empty list before it is not "nothing saved". */
  loaded: boolean;
  loadError: string | null;
  reload: () => void;
  archive: (uuid: string, isArchived: boolean) => Promise<void>;
  saveNotes: (uuid: string, value: string) => Promise<void>;
  favorite: (uuid: string, isFavorite: boolean) => Promise<void>;
  saveAlias: (uuid: string, value: string) => Promise<void>;
  /**
   * Deletes without asking (the caller confirms); false when the write failed.
   * Does not re-read: the caller moves focus off the row first, while it is
   * still in the DOM, then calls `reload`.
   */
  remove: (uuid: string) => Promise<boolean>;
}

export function useReviewLog(filters: ListFilters): ReviewLog {
  const [rows, setRows] = useState<DbTranslationLog[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

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

  useEffect(() => {
    const interval = setInterval(reload, POLL_MS);
    return () => clearInterval(interval);
  }, [reload]);

  const persist = useCallback(async (write: Promise<unknown>, failure: string) => {
    try {
      await write;
    } catch (err) {
      showToast(`${failure}: ${errorText(err)}`, 'error');
    }
    reload();
  }, [reload]);

  const archive = useCallback(
    (uuid: string, isArchived: boolean) =>
      persist(setArchived(uuid, !isArchived), isArchived ? 'Could not unarchive the entry' : 'Could not archive the entry'),
    [persist],
  );
  const saveNotes = useCallback(
    (uuid: string, value: string) => persist(setNotes(uuid, value), 'Could not save your notes'),
    [persist],
  );
  const favorite = useCallback(
    (uuid: string, isFavorite: boolean) => persist(setFavorite(uuid, !isFavorite), 'Could not change the favorite'),
    [persist],
  );
  const saveAlias = useCallback(
    (uuid: string, value: string) => persist(setAlias(uuid, value.trim()), 'Could not save the alias'),
    [persist],
  );
  const remove = useCallback(async (uuid: string) => {
    try {
      await deleteLog(uuid);
    } catch (err) {
      showToast(`Could not delete the entry: ${errorText(err)}`, 'error');
      return false;
    }
    return true;
  }, []);

  return { rows, loaded, loadError, reload, archive, saveNotes, favorite, saveAlias, remove };
}
