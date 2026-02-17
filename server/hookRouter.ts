// hookRouter.ts — POST /api/hooks endpoint (HTTP transport adapter)
import { Router } from 'express';
import type { Request, Response } from 'express';
import { processHookEvent } from './hookProcessor.js';

const router = Router();

router.post('/', (req: Request, res: Response) => {
  const hookData = req.body;
  const result = processHookEvent(hookData, 'http');
  if (result && 'error' in result) {
    res.status(400).json({ success: false, error: result.error });
    return;
  }
  res.json({ ok: true });
});

export default router;
