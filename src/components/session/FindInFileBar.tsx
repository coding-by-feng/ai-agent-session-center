/**
 * FindInFileBar — inline search bar for finding text within the currently open file.
 * Triggered by Cmd/Ctrl+F or the toolbar icon.
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import styles from '@/styles/modules/FindInFileBar.module.css';

interface FindInFileBarProps {
  fileContent: string;
  onClose: () => void;
  onScrollToLine: (lineNumber: number) => void;
  /** Expose current search term so parent can highlight matches in the code viewer */
  onTermChange: (term: string, caseSensitive: boolean) => void;
}

interface MatchPosition {
  line: number;
  col: number;
}

export default function FindInFileBar({
  fileContent,
  onClose,
  onScrollToLine,
  onTermChange,
}: FindInFileBarProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Compute all match positions
  const matches: MatchPosition[] = useMemo(() => {
    if (!query || !fileContent) return [];
    const lines = fileContent.split('\n');
    const result: MatchPosition[] = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
      let col = haystack.indexOf(needle);
      while (col !== -1) {
        result.push({ line: i + 1, col });
        col = haystack.indexOf(needle, col + 1);
      }
    }
    return result;
  }, [query, fileContent, caseSensitive]);

  // Notify parent of term changes
  useEffect(() => {
    onTermChange(query, caseSensitive);
  }, [query, caseSensitive, onTermChange]);

  // Scroll to active match
  useEffect(() => {
    if (matches.length > 0 && activeIdx >= 0 && activeIdx < matches.length) {
      onScrollToLine(matches[activeIdx].line);
    }
  }, [activeIdx, matches, onScrollToLine]);

  // Reset active index when matches change
  useEffect(() => {
    setActiveIdx(0);
  }, [matches.length]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i + 1) % matches.length);
  }, [matches.length]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
      return;
    }
  }, [onClose, goNext, goPrev]);

  return (
    <div className={styles.bar}>
      <div className={styles.inputGroup}>
        <svg className={styles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14.5" y2="14.5" />
        </svg>
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Find in file..."
          spellCheck={false}
        />
        <button
          className={`${styles.toggleBtn} ${caseSensitive ? styles.toggleBtnActive : ''}`}
          onClick={() => setCaseSensitive((p) => !p)}
          title="Match case"
        >
          Aa
        </button>
      </div>

      <span className={styles.count}>
        {query ? (matches.length > 0 ? `${activeIdx + 1} of ${matches.length}` : 'No results') : ''}
      </span>

      <div className={styles.navGroup}>
        <button
          className={styles.navBtn}
          onClick={goPrev}
          disabled={matches.length === 0}
          title="Previous match (Shift+Enter)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
        <button
          className={styles.navBtn}
          onClick={goNext}
          disabled={matches.length === 0}
          title="Next match (Enter)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      <button className={styles.closeBtn} onClick={onClose} title="Close (Esc)">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Highlight matching text segments within a single line.
 * Used by the code viewer to render find-in-file highlights.
 */
export function highlightFindMatches(
  text: string,
  term: string,
  caseSensitive: boolean,
  activeLineMatch?: { line: number; col: number },
  currentLine?: number,
): React.ReactNode {
  if (!term || !text) return text || '\u00A0';
  const needle = caseSensitive ? term : term.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let col = haystack.indexOf(needle);
  let matchIdx = 0;

  while (col !== -1) {
    if (col > lastIdx) parts.push(text.slice(lastIdx, col));
    const isActive = activeLineMatch
      && currentLine === activeLineMatch.line
      && col === activeLineMatch.col;
    parts.push(
      <mark
        key={`m${matchIdx++}`}
        className={isActive ? 'find-match-active' : 'find-match'}
      >
        {text.slice(col, col + term.length)}
      </mark>,
    );
    lastIdx = col + term.length;
    col = haystack.indexOf(needle, lastIdx);
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : (text || '\u00A0');
}
