// cliAuthRouter.ts — are the agent CLIs signed in on this machine, and a way to sign in (Oct 29 2026).
//
//   GET  /api/cli-auth[?refresh=1]   the enabled CLIs' sign-in state (cliAuth.ts)
//   POST /api/cli-auth/:cli/login    open a terminal on this machine running that CLI's login (201)
//
// A paired phone may call both (phoneProfile.ts): on a headless server a phone may be the only screen
// there is. The login line is fixed by the server (cliLoginTerminal.ts); nothing from the request is
// typed. A device that isn't this machine opens one CLI's login at most once per REMOTE_LOGIN_GAP_MS.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import log from './logger.js';
import type { CliAuthService } from './cliAuth.js';
import type { AgentCli } from '../src/types/cliVersions.js';

/** How often one remote device may open one CLI's login terminal. */
export const REMOTE_LOGIN_GAP_MS = 60_000;
/** Remembered remote logins before old ones are swept. */
const MAX_REMEMBERED = 256;

const cliSchema = z.enum(['claude', 'codex']);

export interface LoginRequest {
  isLocal: boolean;
  /** The dashboard that asked (`X-AASC-Client-Id`), so it holds the new terminal's control baton. */
  clientId: string;
}

export interface CliAuthRouterOptions {
  service: Pick<CliAuthService, 'check'>;
  enabledClis(): readonly AgentCli[];
  isLocal(req: Request): boolean;
  /** The server-issued identity of a remote caller ('' when there is none). */
  deviceKeyOf(req: Request): string;
  /** Opens the login terminal; an error with a `status` (e.g. 429 at capacity) is answered with it. */
  openLogin(cli: AgentCli, request: LoginRequest): Promise<{ terminalId: string }>;
  now?: () => number;
}

export function createCliAuthRouter({ service, enabledClis, isLocal, deviceKeyOf, openLogin, now = Date.now }: CliAuthRouterOptions): Router {
  const router = Router();
  const lastRemote = new Map<string, number>();

  router.get('/cli-auth', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json({ success: true, data: await service.check({ refresh: req.query.refresh === '1' }) });
    } catch (err) {
      log.error('cli-auth', `check failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read the CLI sign-in state' });
    }
  });

  router.post('/cli-auth/:cli/login', async (req: Request, res: Response) => {
    const parsed = cliSchema.safeParse(req.params.cli);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Unknown CLI' });
      return;
    }
    const cli = parsed.data;
    if (!enabledClis().includes(cli)) {
      res.status(409).json({ success: false, error: `${cli} is not enabled on this server` });
      return;
    }
    const local = isLocal(req);
    const key = local ? null : `${deviceKeyOf(req) || 'anonymous'}:${cli}`;
    const last = key ? lastRemote.get(key) : undefined;
    if (last !== undefined && now() - last < REMOTE_LOGIN_GAP_MS) {
      res.status(429).json({ success: false, error: 'A login terminal was opened from this device a moment ago. Use that one.' });
      return;
    }
    try {
      const clientId = typeof req.headers['x-aasc-client-id'] === 'string' ? req.headers['x-aasc-client-id'] : '';
      const { terminalId } = await openLogin(cli, { isLocal: local, clientId });
      if (key) {
        if (lastRemote.size >= MAX_REMEMBERED) {
          for (const [k, at] of lastRemote) if (now() - at >= REMOTE_LOGIN_GAP_MS) lastRemote.delete(k);
        }
        lastRemote.set(key, now());
      }
      log.info('cli-auth', `${cli} login terminal ${terminalId} opened by ${local ? 'this machine' : 'a remote device'}`);
      res.status(201).json({ success: true, data: { cli, terminalId } });
    } catch (err) {
      const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
      const message = err instanceof Error ? err.message : String(err);
      log.error('cli-auth', `${cli} login terminal failed: ${message}`);
      res.status(status).json({ success: false, error: status === 500 ? 'Could not open the login terminal' : message });
    }
  });

  return router;
}
