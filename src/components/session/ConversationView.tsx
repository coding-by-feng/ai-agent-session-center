/**
 * ConversationView renders the full interleaved conversation for a session:
 * user prompts, assistant responses, tool calls, tool results, and lifecycle
 * events in chronological order.
 *
 * Data source (Option B): on mount / sessionId change it fetches the real
 * Claude Code JSONL transcript for untruncated fidelity, falling back to the
 * in-memory session logs when no transcript is available.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PromptEntry,
  ResponseEntry,
  ToolLogEntry,
  SessionEvent,
  ArchivedSession,
} from '@/types';
import { fetchTranscript, reconstructFromLogs, type ConversationEntry, type SystemKind } from '@/lib/transcript';
import { transformEntries } from '@/lib/commandMessage';
import { clipToMatch, matchesQuery, normalizeQuery } from '@/lib/textHighlight';
import LinkifiedText, { MarkedText } from './LinkifiedText';
import styles from '@/styles/modules/DetailPanel.module.css';

function formatTime(ts: number): string {
  if (!ts || ts <= 0) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// Role filter for the conversation toolbar.
type RoleFilter = 'all' | 'user' | 'asst' | 'tool';
const FILTERS: { key: RoleFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'user', label: 'User' },
  { key: 'asst', label: 'Asst' },
  { key: 'tool', label: 'Tool' },
];

function matchesFilter(role: ConversationEntry['role'], filter: RoleFilter): boolean {
  switch (filter) {
    case 'user': return role === 'user' || role === 'command';
    case 'asst': return role === 'assistant';
    case 'tool': return role === 'tool_use' || role === 'tool_result';
    default: return true;
  }
}

/**
 * The searchable text of an entry — ONE definition, used by both the match
 * count and the row highlight. Two separate notions of "does this entry match"
 * is exactly how a counter starts disagreeing with what is lit up on screen.
 */
function entryText(entry: ConversationEntry): string {
  switch (entry.role) {
    case 'user':
    case 'assistant':
    case 'system':
      return entry.text;
    case 'command':
      return `${entry.name} ${entry.args || ''} ${entry.stdout || ''}`;
    case 'tool_use':
      return `${entry.tool} ${entry.input}`;
    case 'tool_result':
      return `${entry.tool || ''} ${entry.output}`;
    case 'event':
      return `${entry.eventType} ${entry.detail}`;
  }
}

/** Find the nearest scrollable ancestor so the jump-to-latest observer/scroll
 *  targets the actual tab scroll container, not the viewport. */
function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text.trim());
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // ignore
      }
    },
    [text],
  );

  return (
    <button className={styles.convCopy} onClick={handleCopy}>
      {copied ? 'COPIED' : 'COPY'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Previous session section (collapsible)
// ---------------------------------------------------------------------------

interface PrevSectionProps {
  prev: ArchivedSession;
  index: number;
  projectPath?: string;
  query: string;
}

function PrevSessionSection({ prev, index, projectPath, query }: PrevSectionProps) {
  const [collapsed, setCollapsed] = useState(true);
  const prompts = [...(prev.promptHistory || [])].sort((a, b) => b.timestamp - a.timestamp);
  const startTime = prev.startedAt ? formatTime(prev.startedAt) : '?';
  const endTime = prev.endedAt ? formatTime(prev.endedAt) : '?';

  return (
    <div className={`${styles.prevSessionSection}${collapsed ? ` ${styles.collapsed}` : ''}`}>
      <div className={styles.prevSessionHeader} onClick={() => setCollapsed((c) => !c)}>
        <span className={styles.prevSessionToggle}>&#9654;</span>
        Previous Session #{index + 1} ({startTime} - {endTime}) &middot; {prompts.length} prompts
      </div>
      {!collapsed && (
        <div className={styles.prevSessionContent}>
          {prompts.length > 0 ? (
            prompts.map((p, j) => (
              <div
                key={p.timestamp}
                className={`${styles.convEntry} ${styles.convUser} ${styles.prevSessionEntry}`}
              >
                <div className={styles.convHeader}>
                  <span className={styles.convRole}>#{prompts.length - j}</span>
                  <span className={styles.convTime}>{formatTime(p.timestamp)}</span>
                </div>
                <div className={styles.convText}>
                  <LinkifiedText text={p.text} projectPath={projectPath} highlight={query} />
                </div>
              </div>
            ))
          ) : (
            <div className={styles.tabEmpty}>No prompts in this session</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single conversation entry
// ---------------------------------------------------------------------------

function highlightClass(entry: ConversationEntry, query: string): string {
  return matchesQuery(entryText(entry), query) ? ' search-highlight' : '';
}

/**
 * Truncate for display, but keep the match visible: a query that hits at
 * character 900 of a tool result would otherwise be marked in text the cap
 * already cut away, leaving a row that claims to match and shows nothing.
 */
function capForDisplay(text: string, cap: number, query: string): string {
  if (text.length <= cap) return text;
  const at = query ? text.toLowerCase().indexOf(query) : -1;
  if (at < 0 || at + query.length <= cap) return `${text.slice(0, cap)}…`;
  const start = Math.max(0, at - Math.floor(cap / 3));
  return `…${text.slice(start, start + cap)}${start + cap < text.length ? '…' : ''}`;
}

function EntryRow({
  entry,
  query,
  projectPath,
}: {
  entry: ConversationEntry;
  query: string;
  projectPath?: string;
}) {
  const time = formatTime(entry.timestamp);
  const hl = highlightClass(entry, query);

  if (entry.role === 'user') {
    return (
      <div className={`${styles.convEntry} ${styles.convUser}${hl}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>USER</span>
          <span className={styles.convTime}>{time}</span>
          <CopyButton text={entry.text} />
        </div>
        <div className={styles.convText}>
          <LinkifiedText text={entry.text} projectPath={projectPath} highlight={query} />
        </div>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div className={`${styles.convEntry} ${styles.convAssistant}${hl}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>ASSISTANT</span>
          <span className={styles.convTime}>{time}</span>
          <CopyButton text={entry.text} />
        </div>
        <div className={styles.convText}>
          <LinkifiedText text={entry.text} projectPath={projectPath} highlight={query} />
        </div>
      </div>
    );
  }

  if (entry.role === 'command') {
    return (
      <div className={`${styles.convEntry} ${styles.convCommand}${hl}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>USER</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          <span className={styles.convCommandName}>
            &#8984; <MarkedText value={entry.name} query={query} />
          </span>
          {entry.args && (
            <span className={styles.convCommandArgs}>
              <MarkedText value={entry.args} query={query} />
            </span>
          )}
        </div>
        {entry.stdout && (
          <div className={styles.convCommandStdout}>
            &#8627; <MarkedText value={entry.stdout} query={query} />
          </div>
        )}
      </div>
    );
  }

  if (entry.role === 'tool_use') {
    const input = capForDisplay(entry.input, 240, query);
    return (
      <div className={`${styles.convEntry} ${styles.convTool}${hl}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>TOOL</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          <span className={styles.convToolName}>
            <MarkedText value={entry.tool} query={query} />
          </span>
          {input && (
            <span className={styles.convToolInput}>
              <MarkedText value={input} query={query} />
            </span>
          )}
        </div>
      </div>
    );
  }

  if (entry.role === 'tool_result') {
    const cls = entry.isError ? styles.convToolFailed : styles.convTool;
    const output = capForDisplay(entry.output, 400, query);
    return (
      <div className={`${styles.convEntry} ${cls}${hl}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>{entry.isError ? 'TOOL ERROR' : 'TOOL RESULT'}</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          {entry.tool && (
            <span className={styles.convToolName}>
              <MarkedText value={entry.tool} query={query} />
            </span>
          )}
          <span className={styles.convToolInput}>
            <MarkedText value={output} query={query} />
          </span>
        </div>
      </div>
    );
  }

  // system entries are rendered by SystemRow, not here
  if (entry.role !== 'event') return null;

  // event
  return (
    <div className={`${styles.convEntry} ${styles.convEvent}${hl}`}>
      <div className={styles.convHeader}>
        <span className={styles.convRole}>{entry.eventType}</span>
        <span className={styles.convTime}>{time}</span>
      </div>
      {entry.detail && (
        <div className={styles.convText}>
          <MarkedText value={entry.detail} query={query} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// System row (collapsed harness plumbing / caveats)
// ---------------------------------------------------------------------------

// Short label per injected-content kind, so a collapsed row reads e.g.
// "SKILL · systematic-debugging" instead of an anonymous "system".
const SYSTEM_KIND_LABEL: Record<SystemKind, string> = {
  plumbing: 'system',
  skill: 'skill',
  reminder: 'system reminder',
  hook: 'hook context',
};

function SystemRow({
  entry,
  query,
}: {
  entry: Extract<ConversationEntry, { role: 'system' }>;
  query: string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const kind = entry.kind ?? 'plumbing';
  const label =
    kind === 'skill' && entry.label ? `skill · ${entry.label}` : SYSTEM_KIND_LABEL[kind];
  const hit = matchesQuery(entry.text, query);
  // Only needed while collapsed; slice first so the whitespace-collapse never
  // scans a multi-KB injected body to keep ~64 chars. When the search hit is
  // buried inside the collapsed body, preview the text AROUND the match
  // instead — otherwise the row advertises a match and shows an unrelated
  // opening line, with no clue that expanding would reveal it.
  const preview = !collapsed
    ? ''
    : hit
      ? clipToMatch(entry.text.replace(/\s+/g, ' ').trim(), query, { leading: 24, trailing: 48 })
      : entry.text.slice(0, 160).replace(/\s+/g, ' ').trim().slice(0, 64);
  return (
    <div
      className={`${styles.convSystemRow}${collapsed ? '' : ` ${styles.convSystemRowOpen}`}${hit ? ' search-highlight' : ''}`}
      data-kind={kind}
    >
      <div className={styles.convSystemHeader} onClick={() => setCollapsed((c) => !c)}>
        <span className={styles.convSystemToggle}>&#9654;</span>
        <span className={styles.convSystemLabel}>{label}</span>
        {collapsed && (
          <span className={styles.convSystemCount}>
            <MarkedText value={preview} query={query} />
          </span>
        )}
      </div>
      {!collapsed && (
        <div className={styles.convSystemBody}>
          <MarkedText value={entry.text} query={query} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ConversationViewProps {
  sessionId: string;
  transcriptPath?: string;
  prompts: PromptEntry[];
  responses: ResponseEntry[];
  toolCalls: ToolLogEntry[];
  events: SessionEvent[];
  previousSessions?: ArchivedSession[];
  searchQuery?: string;
  /** Present ⇒ the search box is controlled by the host (DetailPanel), so the
   *  toolbar input and the panel's Cmd+F bar drive ONE query. Absent ⇒ the
   *  component keeps its own state and works standalone. */
  onSearchChange?: (query: string) => void;
  /** Reports how many entries match the current query, so the host's find-bar
   *  counter reflects what is actually highlighted rather than re-deriving it
   *  from a different data set. */
  onMatchCountChange?: (count: number) => void;
  projectPath?: string;
}

export default function ConversationView({
  sessionId,
  prompts,
  responses,
  toolCalls,
  events,
  previousSessions,
  searchQuery,
  onSearchChange,
  onMatchCountChange,
  projectPath,
}: ConversationViewProps) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [atBottom, setAtBottom] = useState(true);
  const [matchesOnly, setMatchesOnly] = useState(true);
  const [localSearch, setLocalSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const controlled = onSearchChange !== undefined;
  const search = controlled ? searchQuery ?? '' : localSearch;
  const setSearch = controlled ? onSearchChange : setLocalSearch;
  const query = normalizeQuery(search);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTranscript(sessionId)
      .then((transcript) => {
        if (cancelled) return;
        const raw = transcript.length > 0
          ? transcript
          : reconstructFromLogs(prompts, responses, toolCalls, events);
        setEntries(transformEntries(raw));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the session changes; in-memory logs are the fallback
    // captured at fetch time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Role filter and search are ANDed. Both derive from `roleFiltered` so the
  // match count can never describe a different set than the one on screen.
  const roleFiltered = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => matchesFilter(e.role, filter))),
    [entries, filter],
  );

  const matchCount = useMemo(
    () => (query ? roleFiltered.filter((e) => matchesQuery(entryText(e), query)).length : 0),
    [roleFiltered, query],
  );

  const visibleEntries = useMemo(
    () =>
      query && matchesOnly
        ? roleFiltered.filter((e) => matchesQuery(entryText(e), query))
        : roleFiltered,
    [roleFiltered, query, matchesOnly],
  );

  const hasPrev = !!previousSessions && previousSessions.length > 0;
  // Archived prior sessions are not part of the searched thread, so while a
  // narrowing search is active they would be N collapsed blocks claiming space
  // among the hits without being hits themselves.
  const showPrev = hasPrev && filter === 'all' && !(query && matchesOnly);

  useEffect(() => {
    onMatchCountChange?.(matchCount);
  }, [matchCount, onMatchCountChange]);

  const clearSearch = useCallback(() => {
    setSearch('');
    searchRef.current?.focus();
  }, [setSearch]);

  // Disable the jump-to-latest button while the bottom sentinel is in view.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sentinel = bottomRef.current;
    if (!sentinel) return;
    const io = new IntersectionObserver(([e]) => setAtBottom(e.isIntersecting), {
      root: getScrollParent(rootRef.current),
      threshold: 0,
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [visibleEntries.length]);

  const jumpToLatest = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, []);

  return (
    <div ref={rootRef}>
      {/* Sticky toolbar — role filter + search + jump-to-latest.
          Wraps at narrow panel widths; the pills keep row 1. */}
      <div className={styles.convToolbar}>
        <div className={styles.convFilterPills}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`${styles.convFilterPill}${filter === f.key ? ` ${styles.convFilterPillActive}` : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className={styles.convSearch}>
          <span className={styles.convSearchIcon} aria-hidden="true">&#8981;</span>
          <input
            ref={searchRef}
            type="text"
            className={styles.convSearchInput}
            placeholder="Search conversation…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Stop at the input: the panel-level Escape handler would close
              // the whole find bar / restore the panel instead of just clearing.
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
              }
            }}
            aria-label="Search conversation"
            data-testid="conv-search-input"
          />
          {search && (
            <button
              className={styles.convSearchClear}
              onClick={clearSearch}
              title="Clear search (Esc)"
              aria-label="Clear search"
            >
              &#10005;
            </button>
          )}
        </div>

        {query && (
          <>
            <span
              className={`${styles.convSearchCount}${matchCount === 0 ? ` ${styles.convSearchCountEmpty}` : ''}`}
              data-testid="conv-search-count"
            >
              {matchCount === 0 ? 'No matches' : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
            </span>
            <button
              className={`${styles.convFilterPill}${matchesOnly ? ` ${styles.convFilterPillActive}` : ''}`}
              onClick={() => setMatchesOnly((v) => !v)}
              aria-pressed={matchesOnly}
              title={
                matchesOnly
                  ? 'Showing only matching entries — click to show the full thread'
                  : 'Showing the full thread — click to show only matching entries'
              }
            >
              Matches only
            </button>
          </>
        )}

        <button
          className={styles.convJumpLatest}
          onClick={jumpToLatest}
          disabled={atBottom}
          title="Jump to latest"
        >
          &#8595; latest
        </button>
      </div>

      {/* Previous sessions (only in the All view) */}
      {showPrev &&
        [...previousSessions!]
          .reverse()
          .map((prev, i) => (
            <PrevSessionSection
              key={prev.sessionId}
              prev={prev}
              index={i}
              projectPath={projectPath}
              query={query}
            />
          ))}

      {/* Current session conversation */}
      {visibleEntries.length > 0 ? (
        visibleEntries.map((entry, i) =>
          entry.role === 'system' ? (
            <SystemRow key={`${entry.timestamp}-${i}`} entry={entry} query={query} />
          ) : (
            <EntryRow key={`${entry.timestamp}-${i}`} entry={entry} query={query} projectPath={projectPath} />
          ),
        )
      ) : loading ? (
        <div className={styles.tabEmpty}>Loading transcript…</div>
      ) : showPrev ? null : query ? (
        // Distinct from the role-filter empty state: different cause, so it
        // names the query and offers the escape hatch.
        <div className={styles.tabEmpty}>
          No entries match “{search.trim()}”
          {' · '}
          <button className={styles.tabEmptyAction} onClick={clearSearch}>
            clear search
          </button>
        </div>
      ) : (
        <div className={styles.tabEmpty}>
          {filter === 'all' ? 'No conversation yet' : 'No matching messages'}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
