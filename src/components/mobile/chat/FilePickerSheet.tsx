/**
 * FilePickerSheet — "@" a file from the session's project (AASC-42).
 *
 * Reads the Mac's file index (`GET /api/files/search`, the phone's read-only
 * `files` rule): with nothing typed, the shallowest entries; then the names
 * that match. While the Mac is still indexing the project it says so and asks
 * again. Picking one hands the composer its path relative to the project, for
 * an `@path` mention.
 */
import { useEffect, useState } from 'react';
import { EmptyState, ListRow, ListSection, Sheet } from '../kit';
import { searchNames, type NameHit } from '@/lib/phoneFiles';
import { FileIcon, FolderIcon, SearchIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

export interface FilePickerSheetProps {
  open: boolean;
  onClose: () => void;
  projectPath: string | null | undefined;
  initialQuery?: string;
  /** The path relative to the project (no leading slash). */
  onPick: (path: string) => void;
}

const LARGE = ['large'] as const;
const DEBOUNCE_MS = 200;
const INDEXING_RETRY_MS = 1200;
const MAX_RESULTS = 60;

type Result = { query: string; hits: NameHit[]; indexing: boolean; error: string | null };

export default function FilePickerSheet({ open, onClose, projectPath, initialQuery = '', onPick }: FilePickerSheetProps) {
  const [query, setQuery] = useState(initialQuery);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setQuery(initialQuery);
  }
  const [result, setResult] = useState<Result | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || !projectPath) return undefined;
    const controller = new AbortController();
    const q = query.trim();
    const timer = setTimeout(() => {
      searchNames(projectPath, q, controller.signal)
        .then((res) => {
          if (res.ok) setResult({ query: q, hits: res.data.results ?? [], indexing: !!res.data.indexing, error: null });
          else setResult({ query: q, hits: [], indexing: false, error: res.status === 429 ? 'Too many searches. Wait a moment.' : 'Your Mac couldn’t search this project.' });
        })
        .catch(() => { /* aborted: a newer search is on its way */ });
    }, q ? DEBOUNCE_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, projectPath, query, retry]);

  // An index still being built answers empty: ask again shortly.
  useEffect(() => {
    if (!open || !result?.indexing) return undefined;
    const timer = setTimeout(() => setRetry((n) => n + 1), INDEXING_RETRY_MS);
    return () => clearTimeout(timer);
  }, [open, result]);

  const current = result && result.query === query.trim() ? result : null;
  const hits = current?.hits.slice(0, MAX_RESULTS) ?? [];

  return (
    <Sheet open={open} onClose={onClose} title="Mention a file" detents={LARGE} testId="file-sheet">
      <label className={styles.search}>
        <SearchIcon />
        <input
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files in the project"
          aria-label="Search files in the project"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </label>
      {!projectPath ? (
        <EmptyState title="No project" message="This session has no project folder to pick from." />
      ) : !current ? (
        <EmptyState live title="Searching…" />
      ) : current.error ? (
        <EmptyState title="Couldn’t search" message={current.error} />
      ) : current.indexing && hits.length === 0 ? (
        <EmptyState live title="Your Mac is indexing this project…" message="Files show up here in a moment." />
      ) : hits.length === 0 ? (
        <EmptyState title="Nothing matches" message={`No file name has “${query.trim()}” in it.`} />
      ) : (
        <ListSection header={query.trim() ? 'Matching files' : 'In this project'}>
          {hits.map((hit) => {
            const path = hit.path.replace(/^\/+/, '');
            const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            return (
              <ListRow
                key={path}
                leading={<span className={styles.leading}>{hit.type === 'dir' ? <FolderIcon /> : <FileIcon />}</span>}
                title={hit.name}
                subtitle={folder || undefined}
                onClick={() => onPick(hit.type === 'dir' ? `${path}/` : path)}
                ariaLabel={`${hit.type === 'dir' ? 'Folder' : 'File'} ${path}`}
              />
            );
          })}
        </ListSection>
      )}
    </Sheet>
  );
}
