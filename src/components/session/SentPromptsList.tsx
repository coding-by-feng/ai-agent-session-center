/**
 * SentPromptsList — the queue History sheet's **Sent** tab (Nov 27 2026): every prompt this session was sent,
 * newest first, typed in the terminal or Chat as well as sent from the queue (lib/sentPrompts.ts). The card's
 * last 50 show at once; the Mac's record (`GET /api/db/prompts`) fills in the rest, a page at a time.
 *
 * Tap a row to see its whole text. **Queue again** adds it to this session's queue as a Once item, the way
 * the Saved tab's Apply does; **Copy** puts it on the clipboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import { authFetch } from '@/hooks/useAuth';
import { applyTypeDefaults } from '@/lib/queueScheduler';
import { showToast } from '@/components/ui/ToastContainer';
import {
  fetchSentPage,
  fromPromptHistory,
  mergeSentPrompts,
  type SentPrompt,
} from '@/lib/sentPrompts';
import styles from '@/styles/modules/QueueHistory.module.css';

export interface SentPromptsListProps {
  sessionId: string;
}

/** Add `text` to the end of the session's queue as a Once item (ids as queueHistoryStore.applyToSession mints them). */
function queueAgain(sessionId: string, text: string): void {
  const store = useQueueStore.getState();
  const existing = store.queues.get(sessionId) ?? [];
  const maxExisting = existing.reduce((m, it) => (it.id > m ? it.id : m), 0);
  const item = applyTypeDefaults(
    { id: Math.max(maxExisting, Date.now()) + 1, sessionId, text, position: existing.length, createdAt: Date.now() },
    'once',
    {},
  );
  store.add(sessionId, item);
}

function formatWhen(ts: number): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SentPromptsList({ sessionId }: SentPromptsListProps) {
  const history = useSessionStore((s) => s.sessions.get(sessionId)?.promptHistory);
  const memory = useMemo(() => fromPromptHistory(history), [history]);
  const [stored, setStored] = useState<SentPrompt[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const load = useCallback(async (next: number, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSentPage(sessionId, next, (url) => authFetch(url, { signal }));
      if (signal?.aborted) return;
      setStored((prev) => (next === 1 ? result.prompts : [...prev, ...result.prompts]));
      setPage(next);
      setMore(result.more);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error && err.message ? err.message : 'Couldn’t load earlier prompts.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [sessionId]);

  // One read at a time: a later page or a retry cancels the one before, and closing (or a switch, which
  // remounts this per session) cancels the last, so no page lands in the wrong list.
  const pending = useRef<AbortController | null>(null);
  const loadPage = useCallback((next: number) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    void load(next, controller.signal);
  }, [load]);

  useEffect(() => {
    loadPage(1);
    return () => pending.current?.abort();
  }, [loadPage]);

  const all = useMemo(() => mergeSentPrompts(memory, stored), [memory, stored]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? all.filter((p) => p.text.toLowerCase().includes(q)) : all;
  }, [all, filter]);

  const onQueueAgain = useCallback((p: SentPrompt) => {
    queueAgain(sessionId, p.text);
    showToast('Added to the queue', 'success', 1500);
  }, [sessionId]);

  const onCopy = useCallback(async (p: SentPrompt) => {
    try {
      await navigator.clipboard.writeText(p.text);
      showToast('Copied', 'info', 1200);
    } catch {
      showToast('Couldn’t copy. Select the text instead.', 'error', 2500);
    }
  }, []);

  return (
    <>
      <div className={styles.controlsRow}>
        <input
          className={styles.filterInput}
          type="text"
          placeholder="Filter sent prompts…"
          aria-label="Filter sent prompts"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className={styles.body} data-testid="sent-prompts">
        {visible.length === 0 && !loading && !error && (
          <div className={styles.empty}>{all.length === 0 ? 'Nothing sent to this session yet.' : 'No sent prompts match the filter.'}</div>
        )}
        {visible.map((p) => {
          const key = `${p.timestamp}:${p.text.length}`;
          const expanded = openKey === key;
          return (
            <div key={key} className={styles.row} data-testid="sent-row">
              <button
                type="button"
                className={`${styles.sentText}${expanded ? ` ${styles.sentTextOpen}` : ''}`}
                aria-expanded={expanded}
                onClick={() => setOpenKey(expanded ? null : key)}
              >
                {p.text}
              </button>
              <div className={styles.sentFoot}>
                <span className={styles.rowMeta}>{formatWhen(p.timestamp)}</span>
                <span className={styles.sentActions}>
                  <button type="button" className={styles.btnGhost} onClick={() => { void onCopy(p); }}>Copy</button>
                  <button type="button" className={styles.btnPrimary} onClick={() => onQueueAgain(p)}>Queue again</button>
                </span>
              </div>
            </div>
          );
        })}
        {error && (
          <div className={styles.sentNotice} role="alert">
            <span>{error}</span>
            <button type="button" className={styles.btnGhost} onClick={() => loadPage(page + 1)}>Retry</button>
          </div>
        )}
        {loading && <div className={styles.empty} role="status">Loading…</div>}
        {!loading && !error && more && (
          <button type="button" className={`${styles.btnGhost} ${styles.sentMore}`} onClick={() => loadPage(page + 1)}>
            Load earlier
          </button>
        )}
      </div>
    </>
  );
}
