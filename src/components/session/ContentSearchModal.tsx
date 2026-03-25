/**
 * ContentSearchModal — grep-style content search across project files.
 * Triggered by Cmd/Ctrl+F when the Project tab is active.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFileSystemProvider } from '@/lib/fileSystemProvider';
import type { GrepMatch } from '@/lib/fileSystemProvider';
import styles from '@/styles/modules/ContentSearch.module.css';

interface ContentSearchModalProps {
  projectPath: string;
  onFileOpen: (filePath: string, line?: number) => void;
  onClose: () => void;
}

interface GroupedResult {
  file: string;
  matches: GrepMatch[];
}

export default function ContentSearchModal({ projectPath, onFileOpen, onClose }: ContentSearchModalProps) {
  const [query, setQuery] = useState('');
  const [globFilter, setGlobFilter] = useState('');
  const [results, setResults] = useState<GrepMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef(false);
  const provider = useMemo(() => getFileSystemProvider(), []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) {
      setResults([]);
      setError(null);
      setTruncated(false);
      setLoading(false);
      return;
    }

    abortRef.current = true; // cancel previous
    clearTimeout(debounceRef.current);
    setLoading(true);

    debounceRef.current = setTimeout(async () => {
      abortRef.current = false;
      try {
        const data = await provider.grepContent(
          projectPath,
          query.trim(),
          globFilter.trim() || undefined,
        );
        if (abortRef.current) return;
        setResults(data.matches);
        setTruncated(data.truncated);
        setSelectedIdx(0);
        setSelectedFile(null);
        setError(null);
      } catch (err) {
        if (abortRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
      } finally {
        if (!abortRef.current) setLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(debounceRef.current);
      abortRef.current = true;
    };
  }, [query, globFilter, projectPath, provider]);

  // Group results by file
  const grouped: GroupedResult[] = useMemo(() => {
    const map = new Map<string, GrepMatch[]>();
    for (const m of results) {
      const existing = map.get(m.file);
      if (existing) existing.push(m);
      else map.set(m.file, [m]);
    }
    return [...map.entries()].map(([file, matches]) => ({ file, matches }));
  }, [results]);

  // Flat list for keyboard navigation
  const flatItems = useMemo(() => {
    const items: Array<{ file: string; line: number; text: string; isHeader: boolean }> = [];
    for (const g of grouped) {
      items.push({ file: g.file, line: 0, text: '', isHeader: true });
      for (const m of g.matches) {
        items.push({ file: m.file, line: m.line, text: m.text, isHeader: false });
      }
    }
    return items;
  }, [grouped]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => {
        let next = i + 1;
        while (next < flatItems.length && flatItems[next].isHeader) next++;
        return Math.min(next, flatItems.length - 1);
      });
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => {
        let next = i - 1;
        while (next >= 0 && flatItems[next].isHeader) next--;
        return Math.max(next, 0);
      });
      return;
    }
    if (e.key === 'Enter') {
      const item = flatItems[selectedIdx];
      if (item && !item.isHeader) {
        onFileOpen(item.file, item.line);
        onClose();
      }
      return;
    }
  }, [flatItems, selectedIdx, onFileOpen, onClose]);

  const handleMatchClick = useCallback((file: string, line: number) => {
    onFileOpen(file, line);
    onClose();
  }, [onFileOpen, onClose]);

  const highlightText = useCallback((text: string) => {
    if (!query.trim()) return text;
    const q = query.trim();
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark className={styles.highlight}>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  }, [query]);

  let flatIdx = -1;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.inputRow}>
            <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="7" cy="7" r="5" />
              <line x1="11" y1="11" x2="14.5" y2="14.5" />
            </svg>
            <input
              ref={inputRef}
              className={styles.input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search in files..."
              spellCheck={false}
            />
            <input
              className={styles.globInput}
              value={globFilter}
              onChange={(e) => setGlobFilter(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="*.ts"
              title="File glob filter (e.g. *.ts, *.py)"
              spellCheck={false}
            />
          </div>
          {loading && <div className={styles.loadingBar} />}
        </div>

        <div className={styles.results}>
          {error && <div className={styles.error}>{error}</div>}

          {!loading && !error && results.length === 0 && query.trim().length >= 2 && (
            <div className={styles.empty}>No matches found</div>
          )}

          {!error && query.trim().length < 2 && (
            <div className={styles.empty}>Type at least 2 characters to search</div>
          )}

          {grouped.map((group) => (
            <div key={group.file} className={styles.group}>
              <button
                className={`${styles.groupHeader} ${selectedFile === group.file ? styles.groupHeaderActive : ''}`}
                onClick={() => setSelectedFile(selectedFile === group.file ? null : group.file)}
              >
                <span className={styles.groupFile}>
                  {group.file.split('/').pop()}
                </span>
                <span className={styles.groupPath}>{group.file}</span>
                <span className={styles.groupCount}>{group.matches.length}</span>
              </button>
              {(() => { flatIdx++; return null; })()}
              {group.matches.map((m) => {
                flatIdx++;
                const currentIdx = flatIdx;
                return (
                  <button
                    key={`${m.file}:${m.line}`}
                    className={`${styles.match} ${currentIdx === selectedIdx ? styles.matchActive : ''}`}
                    onClick={() => handleMatchClick(m.file, m.line)}
                  >
                    <span className={styles.matchLine}>{m.line}</span>
                    <span className={styles.matchText}>{highlightText(m.text)}</span>
                  </button>
                );
              })}
            </div>
          ))}

          {truncated && (
            <div className={styles.truncated}>
              Results truncated. Refine your search query or add a file filter.
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerHint}>
            {results.length > 0 ? `${results.length} matches in ${grouped.length} files` : ''}
          </span>
          <span className={styles.footerKeys}>
            <kbd>Enter</kbd> open &middot; <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
