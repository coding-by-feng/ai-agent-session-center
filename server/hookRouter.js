// hookRouter.js — POST /api/hooks endpoint
import { Router } from 'express';
import { handleEvent } from './sessionStore.js';
import { broadcast } from './wsManager.js';

const router = Router();

router.post('/', (req, res) => {
  const hookData = req.body;
  if (!hookData || !hookData.session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }
  const delta = handleEvent(hookData);
  if (delta) {
    broadcast({ type: 'session_update', ...delta });
    // If this event created or modified a team, broadcast team update
    if (delta.team) {
      broadcast({ type: 'team_update', team: delta.team });
    }
  }
  res.json({ ok: true });
});

export default router;
