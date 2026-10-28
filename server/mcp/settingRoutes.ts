// settingRoutes.ts — Settings → ADVANCED "Central sessions (MCP)" switch (Oct 28 2026, by request).
//
//   GET /api/central-sessions-setting  → { ok, enabled, nextStart }
//   PUT /api/central-sessions-setting  { enabled: boolean } → the same
//
// This Mac only: any other device is told 404, like the sharing default. The choice is saved at once and
// applies the next time AASC starts (runtime.ts), so `enabled` (this run) and `nextStart` can differ.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import log from '../logger.js';
import { isLocalRequest } from '../requestLocality.js';
import { centralSessionsSetting, setCentralSessionsEnabled } from './runtime.js';

const bodySchema = z.object({ enabled: z.boolean() });

export interface CentralSettingRouterDeps {
  isLocal?: (req: Request) => boolean;
  read?: () => { enabled: boolean; nextStart: boolean };
  save?: (on: boolean) => void;
}

export function createCentralSettingRouter(deps: CentralSettingRouterDeps = {}): Router {
  const isLocal = deps.isLocal ?? ((req: Request) => isLocalRequest(req));
  const read = deps.read ?? centralSessionsSetting;
  const save = deps.save ?? setCentralSessionsEnabled;
  const router = Router();

  router.get('/central-sessions-setting', (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    res.json({ ok: true, ...read() });
  });

  router.put('/central-sessions-setting', (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ ok: false, error: 'enabled must be true or false' }); return; }
    try {
      save(parsed.data.enabled);
    } catch (err) {
      log.error('mcp', `Saving the central-sessions setting failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ ok: false, error: 'Could not save the setting' });
      return;
    }
    log.info('mcp', `Central sessions after the next start: ${parsed.data.enabled ? 'on' : 'off'}`);
    res.json({ ok: true, ...read() });
  });

  return router;
}
