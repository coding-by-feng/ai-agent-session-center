/**
 * CloseSuggestionsModal — "Sessions to close" (Nov 17 2026, by request), opened from the header's
 * memory chip. Lists the sessions the server suggests closing (quiet for the chosen time: idle, or
 * never given a prompt; server/closeSuggestions.ts), each with its reason and memory. Every row is
 * ticked; the person unticks what to keep and closes the rest through the same hardened kill path
 * as the room kill (lib/roomKill.ts). It only suggests: nothing closes without the button.
 *
 * The list can be minutes old by the time the button is clicked, and most of what makes a session
 * unsafe to close (typing in its terminal, a pin, an armed queue) does not change its status. So:
 * a row disappears when its session leaves idle/waiting (the store is live), and the Close click
 * asks the server again and closes only the ticked sessions it still suggests. If that second read
 * fails, nothing is closed.
 */
import { useEffect, useMemo, useState } from 'react';
import { authFetch } from '@/hooks/useAuth';
import { useSessionStore } from '@/stores/sessionStore';
import { useSessionMemoryStore } from '@/stores/sessionMemoryStore';
import { useUiStore, CLOSE_SUGGESTIONS_MODAL_ID } from '@/stores/uiStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import NativeSelect from '@/components/ui/NativeSelect';
import { showToast } from '@/components/ui/ToastContainer';
import { killSessions } from '@/lib/roomKill';
import { formatMemory } from '@/lib/memoryFormat';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import {
  CLOSE_QUIET_CHOICES,
  DEFAULT_CLOSE_QUIET_MINUTES,
  closeReasonLabel,
  quietChoiceLabel,
  type CloseSuggestion,
  type CloseSuggestionsResponse,
} from '@/lib/closeSuggestions';
import type { Session } from '@/types';
import modalStyles from '@/styles/modules/Modal.module.css';
import styles from '@/styles/modules/CloseSuggestionsModal.module.css';

const QUIET_OPTIONS = CLOSE_QUIET_CHOICES.map((minutes) => ({ value: String(minutes), label: quietChoiceLabel(minutes) }));

/** One answer from the server, tagged with the quiet time it was asked for. */
interface Loaded {
  quietMinutes: number;
  suggestions: CloseSuggestion[];
  failed: boolean;
}

interface Row {
  session: Session;
  reason: string;
  bytes: number;
  quietMs: number;
}

const sessionCount = (count: number): string => `${count} session${count === 1 ? '' : 's'}`;

/** `kept`: ticked sessions the second read no longer suggested, so they were left running. */
function closedSummary(killed: number, failed: number, kept: number): { message: string; type: 'success' | 'error' } {
  const tail = kept > 0 ? ` · kept ${kept} now in use` : '';
  if (failed === 0) return { message: `Closed ${sessionCount(killed)}${tail}`, type: 'success' };
  if (killed === 0) return { message: `Could not close ${sessionCount(failed)}${tail}`, type: 'error' };
  return { message: `Closed ${killed} of ${sessionCount(killed + failed)}: ${failed} still running${tail}`, type: 'error' };
}

/** The server's suggestions for a quiet time, or null when they could not be read. */
async function readSuggestions(quietMinutes: number): Promise<CloseSuggestion[] | null> {
  try {
    const res = await authFetch(`/api/session-close-suggestions?quietMinutes=${quietMinutes}`);
    if (!res.ok) return null;
    return ((await res.json()) as CloseSuggestionsResponse).suggestions;
  } catch {
    return null;
  }
}

export default function CloseSuggestionsModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  const sessions = useSessionStore((s) => s.sessions);
  const sample = useSessionMemoryStore((s) => s.sample);
  const [quietMinutes, setQuietMinutes] = useState<number>(DEFAULT_CLOSE_QUIET_MINUTES);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The sessions to keep. It survives a change of quiet time on purpose: a session the person chose
  // to keep stays kept if it shows up in the next list.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readSuggestions(quietMinutes).then((suggestions) => {
      if (!cancelled) setLoaded({ quietMinutes, suggestions: suggestions ?? [], failed: suggestions === null });
    });
    return () => { cancelled = true; };
  }, [quietMinutes]);

  // An answer for another quiet time is not this list: show the reading line until the right one lands.
  const current = loaded && loaded.quietMinutes === quietMinutes ? loaded : null;

  const rows = useMemo<Row[]>(() => {
    if (!current) return [];
    return current.suggestions
      .flatMap((suggestion) => {
        const session = sessions.get(suggestion.sessionId);
        // Gone, or no longer quiet since the list was read.
        if (!session || (session.status !== 'idle' && session.status !== 'waiting')) return [];
        return [{
          session,
          reason: closeReasonLabel(suggestion),
          bytes: sample?.bySession[suggestion.sessionId] ?? 0,
          quietMs: suggestion.quietMs,
        }];
      })
      .sort((a, b) => b.bytes - a.bytes || b.quietMs - a.quietMs);
  }, [current, sessions, sample]);

  const ticked = rows.filter((row) => !unticked.has(row.session.sessionId));
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);

  const toggle = (sessionId: string) => {
    setUnticked((prev) => {
      const next = new Set(prev);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  };

  const handleClose = async () => {
    if (closing || ticked.length === 0) return;
    setClosing(true);
    // Ask again: close only what the server still suggests now.
    const fresh = await readSuggestions(quietMinutes);
    if (fresh === null) {
      showToast('Could not check the sessions again, so nothing was closed', 'error');
      setClosing(false);
      return;
    }
    const stillSuggested = new Set(fresh.map((suggestion) => suggestion.sessionId));
    const targets = ticked.map((row) => row.session).filter((session) => stillSuggested.has(session.sessionId));
    const kept = ticked.length - targets.length;
    setLoaded({ quietMinutes, suggestions: fresh, failed: false });
    if (targets.length === 0) {
      showToast(`Nothing closed: ${sessionCount(kept)} now in use`, 'info');
      setClosing(false);
      return;
    }
    const { killed, failed } = await killSessions(targets);
    const { message, type } = closedSummary(killed, failed, kept);
    showToast(message, type);
    setClosing(false);
    closeModal();
  };

  return (
    <Modal modalId={CLOSE_SUGGESTIONS_MODAL_ID} title="Sessions to close" panelClassName={styles.panel} locked={closing}>
      <div className={styles.bar}>
        <span className={styles.summary} aria-live="polite">
          {current && !current.failed && rows.length > 0
            && `${rows.length} suggested${totalBytes > 0 ? ` · ${formatMemory(totalBytes)}` : ''}`}
        </span>
        <label className={styles.quiet}>
          Quiet for
          <NativeSelect
            aria-label="Quiet for"
            value={String(quietMinutes)}
            onChange={(value) => setQuietMinutes(Number(value))}
            options={QUIET_OPTIONS}
            disabled={closing}
          />
        </label>
      </div>

      {!current && <p className={styles.note}>Checking sessions…</p>}
      {current?.failed && <p className={styles.note} role="alert">Could not read the sessions to close.</p>}
      {current && !current.failed && rows.length === 0 && (
        <p className={styles.note}>
          Nothing to close: every running session is busy, protected or prompted within {quietChoiceLabel(quietMinutes)}.
        </p>
      )}
      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map(({ session, reason, bytes }) => (
            <li key={session.sessionId}>
              <label className={styles.row}>
                <input
                  type="checkbox"
                  className={styles.check}
                  checked={!unticked.has(session.sessionId)}
                  onChange={() => toggle(session.sessionId)}
                  disabled={closing}
                />
                {/* The full name on hover: a long title is cut to keep the reason and memory whole. */}
                <span className={styles.title} title={sessionDisplayTitle(session)}>{sessionDisplayTitle(session)}</span>
                <span className={styles.reason}>{reason}</span>
                <span className={styles.memory}>{bytes > 0 ? formatMemory(bytes) : ''}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/* With no rows there is nothing to cancel or close: one way out, and no dead red button. */}
      <div className={modalStyles.actions}>
        <Button onClick={closeModal} disabled={closing}>{rows.length === 0 ? 'DONE' : 'CANCEL'}</Button>
        {rows.length > 0 && (
          <Button
            variant="danger"
            onClick={() => void handleClose()}
            disabled={closing || ticked.length === 0}
            aria-busy={closing || undefined}
          >
            {closing ? 'CLOSING...' : ticked.length === 0 ? 'CLOSE' : `CLOSE ${sessionCount(ticked.length).toUpperCase()}`}
          </Button>
        )}
      </div>
    </Modal>
  );
}
