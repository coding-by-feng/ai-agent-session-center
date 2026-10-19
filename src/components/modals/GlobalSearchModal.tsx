/**
 * GlobalSearchModal — search across all sessions' prompts, responses, and tool logs.
 * Triggered by Cmd+Shift+F (macOS) / Ctrl+Shift+F (other), and on a phone by
 * the search buttons on LIVE and in the session drawer (AASC-18), where it
 * fills the screen and has a Close button (no Esc key, no outside to tap).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useIsMobile } from '@/lib/platform';
import { searchSessionContent, type ContentField, type ContentHit } from '@/lib/sessionContentSearch';
import styles from '@/styles/modules/GlobalSearchModal.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MatchField = ContentField;
type SearchHit = ContentHit;

// ---------------------------------------------------------------------------
// Status colors
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  working:   'var(--accent-orange)',
  prompting: 'var(--accent-cyan)',
  approval:  'var(--accent-yellow)',
  input:     'var(--accent-purple)',
  waiting:   'var(--accent-cyan)',
  idle:      'var(--accent-green)',
  ended:     'var(--accent-red)',
  connecting:'var(--accent-cyan)',
};

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

function highlightSnippet(text: string, query: string): string {
  const MAX = 200;
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  let snippet = text;
  if (text.length > MAX) {
    const start = Math.max(0, idx - 60);
    snippet = (start > 0 ? '…' : '') + text.slice(start, start + MAX) + (start + MAX < text.length ? '…' : '');
  }
  // Escape HTML
  const safe = snippet.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${safeQuery})`, 'gi'), '<mark>$1</mark>');
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<MatchField, string> = {
  prompt: 'PROMPT',
  response: 'RESPONSE',
  tool: 'TOOL',
  event: 'EVENT',
};

export default function GlobalSearchModal() {
  const activeModal = useUiStore((s) => s.activeModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const sessions = useSessionStore((s) => s.sessions);
  const selectSession = useSessionStore((s) => s.selectSession);

  const isOpen = activeModal === 'global-search';
  const isMobile = useIsMobile();

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => searchSessionContent(sessions.values(), query), [sessions, query]);

  // Reset selection when hits change
  useEffect(() => { setSelectedIdx(0); }, [hits.length]);

  // Focus input when opened; reset when closed
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [isOpen]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleSelect = useCallback((hit: SearchHit) => {
    selectSession(hit.sessionId);
    closeModal();
    // If it's a text match, trigger the in-panel search with the same query
    setTimeout(() => {
      document.dispatchEvent(new CustomEvent('detail-panel:find'));
    }, 150);
  }, [selectSession, closeModal]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((i) => Math.min(i + 1, hits.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((i) => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter' && hits[selectedIdx]) { handleSelect(hits[selectedIdx]); return; }
  }, [hits, selectedIdx, handleSelect, closeModal]);

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={closeModal}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} data-testid="global-search">
        {/* Search input */}
        <div className={styles.inputRow}>
          <span className={styles.searchIcon}>&#128269;</span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search all sessions — prompts, responses, tool calls…"
            spellCheck={false}
          />
          {query && (
            <span className={styles.hitCount}>{hits.length} hit{hits.length !== 1 ? 's' : ''}</span>
          )}
          {isMobile && (
            <button type="button" className={styles.closeBtn} onClick={closeModal} aria-label="Close search">
              ×
            </button>
          )}
        </div>

        {/* Results */}
        <div className={styles.results} ref={listRef}>
          {!query && (
            <div className={styles.emptyHint}>
              Type to search across all session content
            </div>
          )}
          {query && hits.length === 0 && (
            <div className={styles.emptyHint}>No matches found</div>
          )}
          {hits.map((hit, i) => (
            <button
              key={`${hit.sessionId}-${hit.field}-${hit.timestamp}`}
              data-idx={i}
              className={`${styles.hitRow} ${i === selectedIdx ? styles.selected : ''}`}
              onClick={() => handleSelect(hit)}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <div className={styles.hitMeta}>
                <span
                  className={styles.sessionDot}
                  style={{ background: STATUS_COLORS[hit.sessionStatus] ?? '#888' }}
                />
                <span className={styles.sessionName}>{hit.sessionTitle}</span>
                <span className={`${styles.fieldBadge} ${styles[`field_${hit.field}`]}`}>
                  {FIELD_LABELS[hit.field]}
                </span>
              </div>
              <div
                className={styles.snippet}
                dangerouslySetInnerHTML={{ __html: highlightSnippet(hit.snippet, query) }}
              />
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className={styles.footer}>
          <span>&#8593;&#8595; navigate</span>
          <span>&#8629; select &amp; find</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
