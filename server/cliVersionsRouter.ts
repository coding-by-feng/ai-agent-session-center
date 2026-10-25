// cliVersionsRouter.ts — the agent CLIs' versions and their one-click update (Oct 25 2026).
//
//   GET  /api/cli-versions[?refresh=1]     both CLIs: installed, latest, update state
//   POST /api/cli-versions/:cli/update     run `<cli> update` (202); 409 while one runs
//
// The update's progress is pushed as `cli_update` (cliVersions.ts). A paired phone may call both
// (phoneProfile.ts); a device that isn't this Mac starts each CLI's update at most once per
// PHONE_UPDATE_GAP_MS, so a stuck retry can't keep reinstalling the Mac's CLIs, and asks npm again
// at most once per REMOTE_REFRESH_GAP_MS (sooner, it gets the cached reading). A device is the one
// the server issued (the paired phone's id, else the sign-in's token lineage), never a header.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import log from './logger.js';
import type { CliVersionsService } from './cliVersions.js';

/** How often one remote device may start one CLI's update. */
export const PHONE_UPDATE_GAP_MS = 10 * 60_000;
/** How often one remote device may make the Mac re-read the versions (two login shells, two npm reads). */
export const REMOTE_REFRESH_GAP_MS = 30_000;
/** Remembered remote starts before old ones are swept. */
const MAX_REMEMBERED = 256;

const cliSchema = z.enum(['claude', 'codex']);

export interface CliVersionsRouterOptions {
  service: CliVersionsService;
  isLocal(req: Request): boolean;
  /** The server-issued identity of a remote caller ('' when there is none). */
  deviceKeyOf(req: Request): string;
  now?: () => number;
}

export function createCliVersionsRouter({ service, isLocal, deviceKeyOf, now = Date.now }: CliVersionsRouterOptions): Router {
  const router = Router();
  /** `<device>:<cli>` / `<device>:refresh` → when that device last did it. */
  const lastRemote = new Map<string, number>();
  const remoteKey = (req: Request, what: string) => (isLocal(req) ? null : `${deviceKeyOf(req) || 'anonymous'}:${what}`);
  const tooSoon = (key: string, gap: number) => {
    const last = lastRemote.get(key);
    return last !== undefined && now() - last < gap;
  };
  const remember = (key: string) => {
    if (lastRemote.size >= MAX_REMEMBERED) {
      for (const [k, at] of lastRemote) if (now() - at >= PHONE_UPDATE_GAP_MS) lastRemote.delete(k);
    }
    lastRemote.set(key, now());
  };

  router.get('/cli-versions', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    let refresh = req.query.refresh === '1';
    const key = refresh ? remoteKey(req, 'refresh') : null;
    if (key) {
      if (tooSoon(key, REMOTE_REFRESH_GAP_MS)) refresh = false;
      else remember(key);
    }
    try {
      res.json({ success: true, data: await service.list(refresh) });
    } catch (err) {
      log.error('cli-versions', `list failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read the CLI versions' });
    }
  });

  router.post('/cli-versions/:cli/update', (req: Request, res: Response) => {
    const parsed = cliSchema.safeParse(req.params.cli);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Unknown CLI' });
      return;
    }
    const cli = parsed.data;
    const key = remoteKey(req, cli);
    if (key && tooSoon(key, PHONE_UPDATE_GAP_MS)) {
      res.status(429).json({ success: false, error: `This device updated it recently. Try again in ${PHONE_UPDATE_GAP_MS / 60_000} minutes.` });
      return;
    }
    if (service.startUpdate(cli) === 'busy') {
      res.status(409).json({ success: false, error: 'Another update is running' });
      return;
    }
    if (key) remember(key);
    log.info('cli-versions', `${cli} update started by ${key ? 'a remote device' : 'this Mac'}`);
    res.status(202).json({ success: true, data: { cli, state: 'updating' } });
  });

  return router;
}
