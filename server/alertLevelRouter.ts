// alertLevelRouter.ts — alert levels over the API (Nov 25 2026). Mounted by apiRouter behind `requireVisibleSession`, so a
// remote device writes only a session it may see, and a paired phone reaches only the older Mute and Alert routes
// (phoneProfile.ts lists those for it).
//
//   GET  /alert-levels               the level table (src/lib/attention.ts AlertConfig)
//   PUT  /alert-levels               replace it: a whole table or 400. This Mac only (another device: 404, as
//                                    `requireLocalOnly` answers): the table decides the alerts of sessions hidden
//                                    from that device too, like the Mac's other settings (`/config/keep-awake`).
//   PUT  /sessions/:id/alert-level   { level: 'silent' | … | 'urgent' | null } — null: follow the room and the default
//   PUT  /sessions/:id/muted         the older switch, as a level (levelAfterMute)
//   PUT  /sessions/:id/alerted       the older switch, as a level (levelAfterAlert)
//
// The older routes still answer `{ ok: true }` for a session the server does not have, as they always did.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  ALERT_LEVELS,
  levelAfterAlert,
  levelAfterMute,
  ownAlertLevel,
  readAlertConfigBody,
  type AlertLevel,
} from '../src/lib/attention.js';
import type { Room } from '../src/types/room.js';
import type { Session } from '../src/types/session.js';
import { followedAlertLevel, getAlertConfig, setAlertConfig } from './alertConfig.js';
import log from './logger.js';
import { roomsViewFor } from './roomsMirror.js';

export interface AlertLevelRouterDeps {
  getSession(sessionId: string): Session | null | undefined;
  /** Sets (or with null clears) a session's own level, keeps the older switches in step and tells every window. */
  setSessionAlertLevel(sessionId: string, level: AlertLevel | null): Session | null;
  /**
   * The Mac's rooms as its window last sent them (the room mirror), for the level a session follows. They can still
   * name a session by its id from before a re-key; the router reads them under current ids.
   */
  rooms(): readonly Room[];
  /** Is the request from this Mac? Must be `isLocalRequest`, like every other "is this the Mac?" gate. */
  isLocal(req: Request): boolean;
}

const levelBodySchema = z.object({ level: z.enum(ALERT_LEVELS).nullable() });
const mutedBodySchema = z.object({ muted: z.boolean() });
const alertedBodySchema = z.object({ alerted: z.boolean() });

const idOf = (req: Request): string => {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] ?? '' : raw ?? '';
};

function badBody(res: Response, error: string): void {
  res.status(400).json({ ok: false, error });
}

export function createAlertLevelRouter(deps: AlertLevelRouterDeps): Router {
  const router = Router();

  router.get('/alert-levels', (_req, res) => {
    res.json({ ok: true, config: getAlertConfig() });
  });

  router.put('/alert-levels', (req, res) => {
    if (!deps.isLocal(req)) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    const config = readAlertConfigBody(req.body);
    if (!config) {
      badBody(res, 'Send the whole alert level table');
      return;
    }
    try {
      setAlertConfig(config);
    } catch (err) {
      log.error('api', `Saving the alert levels failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ ok: false, error: 'Could not save the alert levels' });
      return;
    }
    log.info('api', `Alert levels saved (default ${config.defaultLevel})`);
    res.json({ ok: true, config });
  });

  router.put('/sessions/:id/alert-level', (req, res) => {
    const body = levelBodySchema.safeParse(req.body);
    if (!body.success) {
      badBody(res, `level must be one of ${ALERT_LEVELS.join(', ')}, or null`);
      return;
    }
    const updated = deps.setSessionAlertLevel(idOf(req), body.data.level);
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    res.json({ ok: true, alertLevel: updated.alertLevel ?? null });
  });

  /** An older switch: the level it asks for, given the session's own level and the one it follows. */
  function applySwitch(id: string, next: (own: AlertLevel | undefined, followed: AlertLevel) => AlertLevel | null | undefined): void {
    const session = deps.getSession(id);
    if (!session) return;
    // Under current ids, as currentRooms() reads them for a push: read raw, a session its room lists by an older id
    // followed no room, and Mute off left it Silent by the room (Nov 25 2026).
    const rooms = roomsViewFor(deps.rooms(), true, (sessionId) => deps.getSession(sessionId) ?? null);
    const level = next(ownAlertLevel(session), followedAlertLevel(session.sessionId, rooms));
    if (level !== undefined) deps.setSessionAlertLevel(session.sessionId, level);
  }

  router.put('/sessions/:id/muted', (req, res) => {
    const body = mutedBodySchema.safeParse(req.body);
    if (!body.success) {
      badBody(res, 'muted must be true or false');
      return;
    }
    applySwitch(idOf(req), (own, followed) => levelAfterMute(own, followed, body.data.muted));
    res.json({ ok: true });
  });

  router.put('/sessions/:id/alerted', (req, res) => {
    const body = alertedBodySchema.safeParse(req.body);
    if (!body.success) {
      badBody(res, 'alerted must be true or false');
      return;
    }
    applySwitch(idOf(req), (own, followed) => levelAfterAlert(own, followed, body.data.alerted));
    res.json({ ok: true });
  });

  return router;
}
