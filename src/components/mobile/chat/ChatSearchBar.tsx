/**
 * ChatSearchBar — search the chat (AASC-41, feature 54): a field over the top of
 * the list, opened from the session's ⋯ menu ("Search this chat") or the keyboard
 * button (never by scrolling, since Oct 21 2026), with "3 of 12" and previous / next. Return goes to the next
 * match, Escape closes. It searches the rows loaded so far, and says so while
 * earlier ones exist.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CrossIcon, SearchIcon } from './chatViewIcons';
import styles from '@/styles/modules/mobile/Chat.module.css';

export interface ChatSearchBarProps {
  shown: boolean;
  query: string;
  onQuery: (query: string) => void;
  /** Matches found, and which one is current (-1: none yet). */
  count: number;
  index: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  /** Earlier rows exist that aren't loaded (and so aren't searched). */
  partial: boolean;
  /** Focus the field when it opens from the keyboard button. */
  focusToken: number;
}

export default function ChatSearchBar({ shown, query, onQuery, count, index, onStep, onClose, partial, focusToken }: ChatSearchBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusToken > 0) input.current?.focus();
  }, [focusToken]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Short on screen ("3/12"), so the field keeps its width; read out in full ("3 of 12").
  const at = index >= 0 ? index + 1 : 0;
  const more = partial ? '+' : '';
  const status = !query.trim() ? '' : count === 0 ? 'None' : `${at}/${count}${more}`;
  const statusLabel = count === 0 ? 'No matches' : `${at} of ${count}${more}`;

  return (
    <div className={`${styles.search}${shown ? ` ${styles.searchShown}` : ''}`} role="search" aria-hidden={shown ? undefined : true} data-testid="chat-search">
      <label className={styles.searchField}>
        <SearchIcon size={16} />
        <input
          ref={input}
          type="search"
          className={styles.searchInput}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search this chat"
          aria-label={partial ? 'Search this chat (loaded messages)' : 'Search this chat'}
          enterKeyHint="search"
          tabIndex={shown ? 0 : -1}
        />
      </label>
      {status && <span className={styles.searchCount} aria-live="polite" aria-label={statusLabel}>{status}</span>}
      <button type="button" className={styles.iconBtn} onClick={() => onStep(-1)} disabled={count === 0} aria-label="Previous match" tabIndex={shown ? 0 : -1}>
        <ArrowUpIcon size={18} />
      </button>
      <button type="button" className={styles.iconBtn} onClick={() => onStep(1)} disabled={count === 0} aria-label="Next match" tabIndex={shown ? 0 : -1}>
        <ArrowDownIcon size={18} />
      </button>
      <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close search" tabIndex={shown ? 0 : -1}>
        <CrossIcon size={18} />
      </button>
    </div>
  );
}
