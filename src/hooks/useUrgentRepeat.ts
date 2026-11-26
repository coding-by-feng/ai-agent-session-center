/**
 * useUrgentRepeat — reminds you, every `repeatMin` minutes of the session's alert level (Urgent by default), of a
 * finished turn, approval or question you have not handled (Nov 25 2026). Each reminder plays the level's sound
 * (playReminder; approval's own alarm already repeats) and, in the desktop app, notifies when the level notifies
 * (`window.electronAPI.notify`). Looks on every session update, on focus and selection changes, and every
 * REMINDER_TICK_MS. Mounted once in the main window's AppLayout. Rules: src/lib/urgentRepeat.ts.
 */
import { useEffect } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { playReminder } from '@/lib/alarmEngine';
import { sessionAlertOf } from '@/lib/sessionAlertLevel';
import { REMINDER_TICK_MS, reminderNotice, reminderStep, remindsByNotification, type ReminderState } from '@/lib/urgentRepeat';
import type { AlertMoment } from '@/lib/alertNotify';
import type { Session } from '@/types';

function lookingAt(): string | null {
  if (!document.hasFocus() || useUiStore.getState().detailPanelMinimized) return null;
  return useSessionStore.getState().selectedSessionId;
}

function remind(moment: AlertMoment, sessions: Map<string, Session>): void {
  const session = sessions.get(moment.sessionId);
  if (!session) return;
  if (moment.kind !== 'approval') playReminder(session, moment.kind);
  const notify = window.electronAPI?.notify;
  const { outputs } = sessionAlertOf(session);
  const proceedEnabled = useSettingsStore.getState().proceedNotifyEnabled;
  if (!notify || !remindsByNotification(session, moment.kind, outputs.notify, proceedEnabled)) return;
  notify(reminderNotice(session, moment.kind)).catch(() => { /* no notification is not worth a toast */ });
}

export function useUrgentRepeat(): void {
  useEffect(() => {
    let state: ReminderState = { seen: new Map(), owed: new Map() };
    const look = () => {
      const { sessions } = useSessionStore.getState();
      const step = reminderStep(state, {
        sessions: sessions.values(),
        now: Date.now(),
        lookingAt: lookingAt(),
        repeatMinOf: (s) => sessionAlertOf(s).outputs.repeatMin,
      });
      state = step.state;
      for (const moment of step.due) remind(moment, sessions);
    };

    look();
    const unsubscribeSessions = useSessionStore.subscribe((now, prev) => {
      if (now.sessions !== prev.sessions || now.selectedSessionId !== prev.selectedSessionId) look();
    });
    const unsubscribeUi = useUiStore.subscribe((now, prev) => {
      if (now.detailPanelMinimized !== prev.detailPanelMinimized) look();
    });
    window.addEventListener('focus', look);
    const tick = setInterval(look, REMINDER_TICK_MS);
    return () => {
      unsubscribeSessions();
      unsubscribeUi();
      window.removeEventListener('focus', look);
      clearInterval(tick);
    };
  }, []);
}
