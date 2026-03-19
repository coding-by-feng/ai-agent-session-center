/**
 * GlobalSearchModal — search across all sessions' prompts, responses, and tool logs.
 * Triggered by Cmd+Shift+F (macOS) / Ctrl+Shift+F (other).
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types/session';
import styles from '@/styles/modules/GlobalSearchModal.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MatchField = 'prompt' | 'response' | 'tool' | 'event';

interface SearchHit {
  sessionId: string;
  sessionTitle: string;
  sessionStatus: string;
  field: MatchField;
  snippet: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Status colors (matches RobotListSidebar)
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
// Search logic (pure, runs on in-memory sessions)
// ---------------------------------------------------------------------------

function runSearch(sessions: Map<string, Session>, query: string): SearchHit[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];

  for (const [, session] of sessions) {
    const sessionTitle = session.title || session.projectName || session.sessionId.slice(0, 8);

    for (const p of session.promptHistory ?? []) {
      if (p.text.toLowerCase().includes(q)) {
        hits.push({ sessionId: session.sessionId, sessionTitle, sessionStatus: session.status, field: 'prompt', snippet: p.text, timestamp: p.timestamp });
      }
    }
    for (const r of session.responseLog ?? []) {
      if ((r.text ?? '').toLowerCase().includes(q)) {
        hits.push({ sessionId: session.sessionId, sessionTitle, sessionStatus: session.status, field: 'response', snippet: r.text ?? '', timestamp: r.timestamp });
      }
    }
    for (const t of session.toolLog ?? []) {
      const text = `${t.tool} ${t.input ?? ''}`;
      if (text.toLowerCase().includes(q)) {
        hits.push({ sessionId: session.sessionId, sessionTitle, sessionStatus: session.status, field: 'tool', snippet: text, timestamp: t.timestamp });
      }
    }
    for (const ev of session.events ?? []) {
      const text = `${ev.type} ${ev.detail ?? ''}`;
      if (text.toLowerCase().includes(q)) {
        hits.push({ sessionId: session.sessionId, sessionTitle, sessionStatus: session.status, field: 'event', snippet: text, timestamp: ev.timestamp });
      }
    }
  }

  // Sort: active/working sessions first, then by recency
  const STATUS_ORDER: Record<string, number> = { working: 0, prompting: 1, approval: 2, input: 2, waiting: 3, idle: 4, connecting: 5, ended: 6 };
  hits.sort((a, b) => {
    const so = (STATUS_ORDER[a.sessionStatus] ?? 5) - (STATUS_ORDER[b.sessionStatus] ?? 5);
    if (so !== 0) return so;
    return b.timestamp - a.timestamp;
  });

  return hits.slice(0, 100);
}

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

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => runSearch(sessions, query), [sessions, query]);

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
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
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
