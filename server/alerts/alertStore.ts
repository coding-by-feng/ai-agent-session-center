// alerts/alertStore.ts — the alerts centrals raise for the person (MCP alert_raise, Nov 26 2026), in memory.
//
// One open alert per central and key: raising the key again while it is open updates that alert (its message, level
// and time) instead of adding one, so a watchdog that re-checks every 30 minutes alerts once per problem. Dismissing
// it closes it; the next raise of that key opens a new one. Nothing is written to disk: after a restart a central that
// still sees the problem raises it again, and nothing stale comes back.
//
// Limits (src/lib/raisedAlerts.ts): 10 open alerts per central and 100 in all (a new key past either is TOO_MANY),
// 30 raises a minute per central (RATE_LIMITED), and an alert nobody raised again for 24 hours expires (`sweep`).
//
// Who may see an alert, and who may raise one, is the routes' business (alertsRouter.ts) and the tools'
// (server/mcp/tools/alerts.ts). The store hands out copies, so a caller cannot change what it holds.

import { randomUUID } from 'crypto';
import type { AlertLevel } from '../../src/lib/attention.js';
import {
  RAISED_ALERT_TTL_MS,
  RAISED_ALERTS_PER_CENTRAL,
  RAISED_ALERTS_TOTAL,
  RAISES_PER_MINUTE,
} from '../../src/lib/raisedAlerts.js';
import type { RaisedAlert } from '../../src/types/alert.js';
import log from '../logger.js';

const MINUTE_MS = 60_000;

export interface RaiseInput {
  centralId: string;
  centralSessionId: string | null;
  sessionId: string;
  key: string;
  /** Already cleaned (`cleanAlertMessage`) and not empty. */
  message: string;
  level?: AlertLevel;
}

export type RaiseResult =
  | { ok: true; alert: RaisedAlert; created: boolean }
  | { ok: false; code: 'TOO_MANY' | 'RATE_LIMITED'; error: string };

export type AlertChange =
  | { type: 'raised'; alert: RaisedAlert; created: boolean }
  | { type: 'dismissed'; alert: RaisedAlert }
  | { type: 'expired'; count: number };

export interface AlertStoreDeps {
  now?: () => number;
  newId?: () => string;
}

export interface AlertStore {
  /** Every open alert, newest first, as copies. */
  list(): RaisedAlert[];
  get(id: string): RaisedAlert | null;
  raise(input: RaiseInput): RaiseResult;
  /** Close an alert; the closed one, or null when no open alert has that id. */
  dismiss(id: string): RaisedAlert | null;
  /** Drop the alerts nobody raised again for a day; how many went. */
  sweep(): number;
  /** Told of every change; returns the unsubscribe. */
  onChange(listener: (change: AlertChange) => void): () => void;
}

const copy = (a: RaisedAlert): RaisedAlert => ({ ...a });

export function createAlertStore(deps: AlertStoreDeps = {}): AlertStore {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const open = new Map<string, RaisedAlert>();
  const raisesByCentral = new Map<string, number[]>();
  const listeners = new Set<(change: AlertChange) => void>();

  function emit(change: AlertChange): void {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch (err) {
        log.warn('alerts', `Alert listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Counts this raise against the central's minute; false when the minute is full. */
  function withinRate(centralId: string, t: number): boolean {
    const recent = (raisesByCentral.get(centralId) ?? []).filter((at) => t - at < MINUTE_MS);
    if (recent.length >= RAISES_PER_MINUTE) {
      raisesByCentral.set(centralId, recent);
      return false;
    }
    recent.push(t);
    raisesByCentral.set(centralId, recent);
    // Forget centrals whose minute is long over, so the map can't grow with every central ever seen.
    for (const [id, times] of raisesByCentral) {
      if (id !== centralId && times.every((at) => t - at >= MINUTE_MS)) raisesByCentral.delete(id);
    }
    return true;
  }

  function sweep(): number {
    const t = now();
    let gone = 0;
    for (const [id, alert] of open) {
      if (t - alert.updatedAt >= RAISED_ALERT_TTL_MS) {
        open.delete(id);
        gone += 1;
      }
    }
    if (gone > 0) emit({ type: 'expired', count: gone });
    return gone;
  }

  return {
    list() {
      return [...open.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.raisedAt - a.raisedAt).map(copy);
    },

    get(id) {
      const alert = open.get(id);
      return alert ? copy(alert) : null;
    },

    raise(input) {
      const t = now();
      if (!withinRate(input.centralId, t)) {
        return { ok: false, code: 'RATE_LIMITED', error: 'Too many alerts in a minute; raise it again later' };
      }
      const existing = [...open.values()].find((a) => a.centralId === input.centralId && a.key === input.key);
      if (existing) {
        const next: RaisedAlert = {
          ...existing,
          sessionId: input.sessionId,
          centralSessionId: input.centralSessionId,
          message: input.message,
          updatedAt: t,
          count: existing.count + 1,
        };
        if (input.level === undefined) delete next.level;
        else next.level = input.level;
        open.set(existing.id, next);
        emit({ type: 'raised', alert: copy(next), created: false });
        return { ok: true, alert: copy(next), created: false };
      }
      const mine = [...open.values()].filter((a) => a.centralId === input.centralId).length;
      if (mine >= RAISED_ALERTS_PER_CENTRAL || open.size >= RAISED_ALERTS_TOTAL) {
        return { ok: false, code: 'TOO_MANY', error: 'Too many open alerts; dismiss one first' };
      }
      const alert: RaisedAlert = {
        id: newId(),
        key: input.key,
        sessionId: input.sessionId,
        centralId: input.centralId,
        centralSessionId: input.centralSessionId,
        message: input.message,
        ...(input.level === undefined ? {} : { level: input.level }),
        raisedAt: t,
        updatedAt: t,
        count: 1,
      };
      open.set(alert.id, alert);
      emit({ type: 'raised', alert: copy(alert), created: true });
      return { ok: true, alert: copy(alert), created: true };
    },

    dismiss(id) {
      const alert = open.get(id);
      if (!alert) return null;
      open.delete(id);
      emit({ type: 'dismissed', alert: copy(alert) });
      return copy(alert);
    },

    sweep,

    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The server's one store: the routes write it, the push notifier and the broadcasts follow it. */
export const alertStore: AlertStore = createAlertStore();
