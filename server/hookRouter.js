// hookRouter.js — POST /api/hooks endpoint (HTTP transport adapter)
import { Router } from 'express';
import { processHookEvent } from './hookProcessor.js';
import log from './logger.js';

const router = Router();

router.post('/', (req, res) => {
  const hookData = req.body;
  const result = processHookEvent(hookData, 'http');
  if (result && result.error) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ ok: true });
});

export default router;
