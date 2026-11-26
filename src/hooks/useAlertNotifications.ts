/**
 * useAlertNotifications — the desktop app's system notification for a session whose alert level notifies every
 * moment (Loud and Urgent by default, src/lib/attention.ts) when it finishes a turn or needs you (Nov 23 2026).
 * Mounted once in the main window's AppLayout beside useProceedNotifications, which also opens the session when a
 * notification is clicked (`app:open-session`). Does nothing without the desktop bridge (`window.electronAPI.notify`:
 * a browser dashboard or a Client edition), so one Mac notifies once. A moment must stand ALERT_NOTIFY_SETTLE_MS.
 * Rules: src/lib/alertNotify.ts.
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { ALERT_NOTIFY_SETTLE_MS, alertNotice, newAlertMoments, shouldShowAlert, type AlertKind, type AlertMoment } from '@/lib/alertNotify';
import { sessionAlertOf } from '@/lib/sessionAlertLevel';
import type { Session } from '@/types';

type Notify = NonNullable<NonNullable<Window['electronAPI']>['notify']>;

function showIfStillOwed(moment: AlertMoment, notify: Notify): void {
  const { sessions, selectedSessionId } = useSessionStore.getState();
  const session = sessions.get(moment.sessionId);
  const ctx = {
    focused: document.hasFocus(),
    openSessionId: useUiStore.getState().detailPanelMinimized ? null : selectedSessionId,
    notify: session ? sessionAlertOf(session).outputs.notify : 'none',
  };
  if (!session || !shouldShowAlert(session, moment.kind, ctx)) return;
  notify(alertNotice(session, moment.kind)).catch(() => { /* no notification is not worth a toast */ });
}

export function useAlertNotifications(): void {
  useEffect(() => {
    const notify = window.electronAPI?.notify;
    if (!notify) return;

    let seen = new Map<string, AlertKind | null>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const look = (sessions: Map<string, Session>) => {
      const result = newAlertMoments(seen, sessions.values(), (s) => sessionAlertOf(s).outputs.notify === 'all');
      seen = result.seen;
      for (const moment of result.moments) {
        const t = setTimeout(() => { timers.delete(t); showIfStillOwed(moment, notify); }, ALERT_NOTIFY_SETTLE_MS);
        timers.add(t);
      }
    };

    look(useSessionStore.getState().sessions);
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) look(state.sessions);
    });
    return () => {
      unsubscribe();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);
}
