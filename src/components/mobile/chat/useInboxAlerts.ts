/**
 * useInboxAlerts — the raised alerts the phone's Inbox lists and its tab badge counts (Nov 26 2026): one list, so
 * the badge and the Waiting chip agree. Rule: src/lib/chat/inboxAlerts.ts.
 */
import { useMemo } from 'react';
import type { RaisedAlert } from '@/types';
import { useAttentionStore } from '@/stores/attentionStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { alertOf } from '@/lib/sessionAlertLevel';
import { shownAlerts } from '@/lib/chat/inboxAlerts';

export function useInboxAlerts(): RaisedAlert[] {
  const alerts = useAttentionStore((s) => s.alerts);
  const sessions = useSessionStore((s) => s.sessions);
  const rooms = useRoomStore((s) => s.rooms);
  const config = useAlertConfigStore((s) => s.config);
  return useMemo(
    () => shownAlerts(
      alerts,
      sessions,
      (s) => alertOf(s, rooms, config).level,
      (level) => config.levels[level],
    ),
    [alerts, sessions, rooms, config],
  );
}
