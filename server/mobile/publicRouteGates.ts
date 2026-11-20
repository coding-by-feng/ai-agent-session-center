// publicRouteGates.ts — the gates every public /api/mobile route passes (mobileRouter.ts, computerEnrollRouter.ts).
//
// Those routes ARE a device's authentication, so the dashboard's sign-in can't sit in front of them. Instead:
// JSON only, never from a cross-site browser page, refused while no dashboard password is set (remote access
// needs one), and closed to an address the login limiter locked out. One copy, so a new public route can't
// end up behind a weaker set than /pair and /enroll.

import type { Request, Response } from 'express';
import { REMOTE_REQUIRES_PASSWORD } from '../authManager.js';
import { rateLimitAddress } from '../requestLocality.js';

/** The login limiter (authManager checkLoginRateLimit / recordLoginAttempt / clearLoginAttempts). */
export interface LoginRateLimit {
  check(ip: string): number;
  record(ip: string): void;
  clear(ip: string): void;
}

/** The rate-limit bucket: the peer, or the proxy's X-Forwarded-For entry on a remote-only socket. */
export function clientIp(req: Request): string {
  return rateLimitAddress(req);
}

/** Public routes: JSON only, and never from a cross-site browser page. */
export function publicRequestAllowed(req: Request, res: Response): boolean {
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    res.status(403).json({ error: 'Cross-site requests are not allowed' });
    return false;
  }
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return false;
  }
  return true;
}

export interface PublicGateDeps {
  isPasswordEnabled: () => boolean;
  rateLimit: Pick<LoginRateLimit, 'check'>;
}

export function createPublicGates(deps: PublicGateDeps) {
  return {
    /** False, with the 403 sent, while no dashboard password is set. */
    passwordGate(res: Response): boolean {
      if (deps.isPasswordEnabled()) return true;
      res.status(403).json({ error: REMOTE_REQUIRES_PASSWORD, code: 'REMOTE_PASSWORD_REQUIRED' });
      return false;
    },
    /** True, with the 429 sent, for an address the login limiter locked out. */
    rateLimited(req: Request, res: Response): boolean {
      const wait = deps.rateLimit.check(clientIp(req));
      if (wait <= 0) return false;
      res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfter: wait });
      return true;
    },
  };
}

/**
 * How many account enrolls may run at once, per client address and in all (plan 17 review M4): each one may
 * wait on the cloud, and the login strike is recorded before that wait, so parallel guesses can't outrun the
 * limiter. `take` is false when the address or the whole machine is at its limit.
 */
export function createEnrollSlots(perAddress: number, total: number) {
  const byAddress = new Map<string, number>();
  let inAll = 0;
  return {
    take(ip: string): boolean {
      if ((byAddress.get(ip) ?? 0) >= perAddress || inAll >= total) return false;
      byAddress.set(ip, (byAddress.get(ip) ?? 0) + 1);
      inAll += 1;
      return true;
    },
    release(ip: string): void {
      const left = (byAddress.get(ip) ?? 1) - 1;
      if (left > 0) byAddress.set(ip, left);
      else byAddress.delete(ip);
      inAll -= 1;
    },
  };
}
