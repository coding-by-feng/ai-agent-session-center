/**
 * ProjectSearch — the Project tab's search (AASC-20): Names (the Mac's fuzzy
 * index, as you type) or Text (GET /api/files/grep, on Search; no glob, which a
 * paired phone may not pass). A text hit opens the file at its line with the
 * query marked; Back returns here with the results kept (the state lives in the
 * browser, above this screen).
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { searchNames, searchText, type NameHit, type TextHit } from '@/lib/phoneFiles';
import { fileErrorText, normalizeRel, parentRel } from '@/lib/phoneProject';
import Highlighted from './Highlighted';
import type { SearchMode, SearchState } from './searchState';
import { ChevronIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

const NAME_DEBOUNCE_MS = 350;
const INDEX_RETRIES = 5;

export default function ProjectSearch({
  projectPath,
  state,
  setState,
  onOpenDir,
  onOpenFile,
}: {
  projectPath: string;
  state: SearchState;
  setState: Dispatch<SetStateAction<SearchState>>;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string, line?: number, query?: string) => void;
}) {
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    // A search cut short by leaving the screen must not leave Search disabled on return.
    setState((s) => (s.busy ? { ...s, busy: false } : s));
  }, [setState]);

  const run = useCallback(async (query: string, mode: SearchMode) => {
    const q = query.trim();
    if (timer.current) clearTimeout(timer.current);
    if (!q || (mode === 'text' && q.length < 2)) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, busy: true, error: null }));
    for (let attempt = 0; ; attempt++) {
      const result = mode === 'names' ? await searchNames(projectPath, q) : await searchText(projectPath, q);
      if (id !== seq.current) return;
      if (!result.ok) {
        setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, names: [], text: [], truncated: false, error: fileErrorText(result.status, 'folder').title }));
        return;
      }
      if (mode === 'text') {
        const data = result.data as { matches?: TextHit[]; truncated?: boolean };
        setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, text: data.matches ?? [], names: [], truncated: !!data.truncated }));
        return;
      }
      const data = result.data as { results?: NameHit[]; indexing?: boolean };
      // A cold index answers empty while it builds: ask again shortly.
      if ((data.results ?? []).length === 0 && data.indexing && attempt < INDEX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (id !== seq.current) return;
        continue;
      }
      setState((s) => ({ ...s, busy: false, ran: { query: q, mode }, names: (data.results ?? []).slice(0, 100), text: [], truncated: false }));
      return;
    }
  }, [projectPath, setState]);

  const onQuery = (query: string) => {
    setState((s) => ({ ...s, query }));
    if (timer.current) clearTimeout(timer.current);
    // Names follow the typing; a text search waits for Search (it reads every file).
    if (state.mode === 'names' && query.trim()) {
      timer.current = setTimeout(() => void run(query, 'names'), NAME_DEBOUNCE_MS);
    }
  };

  const setMode = (mode: SearchMode) => {
    setState((s) => ({ ...s, mode }));
    if (state.query.trim()) void run(state.query, mode);
    inputRef.current?.focus();
  };

  const ran = state.ran;
  const grouped = groupByFile(state.text);

  return (
    <div className={styles.search}>
      <form
        className={styles.searchForm}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(state.query, state.mode);
          inputRef.current?.blur();
        }}
      >
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="search"
          value={state.query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={state.mode === 'names' ? 'File or folder name' : 'Text in files'}
          aria-label={state.mode === 'names' ? 'Search file and folder names' : 'Search text in files'}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          // The user tapped Search: the keyboard is what they came for.
          autoFocus={!state.ran}
        />
        <Button type="submit" variant="primary" disabled={!state.query.trim() || state.busy}>
          Search
        </Button>
      </form>
      <div className={styles.segment} role="group" aria-label="Search in">
        <button type="button" className={styles.segmentBtn} aria-pressed={state.mode === 'names'} onClick={() => setMode('names')}>
          Names
        </button>
        <button type="button" className={styles.segmentBtn} aria-pressed={state.mode === 'text'} onClick={() => setMode('text')}>
          Text
        </button>
      </div>
      <div className={styles.searchResults} aria-live="polite" aria-busy={state.busy || undefined}>
        {state.error ? (
          <EmptyState tone="error" compact title={state.error} action={<Button onClick={() => void run(state.query, state.mode)}>Try again</Button>} />
        ) : !ran ? (
          <p className={styles.searchHint}>
            {state.mode === 'names' ? 'Type part of a file or folder name.' : 'Type at least two characters, then Search. A match opens the file at its line.'}
          </p>
        ) : ran.mode === 'names' ? (
          state.names.length === 0 ? (
            <EmptyState compact title={`No names match “${ran.query}”`} />
          ) : (
            <ul className={styles.list} aria-label="Matching names">
              {state.names.map((hit) => {
                const isDir = hit.type === 'dir';
                const path = normalizeRel(hit.path);
                return (
                  <li key={hit.path}>
                    <button type="button" className={styles.row} onClick={() => (isDir ? onOpenDir(path) : onOpenFile(path))}>
                      <span className={`${styles.rowIcon}${isDir ? ` ${styles.rowIconDir}` : ''}`} aria-hidden="true">
                        <FileTypeIcon name={hit.name} isDir={isDir} />
                      </span>
                      <span className={styles.rowText}>
                        <span className={styles.rowName}>{hit.name}</span>
                        <span className={styles.rowMeta}>{parentRel(path) === '/' ? 'Project folder' : parentRel(path).slice(1)}</span>
                      </span>
                      {isDir && <ChevronIcon className={styles.rowChevron} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : grouped.length === 0 ? (
          <EmptyState compact title={`No text matches “${ran.query}”`} />
        ) : (
          <>
            <p className={styles.searchHint}>
              {state.text.length} match{state.text.length === 1 ? '' : 'es'} in {grouped.length} file{grouped.length === 1 ? '' : 's'}
              {state.truncated ? ' (the first 500)' : ''}
            </p>
            <ul className={styles.hitGroups} aria-label="Matching lines">
              {grouped.map(([file, hits]) => (
                <li key={file} className={styles.hitGroup}>
                  <p className={styles.hitFile}>{file.replace(/^\//, '')}</p>
                  <ul className={styles.hitLines}>
                    {hits.map((hit) => (
                      <li key={`${hit.file}:${hit.line}`}>
                        <button
                          type="button"
                          className={styles.hitLine}
                          onClick={() => onOpenFile(normalizeRel(hit.file), hit.line, ran.query)}
                          aria-label={`${file.replace(/^\//, '')} line ${hit.line}: ${hit.text.trim()}`}
                        >
                          <span className={styles.hitNum}>{hit.line}</span>
                          <span className={styles.hitText}><Highlighted text={hit.text.trim()} query={ran.query} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function groupByFile(hits: readonly TextHit[]): Array<[string, TextHit[]]> {
  const groups = new Map<string, TextHit[]>();
  for (const hit of hits) groups.set(hit.file, [...(groups.get(hit.file) ?? []), hit]);
  return [...groups.entries()];
}
