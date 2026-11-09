/**
 * TerminalSearchBar — find in the terminal's output (Nov 6 2026).
 *
 * Floats over the terminal's top-right corner rather than taking a row above it: a row
 * would change the terminal's height, and a re-fit resizes the PTY and re-wraps its
 * scrollback. Opened by the toolbar's 🔍 or ⌘F / Ctrl+F inside the terminal (useTerminal).
 *
 * Searches the whole scrollback through `@xterm/addon-search`, highlighting every match.
 * Enter / Shift+Enter step, Esc or ✕ closes: highlights cleared, focus back in the terminal.
 * New output keeps the count current without moving the view (the addon re-highlights).
 *
 * Controlled: the query and toggles live in the parent, because fullscreen renders the bar
 * in another place (a remount) and must not lose them.
 */
import { useEffect, useRef, useState } from 'react';
import type { SearchAddon } from '@xterm/addon-search';
import {
  TERMINAL_SEARCH_DEBOUNCE_MS,
  addonSearch,
  formatMatchCount,
  isTerminalFindKey,
  isValidSearchRegex,
  type SearchResults,
} from '@/lib/terminalSearch';
import { isMac } from '@/lib/shortcutKeys';
import styles from '@/styles/modules/TerminalSearchBar.module.css';

export interface TerminalSearchState {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

export interface TerminalSearchBarProps extends TerminalSearchState {
  /** The attached terminal's addon; read again whenever `terminalId` changes. */
  getAddon: () => SearchAddon | null;
  terminalId: string | null;
  /** Bumped by every open request (⌘F again): refocus and select the field. */
  openSeq: number;
  onChange: (patch: Partial<TerminalSearchState>) => void;
  onClose: () => void;
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={up ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export default function TerminalSearchBar({
  getAddon, terminalId, openSeq, query, caseSensitive, regex, onChange, onClose,
}: TerminalSearchBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Tagged with its terminal, so a re-attach never shows the previous terminal's count. */
  const [answer, setAnswer] = useState<(SearchResults & { terminalId: string | null }) | null>(null);
  const results = answer && answer.terminalId === terminalId && query ? answer : null;
  const badRegex = regex && !!query && !isValidSearchRegex(query);
  const getAddonRef = useRef(getAddon);
  useEffect(() => { getAddonRef.current = getAddon; }, [getAddon]);

  // Every open request: focus the field and select what is in it.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [openSeq]);

  // The count comes from the addon, for whichever terminal is attached.
  useEffect(() => {
    const addon = getAddonRef.current();
    if (!addon) return undefined;
    const sub = addon.onDidChangeResults((r) => setAnswer({ resultIndex: r.resultIndex, resultCount: r.resultCount, terminalId }));
    return () => {
      sub.dispose();
      addon.clearDecorations();
    };
  }, [terminalId]);

  // Search as you type (and when a toggle flips), after a short pause.
  useEffect(() => {
    const addon = getAddonRef.current();
    if (!addon) return undefined;
    const timer = setTimeout(() => {
      if (!query || badRegex) {
        addon.clearDecorations();
        return;
      }
      const { term, options } = addonSearch(query, { caseSensitive, regex });
      addon.findNext(term, { ...options, incremental: true });
    }, TERMINAL_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, regex, badRegex, terminalId]);

  const step = (back: boolean): void => {
    const addon = getAddonRef.current();
    if (!addon || !query || badRegex) return;
    const { term, options } = addonSearch(query, { caseSensitive, regex });
    if (back) addon.findPrevious(term, options);
    else addon.findNext(term, options);
  };

  // Esc and ⌘F anywhere in the bar (a toggle or arrow may hold focus): Esc closes this bar
  // only, and ⌘F re-selects the field instead of reaching the page's find in file.
  const onBarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (isTerminalFindKey(e, isMac)) {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    step(e.shiftKey);
  };

  const count = badRegex ? 'Bad regex' : formatMatchCount(query, results);
  const nothing = !query || badRegex || results?.resultCount === 0;

  return (
    <div className={styles.anchor}>
    <div className={styles.bar} role="search" aria-label="Find in terminal" data-testid="terminal-search-bar"
      onKeyDown={onBarKeyDown}>
      <label className={`${styles.field}${badRegex ? ` ${styles.fieldInvalid}` : ''}`}>
        <span className={styles.fieldIcon}><SearchIcon /></span>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          value={query}
          onChange={(e) => onChange({ query: e.target.value })}
          onKeyDown={onInputKeyDown}
          placeholder="Find"
          aria-label="Find in terminal"
          aria-invalid={badRegex || undefined}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <span className={styles.count} role="status" aria-live="polite">{count}</span>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={caseSensitive}
        aria-label="Match case"
        title="Match case"
        onClick={() => onChange({ caseSensitive: !caseSensitive })}
      >
        Aa
      </button>
      <button
        type="button"
        className={styles.toggle}
        aria-pressed={regex}
        aria-label="Use regular expression"
        title="Use regular expression"
        onClick={() => onChange({ regex: !regex })}
      >
        .*
      </button>
      <button type="button" className={styles.btn} aria-label="Previous match (Shift+Enter)" title="Previous match (Shift+Enter)"
        disabled={nothing} onClick={() => step(true)}>
        <ChevronIcon up />
      </button>
      <button type="button" className={styles.btn} aria-label="Next match (Enter)" title="Next match (Enter)"
        disabled={nothing} onClick={() => step(false)}>
        <ChevronIcon up={false} />
      </button>
      <button type="button" className={styles.btn} aria-label="Close find (Esc)" title="Close find (Esc)" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
    </div>
  );
}
