// mobileRouter.ts — /api/mobile: pair phones with this Mac (AASC-15).
//
// Two kinds of route, mounted BEFORE authMiddleware:
//
//   Desktop-only (pairing, the paired-phones list, approve, deny/revoke)
//     The same gate as RESOURCES: a loopback request on the main listener with a
//     loopback Host and, for writes, a same-origin page. A web page open in the
//     Mac's own browser reaches 127.0.0.1 too, so loopback alone would let it
//     approve a phone it raced to pair. AND a signed-in dashboard session
//     (`requireSession`, i.e. authMiddleware): pairing needs a password, and
//     "loopback" also covers curl, other accounts on this Mac and header-less
//     proxies, none of which may mint a phone.
//
//   Public (challenge, pair, session, unpair) — the phone's own calls
//     They ARE the authentication, so authMiddleware can't sit in front of them.
//     JSON only, no cross-site browser requests, the login rate limiter, and all
//     refused when no dashboard password is set (remote access needs one).

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { isLocalResourceRequest, isSameOriginWrite } from '../resourceRouter.js';
import { REMOTE_REQUIRES_PASSWORD } from '../authManager.js';
import { TooManyPairingCodesError, toView, type DeviceAuth } from './deviceAuth.js';
import log from '../logger.js';

/** Where the QR sends the phone. The codes ride in the fragment, which browsers never send to a server. */
export const PAIRING_LINK_BASE = 'https://aasc.work/pair';

export interface PairingTarget {
  name: string;
  port: number;
  lan: string | null;
  tailnet: string | null;
}

export interface BackendPhoneCode {
  /** Backend host, e.g. api.aasc.work (bare host, https implied). */
  host: string;
  code: string;
  codeRef: string;
  /**
   * This Mac's own backend device id. Every notification the Mac asks the
   * backend to send carries it, so a phone paired with several Macs knows
   * which one a tap belongs to.
   */
  macDeviceId?: string;
}

export interface MobileRouterDeps {
  deviceAuth: DeviceAuth;
  isPasswordEnabled: () => boolean;
  /** The dashboard's own sign-in check (authMiddleware), required on desktop routes. */
  requireSession: RequestHandler;
  /** Mint the normal one-hour session token, bound to the device. */
  createSessionToken: (deviceId: string) => string;
  sessionTtlSeconds: number;
  pairingTarget: () => PairingTarget;
  rateLimit: {
    check(ip: string): number;
    record(ip: string): void;
    clear(ip: string): void;
  };
  /**
   * A phone-scoped backend pairing code, when the Mac is connected to the AASC
   * backend (cloud connector). Absent or null: the QR carries the Mac code only.
   */
  mintBackendCode?: () => Promise<BackendPhoneCode | null>;
}

const PairBody = z.object({
  code: z.string().min(4).max(32),
  label: z.string().min(1).max(200),
  platform: z.enum(['ios', 'android']),
  beCodeRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
}).strict();

const ChallengeBody = z.object({
  deviceId: z.string().uuid(),
}).strict();

/** Proof of the device token: HMAC-SHA256(SHA-256(token), nonce), hex. The token itself never travels. */
const DeviceProof = z.object({
  deviceId: z.string().uuid(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export function buildPairingLink(target: PairingTarget, macCode: string, backend: BackendPhoneCode | null): string {
  const params = new URLSearchParams({ v: '2', name: target.name });
  if (target.lan) params.set('lan', target.lan);
  if (target.tailnet) params.set('ts', target.tailnet);
  params.set('p', String(target.port));
  params.set('mc', macCode);
  if (backend) {
    params.set('be', backend.host);
    params.set('bc', backend.code);
    if (backend.macDeviceId && /^[A-Za-z0-9_-]{1,64}$/.test(backend.macDeviceId)) params.set('md', backend.macDeviceId);
  }
  return `${PAIRING_LINK_BASE}#${params.toString()}`;
}

function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Public routes: JSON only, and never from a cross-site browser page. */
function publicRequestAllowed(req: Request, res: Response): boolean {
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

export function createMobileRouter(deps: MobileRouterDeps): Router {
  const router = Router();

  // Desktop routes: the local gate first (404, so other devices learn nothing),
  // then the dashboard session.
  router.use(['/pairing', '/devices'], (req, res, next) => {
    const local = req.method === 'GET'
      ? isLocalResourceRequest(req)
      : isLocalResourceRequest(req) && isSameOriginWrite(req);
    if (!local) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    deps.requireSession(req, res, next);
  });

  function passwordGate(res: Response): boolean {
    if (deps.isPasswordEnabled()) return true;
    res.status(403).json({ error: REMOTE_REQUIRES_PASSWORD, code: 'REMOTE_PASSWORD_REQUIRED' });
    return false;
  }

  function rateLimited(req: Request, res: Response): boolean {
    const wait = deps.rateLimit.check(clientIp(req));
    if (wait <= 0) return false;
    res.status(429).json({ error: 'Too many attempts. Try again later.', retryAfter: wait });
    return true;
  }

  // ── Desktop ──────────────────────────────────────────────────────────────

  router.post('/pairing', async (req, res) => {
    if (!deps.isPasswordEnabled()) {
      res.status(409).json({
        error: 'Set a dashboard password first: phones are remote devices, and remote access needs one.',
        code: 'PASSWORD_REQUIRED',
      });
      return;
    }
    let pairing: { code: string; expiresAt: number };
    try {
      pairing = deps.deviceAuth.createPairingCode();
    } catch (err) {
      if (err instanceof TooManyPairingCodesError) {
        res.status(429).json({ error: err.message });
        return;
      }
      throw err;
    }
    let backend: BackendPhoneCode | null = null;
    try {
      backend = (await deps.mintBackendCode?.()) ?? null;
    } catch (err) {
      // Pairing with the Mac still works; push needs the backend and can be added by re-pairing later.
      log.warn('mobile', `Backend phone code unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const target = deps.pairingTarget();
    res.json({
      success: true,
      data: {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        link: buildPairingLink(target, pairing.code, backend),
        backendIncluded: backend !== null,
        target,
      },
    });
  });

  router.get('/devices', (_req, res) => {
    res.json({ success: true, data: { devices: deps.deviceAuth.list() } });
  });

  router.post('/devices/:id/approve', (req, res) => {
    const view = deps.deviceAuth.approve(String(req.params.id));
    if (!view) {
      res.status(404).json({ error: 'No pending phone with that id' });
      return;
    }
    log.info('mobile', `Phone approved: ${view.label} (${view.platform})`);
    res.json({ success: true, data: { device: view } });
  });

  router.delete('/devices/:id', (req, res) => {
    const id = String(req.params.id);
    const ok = deps.deviceAuth.deny(id) || deps.deviceAuth.revoke(id);
    if (!ok) {
      res.status(404).json({ error: 'No paired phone with that id' });
      return;
    }
    res.json({ success: true });
  });

  // ── Phone ────────────────────────────────────────────────────────────────

  router.post('/pair', (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = PairBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid pairing request' });
      return;
    }
    const result = deps.deviceAuth.redeem(parsed.data);
    if (!result) {
      deps.rateLimit.record(clientIp(req));
      res.status(401).json({ error: 'Pairing code is wrong or expired', code: 'INVALID_PAIRING_CODE' });
      return;
    }
    log.info('mobile', `Phone paired, waiting for approval: ${result.device.label} (${result.device.platform})`);
    res.status(201).json({
      success: true,
      data: {
        deviceId: result.device.id,
        deviceToken: result.deviceToken,
        confirmCode: result.device.confirmCode,
        status: 'pending',
      },
    });
  });

  router.post('/challenge', (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = ChallengeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    res.json({ success: true, data: deps.deviceAuth.createChallenge(parsed.data.deviceId) });
  });

  router.post('/session', (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = DeviceProof.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { deviceId, nonce, proof } = parsed.data;
    const result = deps.deviceAuth.exchange(deviceId, nonce, proof);
    if (!result.ok) {
      if (result.reason === 'pending') {
        res.status(403).json({ error: 'Approve this phone on your Mac first', code: 'DEVICE_PENDING' });
        return;
      }
      if (result.reason === 'invalid') deps.rateLimit.record(clientIp(req));
      res.status(401).json({
        error: 'This phone is no longer paired',
        code: result.reason === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_UNKNOWN',
      });
      return;
    }
    const token = deps.createSessionToken(result.device.id);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${deps.sessionTtlSeconds}${isSecure ? '; Secure' : ''}`);
    res.json({ success: true, data: { token, expiresIn: deps.sessionTtlSeconds, device: toView(result.device) } });
  });

  router.post('/unpair', (req, res) => {
    if (!publicRequestAllowed(req, res) || rateLimited(req, res)) return;
    const parsed = DeviceProof.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    if (!deps.deviceAuth.unpair(parsed.data.deviceId, parsed.data.nonce, parsed.data.proof)) {
      deps.rateLimit.record(clientIp(req));
      res.status(401).json({ error: 'This phone is not paired', code: 'DEVICE_UNKNOWN' });
      return;
    }
    res.json({ success: true });
  });

  return router;
}
