/**
 * Alerts a central raised for the person (MCP `alert_raise`, Nov 26 2026): "this needs you" in the header's bell,
 * beside the sessions that wait on a question, an approval or a proceed ask. Held in the server's memory only
 * (server/alerts/alertStore.ts): a central that still sees the problem raises it again on its next tick.
 */
import type { AlertLevel } from '../lib/attention.js';

export interface RaisedAlert {
  id: string;
  /** The central's own name for the problem. Raising the same key while it is open updates this alert. */
  key: string;
  /** The session it is about: the central's own card, or a session in its scope. */
  sessionId: string;
  /** The central that raised it ('' on another device: centrals are this Mac's own). */
  centralId: string;
  /** The card that central runs in, when it had one (null on a remote device that may not see that card). */
  centralSessionId: string | null;
  /** One line of plain text (src/lib/raisedAlerts.ts `cleanAlertMessage`), written by an agent: never markup. */
  message: string;
  /** The level the central asked for; the session's own level caps it (`raisedAlertLevel`). Absent: the session's. */
  level?: AlertLevel;
  raisedAt: number;
  updatedAt: number;
  /** How many times it was raised while open (1 the first time). */
  count: number;
}

/** Every open alert, cut for what this device may see (a remote device: shared sessions only). */
export interface AlertsUpdateMessage {
  type: 'alerts_update';
  alerts: RaisedAlert[];
}
