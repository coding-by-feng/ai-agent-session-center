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
import LinkifiedText from './LinkifiedText';
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
}

function PrevSessionSection({ prev, index, projectPath }: PrevSectionProps) {
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
                  <LinkifiedText text={p.text} projectPath={projectPath} />
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

function highlightClass(text: string, query: string): string {
  return query && text.toLowerCase().includes(query) ? ' search-highlight' : '';
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

  if (entry.role === 'user') {
    return (
      <div className={`${styles.convEntry} ${styles.convUser}${highlightClass(entry.text, query)}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>USER</span>
          <span className={styles.convTime}>{time}</span>
          <CopyButton text={entry.text} />
        </div>
        <div className={styles.convText}>
          <LinkifiedText text={entry.text} projectPath={projectPath} />
        </div>
      </div>
    );
  }

  if (entry.role === 'assistant') {
    return (
      <div className={`${styles.convEntry} ${styles.convAssistant}${highlightClass(entry.text, query)}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>ASSISTANT</span>
          <span className={styles.convTime}>{time}</span>
          <CopyButton text={entry.text} />
        </div>
        <div className={styles.convText}>
          <LinkifiedText text={entry.text} projectPath={projectPath} />
        </div>
      </div>
    );
  }

  if (entry.role === 'command') {
    return (
      <div className={`${styles.convEntry} ${styles.convCommand}${highlightClass(`${entry.name} ${entry.args || ''} ${entry.stdout || ''}`, query)}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>USER</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          <span className={styles.convCommandName}>&#8984; {entry.name}</span>
          {entry.args && <span className={styles.convCommandArgs}>{entry.args}</span>}
        </div>
        {entry.stdout && <div className={styles.convCommandStdout}>&#8627; {entry.stdout}</div>}
      </div>
    );
  }

  if (entry.role === 'tool_use') {
    const input = entry.input.length > 240 ? `${entry.input.slice(0, 240)}…` : entry.input;
    return (
      <div className={`${styles.convEntry} ${styles.convTool}${highlightClass(`${entry.tool} ${entry.input}`, query)}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>TOOL</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          <span className={styles.convToolName}>{entry.tool}</span>
          {input && <span className={styles.convToolInput}>{input}</span>}
        </div>
      </div>
    );
  }

  if (entry.role === 'tool_result') {
    const cls = entry.isError ? styles.convToolFailed : styles.convTool;
    const output = entry.output.length > 400 ? `${entry.output.slice(0, 400)}…` : entry.output;
    return (
      <div className={`${styles.convEntry} ${cls}${highlightClass(entry.output, query)}`}>
        <div className={styles.convHeader}>
          <span className={styles.convRole}>{entry.isError ? 'TOOL ERROR' : 'TOOL RESULT'}</span>
          <span className={styles.convTime}>{time}</span>
        </div>
        <div className={styles.convText}>
          {entry.tool && <span className={styles.convToolName}>{entry.tool}</span>}
          <span className={styles.convToolInput}>{output}</span>
        </div>
      </div>
    );
  }

  // system entries are rendered by SystemRow, not here
  if (entry.role !== 'event') return null;

  // event
  return (
    <div className={`${styles.convEntry} ${styles.convEvent}${highlightClass(`${entry.eventType} ${entry.detail}`, query)}`}>
      <div className={styles.convHeader}>
        <span className={styles.convRole}>{entry.eventType}</span>
        <span className={styles.convTime}>{time}</span>
      </div>
      {entry.detail && <div className={styles.convText}>{entry.detail}</div>}
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
  // Only needed while collapsed; slice first so the whitespace-collapse never
  // scans a multi-KB injected body to keep ~64 chars.
  const preview = collapsed ? entry.text.slice(0, 160).replace(/\s+/g, ' ').trim().slice(0, 64) : '';
  return (
    <div
      className={`${styles.convSystemRow}${collapsed ? '' : ` ${styles.convSystemRowOpen}`}${highlightClass(entry.text, query)}`}
      data-kind={kind}
    >
      <div className={styles.convSystemHeader} onClick={() => setCollapsed((c) => !c)}>
        <span className={styles.convSystemToggle}>&#9654;</span>
        <span className={styles.convSystemLabel}>{label}</span>
        {collapsed && <span className={styles.convSystemCount}>{preview}</span>}
      </div>
      {!collapsed && <div className={styles.convSystemBody}>{entry.text}</div>}
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
  projectPath,
}: ConversationViewProps) {
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [atBottom, setAtBottom] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const query = searchQuery?.toLowerCase() || '';

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

  const hasPrev = !!previousSessions && previousSessions.length > 0;
  const showPrev = hasPrev && filter === 'all';

  const visibleEntries = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => matchesFilter(e.role, filter))),
    [entries, filter],
  );

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
      {/* Sticky toolbar — role filter + jump-to-latest */}
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
            <PrevSessionSection key={prev.sessionId} prev={prev} index={i} projectPath={projectPath} />
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
      ) : showPrev ? null : (
        <div className={styles.tabEmpty}>
          {filter === 'all' ? 'No conversation yet' : 'No matching messages'}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
