/**
 * @module authPassword
 * POST /api/auth/password (Nov 27 2026): set or change the dashboard password from the app's own
 * devices panel. Before this a packaged app could only say "run `npm run set-password`", which needs a
 * code checkout the app doesn't have, so a computer without a password could never be reached by a
 * phone or another computer (remote access without one is refused, and nothing is published to the
 * account's directory).
 *
 * Only this computer may call it (`isLocalRequest`): a phone, a paired computer, a tunnel or the
 * remote-only listener gets 403, password or not. Changing a password also needs a signed-in session
 * (or the owner token) and the current password, which counts toward the login lockout. The hash goes
 * to server-config.json the way scripts/set-password.mjs writes it (same scrypt shape, atomic, 0600,
 * other keys kept), then into this run at once: no restart. A change ends every other password
 * sign-in and closes its sockets but keeps the caller's (rotated); a first password gives the caller a
 * session cookie, so the window that set it is never locked out of itself. A change also unpairs every
 * phone and computer at once, as a restart with a new password always has (their credentials are bound
 * to the password, `credentialEpoch`). Removing the password stays a CLI step on purpose.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  createToken,
  extractToken,
  getTokenLineage,
  hashPassword,
  isOwnerRequest,
  isPasswordEnabled,
  loginLockedMessage,
  recordLoginAttempt,
  refreshToken,
  revokePasswordSessions,
  setPasswordHash,
  TOKEN_TTL_SECONDS,
  validatePasswordComplexity,
  validateToken,
  verifyPassword,
} from './authManager.js';
import { config } from './serverConfig.js';
import { saveServerConfigKeys } from './mobile/accountEnrollSetting.js';
import log from './logger.js';

/** Long enough for any passphrase, short enough that scrypt never runs on megabytes. */
const MAX_PASSWORD_LENGTH = 256;

const bodySchema = z.object({
  current: z.string().max(MAX_PASSWORD_LENGTH).optional(),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
}).strict();

export interface PasswordRouteDeps {
  configPath: string;
  /** This computer (`isLocalRequest`): the only caller allowed. */
  isLocal: (req: Request) => boolean;
  /** A hosted (xclaude.dev) box: its access is the order's, never a password. */
  isHosted: () => boolean;
  /** The login limiter's key for this request (`rateLimitAddress`). */
  clientIp: (req: Request) => string;
  /** Close the open sockets of sessions a change ended. */
  onSessionsEnded?: (lineages: string[]) => void;
  /**
   * After the new hash is in force: what a restart would otherwise do. On a change, revoke the paired phones
   * and computers whose credentials belong to the old password (phoneRevocation.ts, the startup sweep); on
   * either, start what waits for a password (Bonjour) and let the account directory look again.
   */
  onPasswordSet?: (changed: boolean) => void;
}

function fail(res: Response, status: number, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, error, ...extra });
}

/** A cross-site page can't post here: the browser marks it, and we refuse anything but same-origin. */
function isSameOrigin(req: Request): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  return site === '' || site === 'same-origin';
}

export function createPasswordRouter(deps: PasswordRouteDeps): Router {
  const router = Router();

  router.post('/', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (deps.isHosted()) return fail(res, 403, 'This box’s access comes from its order, not a password.');
    if (!deps.isLocal(req)) return fail(res, 403, 'The dashboard password can only be set on the computer itself.', { code: 'LOCAL_ONLY' });
    if (!isSameOrigin(req)) return fail(res, 403, 'Same-origin request required');
    if (!req.is('application/json')) return fail(res, 415, 'Content-Type must be application/json');

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Send the new password (and the current one to change it).');
    const { current, password } = parsed.data;

    const changing = isPasswordEnabled();
    if (changing) {
      const token = extractToken(req);
      if (!validateToken(token) && !isOwnerRequest(req)) return fail(res, 401, 'Sign in first.');
      const ip = deps.clientIp(req);
      const locked = checkLoginRateLimit(ip);
      if (locked > 0) {
        res.setHeader('Retry-After', String(locked));
        return fail(res, 429, loginLockedMessage(locked), { retryAfter: locked });
      }
      if (!current || !verifyPassword(current, config.passwordHash ?? '')) {
        const { attemptsLeft, lockedFor } = recordLoginAttempt(ip);
        log.warn('auth', `Wrong current password when changing the dashboard password from IP ${ip}`);
        if (lockedFor > 0) {
          res.setHeader('Retry-After', String(lockedFor));
          return fail(res, 429, loginLockedMessage(lockedFor), { retryAfter: lockedFor });
        }
        return fail(res, 401, 'The current password is wrong.', { attemptsLeft });
      }
      clearLoginAttempts(ip);
    }

    const strength = validatePasswordComplexity(password);
    if (!strength.valid) return fail(res, 400, `The password needs ${strength.errors.join(', ')}.`, { requirements: strength.errors });

    const hash = hashPassword(password);
    try {
      saveServerConfigKeys(deps.configPath, { passwordHash: hash });
    } catch (err) {
      log.error('auth', `Could not save the dashboard password: ${err instanceof Error ? err.message : String(err)}`);
      return fail(res, 500, 'Couldn’t save the password. Check that AASC can write its settings folder.');
    }
    setPasswordHash(hash);

    // A change keeps the caller's own sign-in (its token rotated, same lineage, so its open socket
    // stays) and ends every other one. A first password has no sign-ins to end: the caller gets one.
    const callerToken = changing ? extractToken(req) : null;
    const callerLineage = callerToken && validateToken(callerToken) ? getTokenLineage(callerToken) : null;
    if (changing) deps.onSessionsEnded?.(revokePasswordSessions(callerLineage));
    const token = (callerLineage && refreshToken(callerToken)) || createToken();
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_SECONDS}${isSecure ? '; Secure' : ''}`);
    log.warn('auth', changing ? 'Dashboard password changed from this computer' : 'Dashboard password set from this computer');
    try {
      deps.onPasswordSet?.(changing);
    } catch (err) {
      log.error('auth', `After the password was saved: ${err instanceof Error ? err.message : String(err)}`);
    }
    res.json({ success: true, passwordEnabled: true, changed: changing, expiresIn: TOKEN_TTL_SECONDS });
  });

  return router;
}
