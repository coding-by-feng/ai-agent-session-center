/**
 * PromptHistory shows a scrollable list of prompt/response entries.
 * Ported from the conversation tab in public/js/detailPanel.js.
 */
import { useCallback, useState } from 'react';
import type { PromptEntry, ArchivedSession } from '@/types';
import styles from '@/styles/modules/DetailPanel.module.css';

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// ---------------------------------------------------------------------------
// Previous session section (collapsible)
// ---------------------------------------------------------------------------

interface PrevSectionProps {
  prev: ArchivedSession;
  index: number;
}

function PrevSessionSection({ prev, index }: PrevSectionProps) {
  const [collapsed, setCollapsed] = useState(true);
  // #17: Sort newest-first for consistency with current session's prompt display
  const prompts = [...(prev.promptHistory || [])].sort(
    (a, b) => b.timestamp - a.timestamp,
  );
  const startTime = prev.startedAt ? formatTime(prev.startedAt) : '?';
  const endTime = prev.endedAt ? formatTime(prev.endedAt) : '?';

  return (
    <div className={`${styles.prevSessionSection}${collapsed ? ` ${styles.collapsed}` : ''}`}>
      <div
        className={styles.prevSessionHeader}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span className={styles.prevSessionToggle}>&#9654;</span>
        Previous Session #{index + 1} ({startTime} - {endTime}) &middot;{' '}
        {prompts.length} prompts
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
                <div className={styles.convText}>{p.text}</div>
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
// Main component
// ---------------------------------------------------------------------------

interface PromptHistoryProps {
  prompts: PromptEntry[];
  previousSessions?: ArchivedSession[];
  searchQuery?: string;
}

export default function PromptHistory({
  prompts,
  previousSessions,
  searchQuery,
}: PromptHistoryProps) {
  const sorted = [...prompts].sort((a, b) => b.timestamp - a.timestamp);
  const query = searchQuery?.toLowerCase() || '';

  return (
    <div>
      {/* Previous sessions */}
      {previousSessions &&
        previousSessions.length > 0 &&
        [...previousSessions]
          .reverse()
          .map((prev, i) => (
            <PrevSessionSection key={prev.sessionId} prev={prev} index={i} />
          ))}

      {/* Current session prompts */}
      {sorted.length > 0 ? (
        sorted.map((p, i) => {
          const highlighted =
            query && p.text.toLowerCase().includes(query);
          return (
            <div
              key={p.timestamp}
              className={`${styles.convEntry} ${styles.convUser}${highlighted ? ' search-highlight' : ''}`}
            >
              <div className={styles.convHeader}>
                <span className={styles.convRole}>#{sorted.length - i}</span>
                <span className={styles.convTime}>{formatTime(p.timestamp)}</span>
                <CopyButton text={p.text} />
              </div>
              <div className={styles.convText}>{p.text}</div>
            </div>
          );
        })
      ) : previousSessions && previousSessions.length > 0 ? null : (
        <div className={styles.tabEmpty}>No prompts yet</div>
      )}
    </div>
  );
}
