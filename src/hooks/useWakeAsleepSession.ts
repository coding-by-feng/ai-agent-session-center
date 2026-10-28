/**
 * useWakeAsleepSession — opening a session AASC put to sleep resumes it (Oct 28 2026).
 *
 * A sleeping card (`Session.asleepAt`, server/sessionSleep.ts) has no CLI running. When the person
 * opens it in the detail panel, its ordinary resume runs once (`POST /api/sessions/:id/resume`: a fresh
 * terminal with `--resume <id>`), which clears the mark on the server. One request per sleep, however
 * often the panel re-renders or the person comes back to the card while it is still waking.
 */
import { useEffect } from 'react';
import { authFetch } from '@/hooks/useAuth';
import { requestSessionResume } from '@/lib/sessionActions';
import { showToast } from '@/components/ui/ToastContainer';

/** `${sessionId}:${asleepAt}` of every sleep a wake was already sent for. */
const sent = new Set<string>();

export function wakeKey(sessionId: string, asleepAt: number): string {
  return `${sessionId}:${asleepAt}`;
}

/** @internal — test only. */
export function __resetWakesForTest(): void {
  sent.clear();
}

export function useWakeAsleepSession(sessionId: string | null | undefined, asleepAt: number | undefined): void {
  useEffect(() => {
    if (!sessionId || !asleepAt) return;
    const key = wakeKey(sessionId, asleepAt);
    if (sent.has(key)) return;
    sent.add(key);
    requestSessionResume(sessionId, undefined, authFetch)
      .then((result) => {
        if (!result.ok) {
          sent.delete(key);
          showToast(`Couldn’t wake the session: ${result.message}`, 'error');
        }
      })
      .catch(() => {
        sent.delete(key);
        showToast('Couldn’t wake the session. Try RESUME.', 'error');
      });
  }, [sessionId, asleepAt]);
}
