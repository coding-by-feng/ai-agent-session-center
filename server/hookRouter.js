// hookRouter.js — POST /api/hooks endpoint
import { Router } from 'express';
import { handleEvent } from './sessionStore.js';
import { broadcast } from './wsManager.js';
import log from './logger.js';

const router = Router();

router.post('/', (req, res) => {
  const hookData = req.body;
  if (!hookData || !hookData.session_id) {
    log.warn('hook', 'Received hook without session_id');
    return res.status(400).json({ error: 'Missing session_id' });
  }
  log.debug('hook', `Event: ${hookData.type || 'unknown'} session=${hookData.session_id}`);
  log.debugJson('hook', 'Hook payload', hookData);
  const delta = handleEvent(hookData);
  if (delta) {
    log.debug('hook', `Broadcasting session_update for ${hookData.session_id} status=${delta.session?.status}`);
    broadcast({ type: 'session_update', ...delta });
    if (delta.team) {
      log.debug('hook', `Broadcasting team_update for team=${delta.team.teamId}`);
      broadcast({ type: 'team_update', team: delta.team });
    }
  }
  res.json({ ok: true });
});

export default router;
