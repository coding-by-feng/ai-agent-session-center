// hookRouter.js — POST /api/hooks endpoint (HTTP transport adapter)
import { Router } from 'express';
import { processHookEvent } from './hookProcessor.js';
import log from './logger.js';

const router = Router();

router.post('/', (req, res) => {
  const hookData = req.body;
  if (!hookData || !hookData.session_id) {
    log.warn('hook', 'Received hook without session_id');
    return res.status(400).json({ error: 'Missing session_id' });
  }
  processHookEvent(hookData, 'http');
  res.json({ ok: true });
});

export default router;
