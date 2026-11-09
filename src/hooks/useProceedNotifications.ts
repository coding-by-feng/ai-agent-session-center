/**
 * useProceedNotifications — the desktop app's system notification when a session's answer asks the
 * user to reply "proceed" (the amber P; Nov 8 2026). Mounted once in the main window's AppLayout;
 * does nothing without the desktop bridge (`window.electronAPI.notify`: a browser dashboard or a
 * Client edition), so one Mac notifies once. An ask must stand PROCEED_NOTIFY_SETTLE_MS before it
 * notifies, and is skipped when muted, when Settings → Sound → Notifications has it off, or while
 * that session is open in a focused window. Clicking the notification opens the session.
 * Rules: src/lib/proceedNotify.ts. The phone gets the same turn as a push (pushNotifier.ts).
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import {
  PROCEED_NOTIFY_SETTLE_MS,
  newProceedAsks,
  proceedNotice,
  shouldShowProceed,
  type ProceedAsk,
} from '@/lib/proceedNotify';

function showIfStillOwed(ask: ProceedAsk, notify: NonNullable<NonNullable<Window['electronAPI']>['notify']>): void {
  const { sessions, selectedSessionId } = useSessionStore.getState();
  const session = sessions.get(ask.sessionId);
  const ctx = {
    enabled: useSettingsStore.getState().proceedNotifyEnabled,
    focused: document.hasFocus(),
    openSessionId: useUiStore.getState().detailPanelMinimized ? null : selectedSessionId,
  };
  if (!session || !shouldShowProceed(session, ask.askedAt, ctx)) return;
  notify(proceedNotice(session)).catch(() => { /* no notification is not worth a toast */ });
}

export function useProceedNotifications(): void {
  useEffect(() => {
    const api = window.electronAPI;
    const notify = api?.notify;
    if (!notify) return;

    let seen = new Map<string, number | null>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const look = (sessions: Map<string, { sessionId: string; status: string }>) => {
      const result = newProceedAsks(seen, sessions.values());
      seen = result.seen;
      for (const ask of result.asks) {
        const t = setTimeout(() => { timers.delete(t); showIfStillOwed(ask, notify); }, PROCEED_NOTIFY_SETTLE_MS);
        timers.add(t);
      }
    };

    look(useSessionStore.getState().sessions);
    const unsubscribe = useSessionStore.subscribe((state, prev) => {
      if (state.sessions !== prev.sessions) look(state.sessions);
    });
    const offOpen = api.onOpenSession?.((sessionId) => {
      useSessionStore.getState().selectSession(sessionId);
      useUiStore.getState().restoreDetailPanel();
    });
    return () => {
      unsubscribe();
      offOpen?.();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);
}
