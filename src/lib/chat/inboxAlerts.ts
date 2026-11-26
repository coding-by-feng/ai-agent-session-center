/**
 * inboxAlerts.ts — which raised alerts the phone's Inbox lists and its badge counts (Nov 26 2026). The same rule as
 * the desktop bell (attentionInbox.ts): an alert is shown when the level it ends up at, the quieter of what the
 * central asked and the session's own (`raisedAlertLevel`), has `hint` on; a Silent session's never is. The phone
 * reads the default level table (it has no level UI yet), so in practice that is "not Silent".
 */
import type { RaisedAlert } from '@/types/alert';
import type { AlertLevel, AlertLevelOutputs } from '@/lib/attention';
import { raisedAlertLevel } from '@/lib/raisedAlerts';

export interface AlertSessionRef {
  sessionId: string;
  status: string;
}

export function shownAlerts<S extends AlertSessionRef>(
  alerts: readonly RaisedAlert[],
  sessions: ReadonlyMap<string, S>,
  levelOf: (session: S) => AlertLevel,
  outputsOf: (level: AlertLevel) => AlertLevelOutputs,
): RaisedAlert[] {
  return alerts.filter((alert) => {
    const session = sessions.get(alert.sessionId);
    if (!session || session.status === 'ended') return false;
    return outputsOf(raisedAlertLevel(alert.level, levelOf(session))).hint;
  });
}
