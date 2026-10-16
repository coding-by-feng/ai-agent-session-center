/**
 * FindBar — find in the open file, on a phone (AASC-56): one 16px field (iOS
 * zooms into anything smaller), "3 of 11", previous / next and close, each a
 * 44px target. Return steps forward, Shift+Return back, Escape closes. The
 * matching itself is the viewer's (the same rule as the project search).
 */
import { useEffect, useRef } from 'react';
import { CloseIcon, DownIcon, UpIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

export interface FindBarProps {
  query: string;
  onQuery: (query: string) => void;
  /** Matches found; null while they are being counted. */
  count: number | null;
  /** The current match, 0-based. */
  index: number;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
}

function countWords(query: string, count: number | null, index: number): string {
  if (!query.trim()) return '';
  if (count === null) return 'Finding…';
  if (count === 0) return 'No matches';
  return `${index + 1} of ${count}`;
}

export default function FindBar({ query, onQuery, count, index, onStep, onClose }: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const words = countWords(query, count, index);
  const none = !count;
  return (
    <div className={styles.findBar} role="search" aria-label="Find in this file">
      <input
        ref={inputRef}
        className={styles.findInput}
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in this file"
        aria-label="Find in this file"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <span className={styles.findCount} role="status" aria-live="polite">{words}</span>
      <button type="button" className={styles.iconBtn} onClick={() => onStep(-1)} disabled={none} aria-label="Previous match">
        <UpIcon />
      </button>
      <button type="button" className={styles.iconBtn} onClick={() => onStep(1)} disabled={none} aria-label="Next match">
        <DownIcon />
      </button>
      <button type="button" className={styles.iconBtn} onClick={onClose} aria-label="Close find">
        <CloseIcon />
      </button>
    </div>
  );
}
