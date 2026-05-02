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
  /** Expose the currently-focused match so parent can distinguish it visually */
  onActiveMatchChange?: (match: { line: number; col: number } | null) => void;
  /** Flat 0-based active match index (or -1 when no matches) — used by rendered
   *  views (markdown, LaTeX) that walk the DOM to highlight matches. */
  onActiveIdxChange?: (idx: number, total: number) => void;
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
  onActiveMatchChange,
  onActiveIdxChange,
}: FindInFileBarProps) {
  const [query, setQuery] = useState<string>('');
  const [caseSensitive, setCaseSensitive] = useState<boolean>(false);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [didWrap, setDidWrap] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Scroll to active match and notify parent of its position
  useEffect(() => {
    if (matches.length > 0 && activeIdx >= 0 && activeIdx < matches.length) {
      const m = matches[activeIdx];
      onScrollToLine(m.line);
      onActiveMatchChange?.({ line: m.line, col: m.col });
      onActiveIdxChange?.(activeIdx, matches.length);
    } else {
      onActiveMatchChange?.(null);
      onActiveIdxChange?.(-1, matches.length);
    }
  }, [activeIdx, matches, onScrollToLine, onActiveMatchChange, onActiveIdxChange]);

  // Reset active index when matches change
  useEffect(() => {
    setActiveIdx(0);
  }, [matches.length]);

  const flashWrap = useCallback((): void => {
    setDidWrap(true);
    if (wrapTimerRef.current) clearTimeout(wrapTimerRef.current);
    wrapTimerRef.current = setTimeout(() => {
      setDidWrap(false);
      wrapTimerRef.current = null;
    }, 600);
  }, []);

  const goNext = useCallback((): void => {
    if (matches.length === 0) return;
    setActiveIdx((i) => {
      const next = (i + 1) % matches.length;
      if (i === matches.length - 1 && next === 0) flashWrap();
      return next;
    });
  }, [matches.length, flashWrap]);

  const goPrev = useCallback((): void => {
    if (matches.length === 0) return;
    setActiveIdx((i) => {
      const next = (i - 1 + matches.length) % matches.length;
      if (i === 0 && next === matches.length - 1) flashWrap();
      return next;
    });
  }, [matches.length, flashWrap]);

  // Cleanup the wrap-flash timer on unmount
  useEffect(() => {
    return () => {
      if (wrapTimerRef.current) {
        clearTimeout(wrapTimerRef.current);
        wrapTimerRef.current = null;
      }
    };
  }, []);

  // Document-level F3 / Shift+F3 while the bar is mounted
  useEffect(() => {
    const handleDocKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'F3') {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      }
    };
    document.addEventListener('keydown', handleDocKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDocKeyDown);
    };
  }, [goNext, goPrev]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent): void => {
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
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      goNext();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      goPrev();
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

      <span
        className={`${styles.count} ${didWrap ? styles.countWrapped : ''}`}
        data-wrapped={didWrap ? 'true' : 'false'}
      >
        {query ? (matches.length > 0 ? `${activeIdx + 1} of ${matches.length}` : 'No results') : ''}
      </span>

      <div className={styles.navGroup}>
        <button
          className={styles.navBtn}
          onClick={goPrev}
          disabled={matches.length === 0}
          title="Previous match (↑ / Shift+Enter / Shift+F3)"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
        <button
          className={styles.navBtn}
          onClick={goNext}
          disabled={matches.length === 0}
          title="Next match (↓ / Enter / F3)"
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
