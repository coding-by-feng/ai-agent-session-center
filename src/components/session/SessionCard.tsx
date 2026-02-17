/**
 * SessionCard displays a single session as a card with status-colored glow borders,
 * robot viewport, info area, and action buttons. Ported from public/js/sessionCard.js.
 */
import { useState, useCallback, useRef, useEffect, memo, type KeyboardEvent, type MouseEvent } from 'react';
import type { Session, SessionSource } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { deleteSession as deleteSessionDb } from '@/lib/db';
import { showToast } from '@/components/ui/ToastContainer';
import { formatDuration, getSourceLabel, getStatusLabel } from '@/lib/format';
import styles from '@/styles/modules/SessionCard.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PINNED_KEY = 'pinned-sessions';
const MUTED_KEY = 'muted-sessions';

const ACTIVE_STATUSES = new Set(['working', 'prompting', 'approval', 'input']);

function loadSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...set]));
}

// ---------------------------------------------------------------------------
// Tool Bars sub-component
// ---------------------------------------------------------------------------

interface ToolBarsProps {
  toolUsage: Record<string, number>;
}

function ToolBars({ toolUsage }: ToolBarsProps) {
  const entries = Object.entries(toolUsage);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const top5 = entries.sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className={styles.toolBars}>
      {top5.map(([name, count]) => (
        <div key={name} className={styles.toolBar}>
          <span className={styles.toolName}>{name}</span>
          <div
            className={styles.toolBarFill}
            style={{ width: `${(count / max) * 100}%` }}
          />
          <span className={styles.toolCount}>{count}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SessionCardProps {
  session: Session;
  /** Whether this card is currently selected */
  selected?: boolean;
  /** Global mute state */
  globalMuted?: boolean;
  /** Drag data transfer ID for drag-and-drop */
  dragId?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function SessionCard({
  session,
  selected = false,
  globalMuted = false,
}: SessionCardProps) {
  const { selectSession, deselectSession, removeSession } = useSessionStore();

  // Pin state
  const [pinned, setPinned] = useState(() => loadSet(PINNED_KEY).has(session.sessionId));
  // Mute state
  const [muted, setMuted] = useState(() => loadSet(MUTED_KEY).has(session.sessionId));
  // Summarize button state
  const [summarizeState, setSummarizeState] = useState<'idle' | 'loading' | 'done'>('idle');
  // Resume button state
  const [resuming, setResuming] = useState(false);
  // Inline title editing
  const [editing, setEditing] = useState(false);
  const titleRef = useRef<HTMLDivElement>(null);
  // Drag state
  const [dragging, setDragging] = useState(false);
  const [dragOver, setDragOver] = useState<'left' | 'right' | null>(null);

  const isDisplayOnly = session.source !== 'ssh' && session.source !== '' && session.source !== undefined;
  const isDisconnected = session.status === 'ended';

  // Duration updates
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isDisconnected) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isDisconnected]);

  // ---- Click handler ----
  const handleCardClick = useCallback(() => {
    if (isDisplayOnly) return;
    if (selected) {
      deselectSession();
    } else {
      selectSession(session.sessionId);
    }
  }, [isDisplayOnly, selected, session.sessionId, selectSession, deselectSession]);

  // ---- Close ----
  const handleClose = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      const sid = session.sessionId;
      if (session.terminalId) {
        fetch(`/api/terminals/${session.terminalId}`, { method: 'DELETE' }).catch(() => {});
      }
      // Fix 5: use delete, not get->put race
      deleteSessionDb(sid).catch(() => {});
      fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});

      // Clean up local storage
      const pinnedSet = loadSet(PINNED_KEY);
      pinnedSet.delete(sid);
      saveSet(PINNED_KEY, pinnedSet);
      const mutedSet = loadSet(MUTED_KEY);
      mutedSet.delete(sid);
      saveSet(MUTED_KEY, mutedSet);

      removeSession(sid);
    },
    [session.sessionId, session.terminalId, removeSession],
  );

  // ---- Pin ----
  const handlePin = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const set = loadSet(PINNED_KEY);
      if (set.has(session.sessionId)) {
        set.delete(session.sessionId);
        setPinned(false);
      } else {
        set.add(session.sessionId);
        setPinned(true);
      }
      saveSet(PINNED_KEY, set);
    },
    [session.sessionId],
  );

  // ---- Mute ----
  const handleMute = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      const set = loadSet(MUTED_KEY);
      if (set.has(session.sessionId)) {
        set.delete(session.sessionId);
        setMuted(false);
      } else {
        set.add(session.sessionId);
        setMuted(true);
      }
      saveSet(MUTED_KEY, set);
    },
    [session.sessionId],
  );

  // ---- Summarize & Archive ----
  const handleSummarize = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      if (summarizeState !== 'idle') return;
      setSummarizeState('loading');
      try {
        const resp = await fetch(`/api/sessions/${session.sessionId}/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: '', promptTemplate: '' }),
        });
        const data = await resp.json();
        if (data.ok) {
          showToast('Session summarized & archived', 'success');
          setSummarizeState('done');
        } else {
          showToast(data.error || 'Summarize failed', 'error');
          setSummarizeState('idle');
        }
      } catch (err) {
        showToast((err as Error).message, 'error');
        setSummarizeState('idle');
      }
    },
    [session.sessionId, summarizeState],
  );

  // ---- Resume ----
  const handleResume = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      if (resuming) return;
      setResuming(true);
      try {
        const resp = await fetch(`/api/sessions/${session.sessionId}/resume`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          showToast('Resuming Claude session in terminal', 'success');
          selectSession(session.sessionId);
        } else {
          showToast(data.error || 'Resume failed', 'error');
        }
      } catch (err) {
        showToast((err as Error).message, 'error');
      } finally {
        setResuming(false);
      }
    },
    [session.sessionId, resuming, selectSession],
  );

  // ---- Inline title edit ----
  const handleTitleClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      if (editing) return;
      setEditing(true);
      requestAnimationFrame(() => {
        const el = titleRef.current;
        if (el) {
          el.focus();
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      });
    },
    [editing],
  );

  const saveTitle = useCallback(async () => {
    setEditing(false);
    const newTitle = titleRef.current?.textContent?.trim() || '';
    if (newTitle) {
      fetch(`/api/sessions/${session.sessionId}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      }).catch(() => {});
    }
  }, [session.sessionId]);

  const handleTitleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleRef.current?.blur();
      }
      if (e.key === 'Escape') {
        if (titleRef.current) titleRef.current.textContent = session.title || '';
        titleRef.current?.blur();
      }
    },
    [session.title],
  );

  // ---- Drag handlers ----
  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', session.sessionId);
      setTimeout(() => setDragging(true), 0);
    },
    [session.sessionId],
  );

  const handleDragEnd = useCallback(() => {
    setDragging(false);
    setDragOver(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    setDragOver(e.clientX < midX ? 'left' : 'right');
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      // Drop reordering is handled at SessionGrid level via dnd-kit;
      // this is a fallback for native HTML drag
      const _draggedId = e.dataTransfer.getData('text/plain');
      void _draggedId; // Grid handles actual reorder
    },
    [],
  );

  // ---- Derived values ----
  const promptArr = session.promptHistory || [];
  const prompt =
    session.currentPrompt ||
    (promptArr.length > 0 ? promptArr[promptArr.length - 1].text : '');
  const truncatedPrompt = prompt.length > 120 ? prompt.substring(0, 120) + '...' : prompt;

  const durText = formatDuration(Date.now() - session.startedAt);

  const source = session.source || 'ssh';
  const showSourceBadge = source !== 'ssh';

  const label = session.label || '';
  const labelUpper = label.toUpperCase();
  const isHeavy = labelUpper === 'HEAVY';
  const isOneoff = labelUpper === 'ONEOFF';
  const isImportant = labelUpper === 'IMPORTANT';

  const statusLabel = getStatusLabel(session.status);

  const queueN = session.queueCount || 0;
  const isMutedActual = globalMuted || muted;

  // ---- CSS class composition ----
  const cardClasses = [
    styles.card,
    isDisplayOnly ? styles.displayOnly : '',
    isDisconnected ? styles.disconnected : '',
    pinned ? styles.pinned : '',
    dragging ? styles.dragging : '',
    dragOver === 'left' ? styles.dragOverLeft : '',
    dragOver === 'right' ? styles.dragOverRight : '',
    isHeavy ? styles.heavySession : '',
    isOneoff ? styles.oneoffSession : '',
    isImportant ? styles.importantSession : '',
    session.terminalId ? styles.hasTerminal : '',
    queueN > 0 ? styles.hasQueue : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Frame effect
  const frameAttr =
    (labelUpper === 'ONEOFF' || labelUpper === 'HEAVY' || labelUpper === 'IMPORTANT')
      ? undefined // Frame is determined by settings; simplified here
      : undefined;

  return (
    <div
      className={cardClasses}
      data-session-id={session.sessionId}
      data-status={session.status}
      data-animation={session.animationState}
      data-emote={session.emote || undefined}
      data-frame={frameAttr}
      draggable={!isDisplayOnly}
      onClick={handleCardClick}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Action buttons */}
      <button
        className={styles.closeBtn}
        title="Dismiss card"
        onClick={handleClose}
      >
        &times;
      </button>

      {!isDisplayOnly && (
        <button
          className={`${styles.pinBtn}${pinned ? ` ${styles.active}` : ''}`}
          title={pinned ? 'Unpin' : 'Pin to top'}
          onClick={handlePin}
        >
          &#9650;
        </button>
      )}

      {!isDisplayOnly && (
        <button
          className={`${styles.summarizeBtn}${summarizeState === 'loading' ? ` ${styles.loading}` : ''}${summarizeState === 'done' ? ` ${styles.done}` : ''}`}
          title="Summarize & Archive"
          onClick={handleSummarize}
          disabled={summarizeState !== 'idle'}
        >
          {summarizeState === 'loading'
            ? '...'
            : summarizeState === 'done'
              ? '\u2713'
              : '\u2193AI'}
        </button>
      )}

      <button
        className={`${styles.muteBtn}${isMutedActual ? ` ${styles.muted}` : ''}`}
        title={isMutedActual ? 'Unmute sounds' : 'Mute sounds'}
        onClick={handleMute}
      >
        {isMutedActual ? 'M' : '\u266B'}
      </button>

      {/* Resume button for disconnected sessions */}
      {isDisconnected && (
        <button
          className={styles.resumeBtn}
          title="Resume Claude"
          onClick={handleResume}
          disabled={resuming}
        >
          {resuming ? 'RESUMING...' : '\u25B6 RESUME'}
        </button>
      )}

      {/* Robot viewport placeholder */}
      <div className={styles.robotViewport} />

      {/* Card info */}
      <div className={styles.cardInfo}>
        {/* Inline editable title */}
        <div
          ref={titleRef}
          className={`${styles.cardTitle}${editing ? ` ${styles.editing}` : ''}`}
          style={{ display: session.title ? undefined : 'none' }}
          contentEditable={editing}
          suppressContentEditableWarning
          onClick={handleTitleClick}
          onBlur={saveTitle}
          onKeyDown={handleTitleKeyDown}
        >
          {session.title || ''}
        </div>

        {/* Header row */}
        <div className={styles.cardHeader}>
          <span className={styles.projectName}>{session.projectName}</span>
          {label && <span className={styles.labelBadge}>{label}</span>}
          {showSourceBadge && (
            <span
              className={`${styles.sourceBadge}${source !== 'unknown' ? ` ${styles[source as SessionSource]}` : ''}`}
            >
              {getSourceLabel(source)}
            </span>
          )}
          <span
            className={`${styles.statusBadge} ${styles[isDisconnected ? 'disconnected' : session.status]}`}
          >
            {statusLabel}
          </span>
        </div>

        {/* Waiting banner */}
        <div className={styles.waitingBanner}>
          {session.waitingDetail ||
            (session.status === 'input'
              ? 'WAITING FOR YOUR ANSWER'
              : 'NEEDS YOUR APPROVAL')}
        </div>

        {/* Prompt preview */}
        <div className={styles.cardPrompt}>{truncatedPrompt}</div>

        {/* Stats row */}
        <div className={styles.cardStats}>
          {durText && <span>{durText}</span>}
          <span>Tools: {session.totalToolCalls}</span>
          {session.subagentCount > 0 && (
            <span title="Active subagents">Agents: {session.subagentCount}</span>
          )}
          {queueN > 0 && (
            <span className={styles.queueCount} title="Queued prompts">
              Queue: {queueN}
            </span>
          )}
        </div>

        {/* Tool usage bars */}
        {session.toolUsage && <ToolBars toolUsage={session.toolUsage} />}
      </div>
    </div>
  );
})
