/**
 * QueueView - Global prompt queue management across all sessions.
 * Shows each session's queued prompts in a table-based layout.
 * Supports add, remove, move-between-sessions.
 */
import { useState, useCallback } from 'react';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Queue.module.css';
import termStyles from '@/styles/modules/Terminal.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextId = Date.now();
function localId(): number {
  return nextId++;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QueueView() {
  const queues = useQueueStore((s) => s.queues);
  const add = useQueueStore((s) => s.add);
  const remove = useQueueStore((s) => s.remove);
  const moveToSession = useQueueStore((s) => s.moveToSession);
  const sessions = useSessionStore((s) => s.sessions);

  const [composeSessionId, setComposeSessionId] = useState('');
  const [composeText, setComposeText] = useState('');
  const [movingItem, setMovingItem] = useState<{
    itemId: number;
    fromSessionId: string;
  } | null>(null);

  // Build a list of sessions that have queue items
  const sessionIds = Array.from(
    new Set([...queues.keys(), ...sessions.keys()]),
  ).filter((sid) => {
    const items = queues.get(sid);
    return items && items.length > 0;
  });

  const totalItems = Array.from(queues.values()).reduce(
    (sum, items) => sum + items.length,
    0,
  );

  // ---- Add prompt to a session ----
  const handleAdd = useCallback(() => {
    const trimmed = composeText.trim();
    if (!trimmed || !composeSessionId) return;
    const items = queues.get(composeSessionId) ?? [];
    const newItem: QueueItem = {
      id: localId(),
      sessionId: composeSessionId,
      text: trimmed,
      position: items.length,
      createdAt: Date.now(),
    };
    add(composeSessionId, newItem);
    setComposeText('');
    showToast('Prompt added to queue', 'info', 2000);
  }, [composeText, composeSessionId, queues, add]);

  // ---- Move confirm ----
  const handleMoveConfirm = useCallback(
    (targetSessionId: string) => {
      if (!movingItem) return;
      moveToSession(
        [movingItem.itemId],
        movingItem.fromSessionId,
        targetSessionId,
      );
      setMovingItem(null);
      showToast('Prompt moved', 'info', 2000);
    },
    [movingItem, moveToSession],
  );

  const allSessions = Array.from(sessions.entries());

  return (
    <div data-testid="queue-view" style={{ height: '100%', overflow: 'auto' }}>
      {/* Header controls */}
      <div className={styles.controls}>
        <h2 className={styles.title}>PROMPT QUEUE</h2>
      </div>

      {/* Stats */}
      <div className={styles.stats}>
        <span>{totalItems} queued prompt{totalItems !== 1 ? 's' : ''}</span>
        <span className={styles.statsSep}>|</span>
        <span>{sessionIds.length} session{sessionIds.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Compose area */}
      <div style={{ padding: '0 24px 16px' }}>
        <div className={termStyles.queueCompose}>
          <select
            value={composeSessionId}
            onChange={(e) => setComposeSessionId(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
              borderRadius: '4px',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              padding: '6px 8px',
              minWidth: '180px',
            }}
          >
            <option value="">Select session...</option>
            {allSessions.map(([sid, s]) => (
              <option key={sid} value={sid}>
                {s.projectName || sid.slice(0, 8)}
                {s.title ? ` — ${s.title}` : ''}
              </option>
            ))}
          </select>
          <textarea
            className={termStyles.queueTextarea}
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
            className={`${termStyles.toolbarBtn} ${termStyles.queueAddBtn}`}
            onClick={handleAdd}
            disabled={!composeText.trim() || !composeSessionId}
          >
            ADD
          </button>
        </div>
      </div>

      {/* Queue content */}
      <div className={styles.content}>
        {sessionIds.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 0',
              color: 'var(--text-dim)',
              fontSize: '13px',
            }}
          >
            No prompts in queue. Add prompts from session detail panels or above.
          </div>
        ) : (
          sessionIds.map((sid) => {
            const items = queues.get(sid) ?? [];
            const session = sessions.get(sid);
            return (
              <div key={sid} className={styles.viewGroup}>
                {/* Group header */}
                <div className={styles.groupHeader}>
                  <span className={styles.sessionName}>
                    {session?.projectName || 'Unknown'}
                  </span>
                  {session?.label && (
                    <span className={styles.label}>{session.label}</span>
                  )}
                  <span className={styles.sid}>{sid.slice(0, 8)}</span>
                  <span className={styles.itemCount}>
                    {items.length} item{items.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Table */}
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.pos}>#</th>
                      <th>Prompt</th>
                      <th>Added</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr key={item.id}>
                        <td className={styles.pos}>{idx + 1}</td>
                        <td className={styles.text}>{item.text}</td>
                        <td className={styles.date}>
                          {formatDate(item.createdAt)}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '4px' }}>
                            <button
                              className={`${termStyles.queueActionBtn} ${termStyles.queueMove}`}
                              onClick={() =>
                                setMovingItem(
                                  movingItem?.itemId === item.id
                                    ? null
                                    : { itemId: item.id, fromSessionId: sid },
                                )
                              }
                            >
                              MOVE
                            </button>
                            <button
                              className={`${termStyles.queueActionBtn} ${termStyles.queueDelete} ${styles.deleteBtn}`}
                              onClick={() => remove(sid, item.id)}
                            >
                              DEL
                            </button>
                          </div>

                          {/* Move picker */}
                          {movingItem?.itemId === item.id && (
                            <div
                              style={{
                                position: 'absolute',
                                zIndex: 10,
                                background:
                                  'var(--surface-card, #12122a)',
                                border:
                                  '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                                borderRadius: '4px',
                                padding: '4px',
                                maxHeight: '160px',
                                overflowY: 'auto',
                                minWidth: '180px',
                              }}
                            >
                              {allSessions
                                .filter(([id]) => id !== sid)
                                .map(([targetId, s]) => (
                                  <button
                                    key={targetId}
                                    onClick={() =>
                                      handleMoveConfirm(targetId)
                                    }
                                    style={{
                                      display: 'block',
                                      width: '100%',
                                      padding: '4px 8px',
                                      background: 'transparent',
                                      border: 'none',
                                      color: 'var(--text-primary)',
                                      fontFamily: 'var(--font-mono)',
                                      fontSize: '10px',
                                      textAlign: 'left',
                                      cursor: 'pointer',
                                      borderRadius: '3px',
                                    }}
                                    onMouseEnter={(e) => {
                                      (
                                        e.target as HTMLElement
                                      ).style.background =
                                        'rgba(0,229,255,0.1)';
                                    }}
                                    onMouseLeave={(e) => {
                                      (
                                        e.target as HTMLElement
                                      ).style.background = 'transparent';
                                    }}
                                  >
                                    {s.projectName || targetId.slice(0, 8)}
                                    {s.title ? ` — ${s.title}` : ''}
                                  </button>
                                ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
