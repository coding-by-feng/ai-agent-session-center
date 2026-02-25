/**
 * QueueTab - Per-session prompt queue management.
 * Features: compose + add, reorder (drag), edit, delete, send now,
 * move to another session, auto-send on "waiting" status.
 * Uses Terminal.module.css queue styles.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Terminal.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextLocalId = Date.now();
function localId(): number {
  return nextLocalId++;
}

/** Stable empty array — prevents useSyncExternalStore infinite loop from `?? []` */
const EMPTY_QUEUE: QueueItem[] = [];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface QueueTabProps {
  sessionId: string;
  sessionStatus: string;
  terminalId?: string | null;
  /** Send a WS message to update queue count on the server */
  onQueueCountChange?: (sessionId: string, count: number) => void;
}

export default function QueueTab({
  sessionId,
  sessionStatus,
  terminalId,
  onQueueCountChange,
}: QueueTabProps) {
  const items = useQueueStore((s) => s.queues.get(sessionId) ?? EMPTY_QUEUE);
  const add = useQueueStore((s) => s.add);
  const remove = useQueueStore((s) => s.remove);
  const reorder = useQueueStore((s) => s.reorder);
  const moveToSession = useQueueStore((s) => s.moveToSession);
  const sessions = useSessionStore((s) => s.sessions);

  const [composeText, setComposeText] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [movingItemId, setMovingItemId] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const prevStatusRef = useRef(sessionStatus);

  // #13: Reset edit state when session changes
  useEffect(() => {
    setEditingId(null);
    setEditText('');
    setMovingItemId(null);
  }, [sessionId]);

  // Notify parent of queue count changes
  useEffect(() => {
    onQueueCountChange?.(sessionId, items.length);
  }, [items.length, sessionId, onQueueCountChange]);

  // ---- Send prompt text to terminal via API — returns true on success ----
  const sendPromptToTerminal = useCallback(
    async (text: string): Promise<boolean> => {
      if (!terminalId) {
        showToast('No terminal attached', 'error');
        return false;
      }
      try {
        const res = await fetch(`/api/terminals/${terminalId}/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: text + '\n' }),
        });
        if (!res.ok) {
          showToast('Failed to send to terminal', 'error');
          return false;
        }
        return true;
      } catch {
        showToast('Network error sending to terminal', 'error');
        return false;
      }
    },
    [terminalId],
  );

  // ---- Auto-send: when session transitions to "waiting" or "input", send first queued prompt ----
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;

    if (prev === sessionStatus) return;
    const isWaiting =
      sessionStatus === 'waiting' || sessionStatus === 'input';
    if (!isWaiting) return;
    if (items.length === 0) return;
    // Only auto-send if there's a terminal attached
    if (!terminalId) return;

    // Send the first item — only remove after successful send
    const first = items[0];
    sendPromptToTerminal(first.text).then((sent) => {
      if (sent) {
        remove(sessionId, first.id);
        showToast('Auto-sent queued prompt', 'info', 2000);
      }
    });
  }, [sessionStatus, items, sessionId, terminalId, remove, sendPromptToTerminal]);

  // ---- Add to queue ----
  const handleAdd = useCallback(() => {
    const trimmed = composeText.trim();
    if (!trimmed) return;
    const newItem: QueueItem = {
      id: localId(),
      sessionId,
      text: trimmed,
      position: items.length,
      createdAt: Date.now(),
    };
    add(sessionId, newItem);
    setComposeText('');
  }, [composeText, sessionId, items.length, add]);

  // ---- Edit item ----
  const startEdit = useCallback((item: QueueItem) => {
    setEditingId(item.id);
    setEditText(item.text);
  }, []);

  const saveEdit = useCallback(() => {
    if (editingId === null) return;
    const trimmed = editText.trim();
    if (!trimmed) {
      remove(sessionId, editingId);
    } else {
      // Update text in store: remove + re-add at same position
      const idx = items.findIndex((i) => i.id === editingId);
      if (idx >= 0) {
        const updated: QueueItem = { ...items[idx], text: trimmed };
        const newItems = [...items];
        newItems[idx] = updated;
        useQueueStore
          .getState()
          .reorder(
            sessionId,
            newItems.map((i) => i.id),
          );
        // Direct set to keep text change
        useQueueStore.getState().setQueue(sessionId, newItems);
      }
    }
    setEditingId(null);
    setEditText('');
  }, [editingId, editText, items, sessionId, remove]);

  // ---- Send now (first item or specific item) — only remove after successful send ----
  const handleSendNow = useCallback(
    async (item: QueueItem) => {
      const sent = await sendPromptToTerminal(item.text);
      if (sent) {
        remove(sessionId, item.id);
      }
    },
    [sendPromptToTerminal, remove, sessionId],
  );

  // ---- Move to another session ----
  const handleMoveConfirm = useCallback(
    (targetSessionId: string) => {
      if (movingItemId === null) return;
      moveToSession([movingItemId], sessionId, targetSessionId);
      setMovingItemId(null);
      showToast('Prompt moved', 'info', 2000);
    },
    [movingItemId, sessionId, moveToSession],
  );

  // ---- Simple drag reorder ----
  const handleDragStart = useCallback(
    (idx: number) => {
      setDragIdx(idx);
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetIdx: number) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === targetIdx) return;
      // Immutable reorder: build new array without mutating
      const newItems = [...items];
      const [moved] = newItems.splice(dragIdx, 1);
      newItems.splice(targetIdx, 0, moved);
      // Validate array integrity
      if (newItems.length !== items.length) return;
      reorder(sessionId, newItems.map((i) => i.id));
      setDragIdx(targetIdx);
    },
    [dragIdx, items, reorder, sessionId],
  );

  const handleDragEnd = useCallback(() => {
    setDragIdx(null);
  }, []);

  // ---- Other sessions for move picker ----
  const otherSessions = Array.from(sessions.entries()).filter(
    ([id]) => id !== sessionId,
  );

  return (
    <div className={`${styles.queuePanel}${collapsed ? ` ${styles.collapsed}` : ''}`}>
      {/* Toggle header */}
      <button
        className={styles.queueToggle}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.queueToggleArrow}>&#x25B6;</span>
        QUEUE{' '}
        <span className={styles.queueCount}>({items.length})</span>
      </button>

      {/* Body */}
      <div className={styles.queueBody}>
        {/* Compose */}
        <div className={styles.queueCompose}>
          <textarea
            className={styles.queueTextarea}
            placeholder="Add a prompt to the queue..."
            rows={2}
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <button
            className={`${styles.toolbarBtn} ${styles.queueAddBtn}`}
            onClick={handleAdd}
            disabled={!composeText.trim()}
          >
            ADD
          </button>
        </div>

        {/* Queue list */}
        <div className={styles.queueList}>
          {items.length === 0 ? (
            <div className={styles.queueListEmpty}>
              Queue is empty. Add prompts to auto-send when session is waiting.
            </div>
          ) : (
            items.map((item, idx) => (
              <div
                key={item.id}
                className={`${styles.queueItem}${dragIdx === idx ? ` ${styles.dragging}` : ''}`}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
              >
                <span className={styles.queuePos}>{idx + 1}</span>

                {editingId === item.id ? (
                  <textarea
                    className={styles.queueEditTextarea}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        saveEdit();
                      }
                      if (e.key === 'Escape') {
                        setEditingId(null);
                        setEditText('');
                      }
                    }}
                    autoFocus
                    rows={2}
                  />
                ) : (
                  <span className={styles.queueText}>{item.text}</span>
                )}

                <div className={styles.queueActions}>
                  {editingId === item.id ? (
                    <button
                      className={`${styles.queueActionBtn} ${styles.queueEdit} ${styles.saving}`}
                      onClick={saveEdit}
                    >
                      SAVE
                    </button>
                  ) : (
                    <>
                      <button
                        className={`${styles.queueActionBtn} ${styles.queueSend}`}
                        onClick={() => handleSendNow(item)}
                        title="Send now"
                      >
                        SEND
                      </button>
                      <button
                        className={`${styles.queueActionBtn} ${styles.queueEdit}`}
                        onClick={() => startEdit(item)}
                        title="Edit"
                      >
                        EDIT
                      </button>
                      <button
                        className={`${styles.queueActionBtn} ${styles.queueMove}`}
                        onClick={() =>
                          setMovingItemId(
                            movingItemId === item.id ? null : item.id,
                          )
                        }
                        title="Move to another session"
                      >
                        MOVE
                      </button>
                      <button
                        className={`${styles.queueActionBtn} ${styles.queueDelete}`}
                        onClick={() => remove(sessionId, item.id)}
                        title="Remove"
                      >
                        DEL
                      </button>
                    </>
                  )}
                </div>

                {/* Move-to picker */}
                {movingItemId === item.id && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      zIndex: 10,
                      background: 'var(--surface-card, #12122a)',
                      border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                      borderRadius: '4px',
                      padding: '4px',
                      maxHeight: '160px',
                      overflowY: 'auto',
                    }}
                  >
                    {otherSessions.length === 0 ? (
                      <div
                        style={{
                          padding: '8px',
                          color: 'var(--text-dim)',
                          fontSize: '10px',
                          textAlign: 'center',
                        }}
                      >
                        No other sessions
                      </div>
                    ) : (
                      otherSessions.map(([sid, s]) => (
                        <button
                          key={sid}
                          onClick={() => handleMoveConfirm(sid)}
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '4px 8px',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-primary, #e0e0e0)',
                            fontFamily:
                              'var(--font-mono)',
                            fontSize: '10px',
                            textAlign: 'left',
                            cursor: 'pointer',
                            borderRadius: '3px',
                          }}
                          onMouseEnter={(e) => {
                            (e.target as HTMLElement).style.background =
                              'rgba(0,229,255,0.1)';
                          }}
                          onMouseLeave={(e) => {
                            (e.target as HTMLElement).style.background =
                              'transparent';
                          }}
                        >
                          {s.projectName || sid.slice(0, 8)}
                          {s.title ? ` — ${s.title}` : ''}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
