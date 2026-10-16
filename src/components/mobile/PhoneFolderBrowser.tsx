/**
 * PhoneFolderBrowser — "Browse folders on the Mac" for a new session (AASC-54).
 *
 *   Choose a folder                       ✕
 *   Home › Documents › claude
 *   ┌──────────────────────────────────┐
 *   │ ▢ agent-manager   Used before   ›│
 *   │ ▢ new-idea                       ›│
 *   └──────────────────────────────────┘
 *   [ Use “claude” ]
 *
 * A tap on a folder opens it; a crumb goes back up. Folders only — no files,
 * nothing hidden or private, nothing outside the home folder (the Mac decides:
 * server/mobile/homeFolders.ts). "Use" hands the folder to the caller, which
 * asks "Start in a new folder?" when no agent has worked there.
 *
 * Phone-only (the kit): the desktop's NewSessionModal loads it with lazy().
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ListRow, ListSection, Sheet } from './kit';
import { FolderIcon } from './projectIcons';
import { fetchFolders, folderCrumbs, isKnownFolder, type FolderListing, type FolderResult } from '@/lib/folderBrowser';
import styles from '@/styles/modules/mobile/FolderBrowser.module.css';

export interface PhoneFolderBrowserProps {
  open: boolean;
  onClose: () => void;
  /** The chosen folder's real path, and the Mac's home folder. */
  onPick: (path: string, home: string) => void;
  /** Where it opens (the folder already in the form); the home folder when that can't be browsed. */
  startPath?: string | null;
  /** Folders an agent has worked in: marked "Used before". */
  known?: readonly string[];
}

const DETENTS = ['large'] as const;
const NO_KNOWN: readonly string[] = [];

interface BrowserState {
  /** The last folder listed (kept while the next one loads, so the crumbs don't jump). */
  listing: FolderListing | null;
  loading: boolean;
  error: string | null;
}

const lastName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

function FolderBrowserSheet({ onClose, onPick, startPath, known = NO_KNOWN }: Omit<PhoneFolderBrowserProps, 'open'>) {
  const [state, setState] = useState<BrowserState>({ listing: null, loading: true, error: null });
  // Only the newest request lands: a quick second tap must not be overwritten by the first answer.
  const request = useRef(0);

  const land = useCallback((id: number, result: FolderResult) => {
    if (id !== request.current) return;
    setState((s) => (result.ok
      ? { listing: result.data, loading: false, error: null }
      : { listing: s.listing, loading: false, error: result.message }));
  }, []);

  // The first folder: the one in the form, else the home folder.
  useEffect(() => {
    const requests = request;
    const id = ++requests.current;
    void (async () => {
      let result = await fetchFolders(startPath || null);
      if (!result.ok && startPath) result = await fetchFolders(null);
      land(id, result);
    })();
    return () => {
      requests.current++; // a closed (or re-run) browser drops the answer still on its way
    };
  }, [startPath, land]);

  const go = useCallback(async (path: string | null) => {
    const id = ++request.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    land(id, await fetchFolders(path));
  }, [land]);

  const { listing, loading, error } = state;
  // A deep folder's crumbs overflow: keep the current folder (the last crumb) in view.
  const crumbsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [listing]);
  const atHome = !!listing && listing.path === listing.home;
  const useReason = !listing ? 'Loading folders…'
    : loading ? 'Loading folders…'
      : atHome ? 'Choose a folder inside your home folder' : undefined;
  const crumbs = listing ? folderCrumbs(listing.path, listing.home) : [];

  const footer = (
    <Button
      variant="primary"
      block
      disabledReason={useReason}
      onClick={() => { if (listing) onPick(listing.path, listing.home); }}
    >
      {listing && !atHome ? `Use “${lastName(listing.path)}”` : 'Use this folder'}
    </Button>
  );

  return (
    <Sheet open onClose={onClose} title="Choose a folder" detents={DETENTS} footer={footer} testId="folder-browser">
      {crumbs.length > 0 && (
        <nav ref={crumbsRef} className={styles.crumbs} aria-label="Folder path">
          <ol className={styles.crumbList}>
            {crumbs.map((c, i) => (
              <li key={c.path} className={styles.crumb}>
                {i > 0 && <span className={styles.crumbSep} aria-hidden="true">›</span>}
                {i === crumbs.length - 1 ? (
                  <span className={styles.crumbCurrent} aria-current="page">{c.label}</span>
                ) : (
                  <button type="button" className={styles.crumbButton} onClick={() => void go(c.path)}>{c.label}</button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {error && (
        <div className={styles.notice} role="alert">
          <p className={styles.noticeText}>{error}</p>
          <Button small onClick={() => void go(null)}>Go to the home folder</Button>
        </div>
      )}
      {loading && <p className={styles.status} role="status">Loading folders…</p>}
      {listing && !loading && (
        listing.folders.length > 0 ? (
          <ListSection
            label={`Folders in ${lastName(listing.path)}`}
            footer={listing.truncated ? `Showing the first ${listing.folders.length} folders.` : undefined}
          >
            {listing.folders.map((f) => (
              <ListRow
                key={f.path}
                leading={<FolderIcon />}
                title={f.name}
                subtitle={isKnownFolder(f.path, known, listing.home) ? 'Used before' : undefined}
                chevron
                ariaLabel={`Open ${f.name}`}
                onClick={() => void go(f.path)}
              />
            ))}
          </ListSection>
        ) : (
          <p className={styles.status}>No folders here.</p>
        )
      )}
      <p className={styles.hint}>Hidden and private folders (like .ssh) aren’t shown.</p>
    </Sheet>
  );
}

export default function PhoneFolderBrowser({ open, ...rest }: PhoneFolderBrowserProps) {
  // Mounted only while open: every opening starts fresh at its folder.
  return open ? <FolderBrowserSheet {...rest} /> : null;
}
