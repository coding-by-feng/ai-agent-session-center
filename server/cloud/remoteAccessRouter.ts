/**
 * @module remoteAccessRouter
 * AASC-60 (Remote access): the three calls behind RESOURCES -> Cloud -> Remote access, mounted by
 * resourceRouter.ts at `/api/resources/cloud/remote-access`, behind its local gate, and ahead of the
 * cloud routes so they work with no cloud connection at all.
 *
 *   GET  /                the view
 *   POST /refresh         look again (a fresh Tailscale status, then the publisher's check); answers the view
 *   POST /open-tailscale  launch the Tailscale app
 *
 * A read needs only the local gate. A POST also has to come from the AASC page itself and carry JSON,
 * the same two checks as the other cloud routes' writes: a cross-site <form> can send neither.
 * Every answer is `{ success, data | error: { code, message } }`, and no reason from a failed
 * launch reaches the client.
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { RemoteAccess } from './remoteAccess.js';

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ success: false, error: { code, message } });
}

/**
 * An Origin that names some other host, from a client that sent no `Sec-Fetch-Site` to say what it
 * is. A browser always sends that header, so this catches a tool pretending to be a page.
 */
function originMismatch(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin || req.get('sec-fetch-site')) return false;
  try {
    return new URL(origin).host !== req.get('host');
  } catch {
    return true;
  }
}

export function createRemoteAccessRouter(
  service: RemoteAccess,
  sameOrigin: (req: Request) => boolean,
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const writeGuard = (req: Request, res: Response, next: NextFunction): void => {
    if (!sameOrigin(req) || originMismatch(req)) {
      return fail(res, 403, 'forbidden', 'Same-origin request required');
    }
    if (!req.is('application/json')) {
      return fail(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
    }
    next();
  };

  router.get('/', async (_req, res) => {
    res.json({ success: true, data: await service.view() });
  });

  router.post('/refresh', writeGuard, async (_req, res) => {
    res.json({ success: true, data: await service.refresh() });
  });

  router.post('/open-tailscale', writeGuard, async (_req, res) => {
    const outcome = await service.openTailscale();
    if (outcome === 'opened') {
      res.json({ success: true });
    } else if (outcome === 'unsupported') {
      fail(res, 409, 'unsupported', 'Open Tailscale from your menu bar.');
    } else {
      fail(res, 502, 'open_failed', "Couldn't open the Tailscale app.");
    }
  });

  return router;
}
