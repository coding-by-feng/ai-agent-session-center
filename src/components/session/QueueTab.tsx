/**
 * QueueTab - Per-session prompt queue management.
 * Features: compose + add, reorder (drag), edit, delete, send now,
 * move to another session, auto-send on "waiting" status.
 * Uses Terminal.module.css queue styles.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueueStore, type QueueItem, type QueueImageAttachment } from '@/stores/queueStore';
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
  const [composeImages, setComposeImages] = useState<QueueImageAttachment[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('queue-panel-collapsed');
      return stored === null ? true : stored === '1';
    } catch { return true; }
  });
  const [autoSend, setAutoSend] = useState(() => {
    try {
      const stored = localStorage.getItem('queue-auto-send');
      return stored === null ? true : stored === '1';
    } catch { return true; }
  });
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

  // ---- Upload images to server and get back file paths ----
  const uploadImages = useCallback(async (images: QueueImageAttachment[]): Promise<string[]> => {
    try {
      const res = await fetch('/api/queue-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      if (res.ok) {
        const data = await res.json();
        return data.paths ?? [];
      }
    } catch { /* ignore */ }
    return [];
  }, []);

  // ---- Send a queue item to terminal (text + optional images) ----
  const sendItemToTerminal = useCallback(
    async (item: QueueItem): Promise<boolean> => {
      if (!terminalId) {
        showToast('No terminal attached', 'error');
        return false;
      }
      let textToSend = item.text.replace(/\\n/g, '\n');
      if (item.images && item.images.length > 0) {
        const paths = await uploadImages(item.images);
        if (paths.length > 0) textToSend += '\n' + paths.join('\n');
      }
      try {
        const res = await fetch(`/api/terminals/${terminalId}/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: textToSend + '\n' }),
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
    [terminalId, uploadImages],
  );


  // ---- Auto-send: when session transitions to "waiting" or "input", send first queued prompt ----
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = sessionStatus;

    if (!autoSend) return;
    if (prev === sessionStatus) return;
    const isWaiting =
      sessionStatus === 'waiting' || sessionStatus === 'input';
    if (!isWaiting) return;
    if (items.length === 0) return;
    // Only auto-send if there's a terminal attached
    if (!terminalId) return;

    // Send the first item — only remove after successful send
    const first = items[0];
    sendItemToTerminal(first).then((sent) => {
      if (sent) {
        remove(sessionId, first.id);
        showToast('Auto-sent queued prompt', 'info', 2000);
      }
    });
  }, [autoSend, sessionStatus, items, sessionId, terminalId, remove, sendItemToTerminal]);

  // ---- Image file picker ----
  const handleImagePick = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleImageFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
    // Reset input so same file can be re-selected
    e.target.value = '';
  }, []);

  const handleRemoveComposeImage = useCallback((idx: number) => {
    setComposeImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ---- Paste images/files from clipboard ----
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    // Prevent pasting binary as text
    e.preventDefault();
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
  }, []);

  // ---- Drag and drop files onto compose area ----
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    const readers = files.slice(0, 5).map(
      (f) =>
        new Promise<QueueImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({ name: f.name, dataUrl: reader.result as string });
          reader.onerror = reject;
          reader.readAsDataURL(f);
        }),
    );
    Promise.allSettled(readers).then((results) => {
      const imgs = results
        .filter((r): r is PromiseFulfilledResult<QueueImageAttachment> => r.status === 'fulfilled')
        .map((r) => r.value);
      setComposeImages((prev) => [...prev, ...imgs].slice(0, 5));
    });
  }, []);

  // ---- Add to queue ----
  const handleAdd = useCallback(() => {
    const trimmed = composeText.trim();
    if (!trimmed && composeImages.length === 0) return;
    const newItem: QueueItem = {
      id: localId(),
      sessionId,
      text: trimmed,
      position: items.length,
      createdAt: Date.now(),
      images: composeImages.length > 0 ? [...composeImages] : undefined,
    };
    add(sessionId, newItem);
    setComposeText('');
    setComposeImages([]);
  }, [composeText, composeImages, sessionId, items.length, add]);

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
      const sent = await sendItemToTerminal(item);
      if (sent) {
        remove(sessionId, item.id);
      }
    },
    [sendItemToTerminal, remove, sessionId],
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
      <div className={styles.queueHeader}>
        <button
          className={styles.queueToggle}
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            try { localStorage.setItem('queue-panel-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
          }}
        >
          <span className={styles.queueToggleArrow}>&#x25B6;</span>
          QUEUE{' '}
          <span className={styles.queueCount}>({items.length})</span>
        </button>
        <button
          className={`${styles.autoSendToggle} ${autoSend ? styles.autoSendOn : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            const next = !autoSend;
            setAutoSend(next);
            try { localStorage.setItem('queue-auto-send', next ? '1' : '0'); } catch { /* ignore */ }
            showToast(next ? 'Auto-send enabled' : 'Auto-send disabled', 'info', 1500);
          }}
          title={autoSend ? 'Auto-send ON — prompts sent automatically when session is waiting' : 'Auto-send OFF — prompts stay in queue'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className={styles.queueBody}>
        {/* Compose */}
        <div
          className={`${styles.queueCompose}${dragOver ? ` ${styles.queueComposeDragOver}` : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <textarea
            className={styles.queueTextarea}
            placeholder="Add a prompt to the queue... (paste images with Cmd+V, or drag files here)"
            rows={2}
            value={composeText}
            onChange={(e) => setComposeText(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleAdd();
              }
            }}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*,.pdf,.txt,.md,.json,.csv,.xml,.yaml,.yml,.log"
            multiple
            style={{ display: 'none' }}
            onChange={handleImageFiles}
          />
          <button
            className={`${styles.toolbarBtn} ${styles.queueAttachBtn}`}
            onClick={handleImagePick}
            title="Attach images"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <button
            className={`${styles.toolbarBtn} ${styles.queueAddBtn}`}
            onClick={handleAdd}
            disabled={!composeText.trim() && composeImages.length === 0}
          >
            ADD
          </button>
        </div>
        {composeImages.length > 0 && (
          <div className={styles.queueComposeImages}>
            {composeImages.map((img, i) => (
              <div key={i} className={styles.queueImageThumb}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  className={styles.queueImageRemove}
                  onClick={() => handleRemoveComposeImage(i)}
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

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
                  <div className={styles.queueTextCol}>
                    {item.text && <span className={styles.queueText}>{item.text}</span>}
                    {item.images && item.images.length > 0 && (
                      <div className={styles.queueItemImages}>
                        {item.images.map((img, i) => (
                          <div key={i} className={styles.queueItemThumb} title={img.name}>
                            <img src={img.dataUrl} alt={img.name} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
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
                              'var(--bg-accent)';
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
