// alerts/alertsRouter.ts — the routes of the alerts centrals raise (Nov 26 2026). The alerts live in alertStore.ts.
//
//   GET  /alerts              every open alert this device may see (a remote device: shared sessions only)
//   POST /alerts              raise one (a central, over loopback: the MCP tool alert_raise); 404 from another device
//   POST /alerts/:id/dismiss  close one this device may see (the bell's ×, the MCP tool alert_dismiss)
//
// Every change is sent to each device cut for what it may see (`alerts_update`), and again on `republish` when a
// session is shared or hidden. A hidden session's alert is "not found", the same answer as one that does not exist,
// as under /sessions/:id, and another device's copy never carries a central's id. Who a central may raise an alert about (its scope, hands-off) is the tool's rule: the route
// knows the caller only as `mcp:<centralId>`. A phone reaches none of this (no /alerts route on its allow-list).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ALERT_LEVELS } from '../../src/lib/attention.js';
import { cleanAlertMessage, RAISED_ALERT_KEY_RE } from '../../src/lib/raisedAlerts.js';
import type { RaisedAlert } from '../../src/types/alert.js';
import type { AlertStore } from './alertStore.js';

/** How often alerts nobody raised again for a day are dropped. */
export const ALERT_SWEEP_MS = 10 * 60 * 1000;

const CENTRAL_CLIENT = /^mcp:(.+)$/;

/** What a session must offer the routes: its current id, and what the visibility rule reads. */
export interface AlertSessionRef {
  sessionId: string;
  remoteVisible?: boolean;
}

export interface AlertsUpdatePayload {
  type: 'alerts_update';
  alerts: RaisedAlert[];
}

export interface AlertsServiceDeps {
  store: AlertStore;
  /** Is the request from this machine? Must be `isLocalRequest`, like every other visibility gate. */
  isLocal: (req: Request) => boolean;
  /** The caller's presence id; a central's is `mcp:<centralId>` (server/mcp/client.ts). */
  clientId: (req: Request) => string;
  /** A session by any id it has gone by (aliases resolved), or null. */
  getSession: (sessionId: string) => AlertSessionRef | null;
  /** The visibility rule (`canSeeSession`). */
  canSee: (isLocal: boolean, session: AlertSessionRef) => boolean;
  /** Send this machine's copy and remote devices' cut. */
  publish: (local: AlertsUpdatePayload, remote: AlertsUpdatePayload) => Promise<void> | void;
}

export interface AlertsService {
  router: Router;
  /** Send every device its cut again: what a remote device may see changed. */
  republish: () => void;
  /** Stop the sweep timer and the store subscription (tests; a server lives as long as its process). */
  dispose: () => void;
}

const raiseSchema = z.object({
  sessionId: z.string().min(1).max(200),
  key: z.string().regex(RAISED_ALERT_KEY_RE),
  message: z.string().min(1).max(4000),
  level: z.enum(ALERT_LEVELS).optional(),
  centralSessionId: z.string().min(1).max(200).nullable().optional(),
});

export function createAlertsService(deps: AlertsServiceDeps): AlertsService {
  const router = Router();

  /** The alerts as a device may see them, under the sessions' current ids. */
  function viewFor(isLocal: boolean): RaisedAlert[] {
    const out: RaisedAlert[] = [];
    for (const alert of deps.store.list()) {
      const session = deps.getSession(alert.sessionId);
      if (!session || !deps.canSee(isLocal, session)) continue;
      const card = alert.centralSessionId ? deps.getSession(alert.centralSessionId) : null;
      out.push({
        ...alert,
        sessionId: session.sessionId,
        // Centrals are this Mac's own (their list and feeds are local-only): another device never learns one's id.
        centralId: isLocal ? alert.centralId : '',
        centralSessionId: card && deps.canSee(isLocal, card) ? card.sessionId : null,
      });
    }
    return out;
  }

  function publish(): void {
    void Promise.resolve(
      deps.publish({ type: 'alerts_update', alerts: viewFor(true) }, { type: 'alerts_update', alerts: viewFor(false) }),
    ).catch(() => { /* a failed broadcast is retried by the next change; GET /alerts on reconnect fills the gap */ });
  }

  const unsubscribe = deps.store.onChange(() => publish());
  const sweepTimer = setInterval(() => deps.store.sweep(), ALERT_SWEEP_MS);
  sweepTimer.unref?.();

  router.get('/alerts', (req: Request, res: Response) => {
    res.json({ ok: true, alerts: viewFor(deps.isLocal(req)) });
  });

  router.post('/alerts', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const centralId = CENTRAL_CLIENT.exec(deps.clientId(req))?.[1]?.trim();
    if (!centralId) {
      res.status(403).json({ ok: false, error: 'Only a central raises alerts' });
      return;
    }
    const parsed = raiseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid alert' });
      return;
    }
    const body = parsed.data;
    const message = cleanAlertMessage(body.message);
    if (!message) {
      res.status(400).json({ ok: false, error: 'Invalid alert' });
      return;
    }
    const session = deps.getSession(body.sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    const card = body.centralSessionId ? deps.getSession(body.centralSessionId) : null;
    const result = deps.store.raise({
      centralId,
      centralSessionId: card?.sessionId ?? null,
      sessionId: session.sessionId,
      key: body.key,
      message,
      ...(body.level === undefined ? {} : { level: body.level }),
    });
    if (!result.ok) {
      res.status(result.code === 'RATE_LIMITED' ? 429 : 409).json({ ok: false, error: result.error, code: result.code });
      return;
    }
    res.status(result.created ? 201 : 200).json({ ok: true, created: result.created, alert: result.alert });
  });

  router.post('/alerts/:id/dismiss', (req: Request, res: Response) => {
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    const alert = deps.store.get(id);
    const session = alert ? deps.getSession(alert.sessionId) : null;
    if (!alert || (!deps.isLocal(req) && (!session || !deps.canSee(false, session)))) {
      res.status(404).json({ ok: false, error: 'Alert not found' });
      return;
    }
    deps.store.dismiss(id);
    res.json({ ok: true });
  });

  return {
    router,
    republish: publish,
    dispose: () => {
      unsubscribe();
      clearInterval(sweepTimer);
    },
  };
}
