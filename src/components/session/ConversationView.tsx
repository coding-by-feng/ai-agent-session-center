/**
 * ConversationView renders the full interleaved conversation for a session:
 * user prompts, assistant responses, tool calls, tool results, and lifecycle
 * events in chronological order.
 *
 * Data source (Option B): on mount / sessionId change it fetches the real
 * Claude Code JSONL transcript for untruncated fidelity, falling back to the
 * in-memory session logs when no transcript is available.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  PromptEntry,
  ResponseEntry,
  ToolLogEntry,
  SessionEvent,
  ArchivedSession,
} from '@/types';
import { fetchTranscript, reconstructFromLogs, type ConversationEntry } from '@/lib/transcript';
import LinkifiedText from './LinkifiedText';
import styles from '@/styles/modules/DetailPanel.module.css';

function formatTime(ts: number): string {
  if (!ts || ts <= 0) return '';
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
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
  const query = searchQuery?.toLowerCase() || '';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTranscript(sessionId)
      .then((transcript) => {
        if (cancelled) return;
        if (transcript.length > 0) {
          setEntries(transcript);
        } else {
          setEntries(reconstructFromLogs(prompts, responses, toolCalls, events));
        }
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

  return (
    <div>
      {/* Previous sessions */}
      {hasPrev &&
        [...previousSessions!]
          .reverse()
          .map((prev, i) => (
            <PrevSessionSection key={prev.sessionId} prev={prev} index={i} projectPath={projectPath} />
          ))}

      {/* Current session conversation */}
      {entries.length > 0 ? (
        entries.map((entry, i) => (
          <EntryRow key={`${entry.timestamp}-${i}`} entry={entry} query={query} projectPath={projectPath} />
        ))
      ) : loading ? (
        <div className={styles.tabEmpty}>Loading transcript…</div>
      ) : hasPrev ? null : (
        <div className={styles.tabEmpty}>No conversation yet</div>
      )}
    </div>
  );
}
