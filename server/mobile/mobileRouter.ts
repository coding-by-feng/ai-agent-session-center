// mobileRouter.ts — /api/mobile: pair phones with this Mac (AASC-15).
//
// Two kinds of route, mounted BEFORE authMiddleware:
//
//   Desktop-only (pairing, the paired-phones list, approve, deny/revoke, and the
//   cloud phone devices not linked to a paired phone: /cloud-phones, AASC-52)
//     The same gate as RESOURCES: a loopback request on the main listener with a
//     loopback Host and, for writes, a same-origin page. A web page open in the
//     Mac's own browser reaches 127.0.0.1 too, so loopback alone would let it
//     approve a phone it raced to pair. AND a signed-in dashboard session
//     (`requireSession`, i.e. authMiddleware): pairing needs a password, and
//     "loopback" also covers curl, other accounts on this Mac and header-less
//     proxies, none of which may mint a phone.
//
//   Public (challenge, pair, session, unpair, identify) — the phone's own calls
//     They ARE the authentication, so authMiddleware can't sit in front of them.
//     JSON only, no cross-site browser requests, the login rate limiter, and all
//     refused when no dashboard password is set (remote access needs one).
//
//   Signed-in phone (backend-code, paths) — the same gates, plus the phone's
//     own session token from /session as a Bearer header (never the cookie, which
//     the dashboard page in the shell's WebView can send too): its backend code
//     for push goes to an approved phone over that session, never into the QR
//     (AASC-52), and /paths tells it this Mac's Tailscale address, proved with
//     its key (AASC-60).

import { Router, type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { isLocalResourceRequest, isSameOriginWrite } from '../resourceRouter.js';
import { REMOTE_REQUIRES_PASSWORD } from '../authManager.js';
import { TooManyPairingCodesError, toView, type DeviceAuth } from './deviceAuth.js';
import type { BackendCodeOutcome, PhoneBackendCodes } from './phoneBackendCode.js';
import type { CloudPhoneAudit } from './cloudPhoneAudit.js';
import type { PhonePathLog } from './phonePathLog.js';
import log from '../logger.js';

/** Where the QR sends the phone. The code rides in the fragment, which browsers never send to a server. */
export const PAIRING_LINK_BASE = 'https://aasc.work/pair';

export interface PairingTarget {
  name: string;
  port: number;
  lan: string | null;
  tailnet: string | null;
}

export interface MobileRouterDeps {
  deviceAuth: DeviceAuth;
  isPasswordEnabled: () => boolean;
  /**
   * Is "Pair a phone" offered (AASC-30, pairingOffer.ts)? Off: no pairing code
   * is made. Listing, approving and revoking phones paired before still work.
   * Omitted: offered.
   */
  pairingOffered?: () => boolean;
  /** Does this phone have an open socket right now (`isPhoneDeviceOnline`)? Omitted: never online. */
  isPhoneOnline?: (deviceId: string) => boolean;
  /** The dashboard's own sign-in check (authMiddleware), required on desktop routes. */
  requireSession: RequestHandler;
  /** Mint the normal one-hour session token, bound to the device. */
  createSessionToken: (deviceId: string) => string;
  sessionTtlSeconds: number;
  /**
   * Where phones find this Mac: the QR's addresses and the one `/paths` signs. May need to ask Tailscale
   * (pairingTarget.ts), so it can answer later.
   */
  pairingTarget: () => PairingTarget | Promise<PairingTarget>;
  rateLimit: {
    check(ip: string): number;
    record(ip: string): void;
    clear(ip: string): void;
  };
  /**
   * Who signed this request in, by its Bearer header only (authManager
   * bearerSession): null for no valid session, `deviceId: null` for a password
   * sign-in, else the phone. Never the cookie or `?token=`: a script in the
   * dashboard page inside the shell's WebView holds the phone's cookie, and a
   * backend code must not reach it. Omitted: nobody is signed in here.
   */
  sessionOf?: (req: Request) => { deviceId: string | null } | null;
  /** Backend codes for signed-in phones (AASC-52). Omitted: no cloud on this Mac. */
  backendCodes?: Pick<PhoneBackendCodes, 'issue'>;
  /** Backend phone devices not linked to a paired phone (AASC-52). Omitted: no cloud. */
  cloudPhones?: CloudPhoneAudit;
  /**
   * How each phone last connected (AASC-60): a successful sign-in records whether
   * it reached this Mac over the home network or Tailscale, and /paths records
   * the Tailscale address it sent. Omitted: nothing is recorded.
   */
  pathLog?: PhonePathLog;
}

const PairBody = z.object({
  code: z.string().min(4).max(32),
  label: z.string().min(1).max(200),
  platform: z.enum(['ios', 'android']),
  // Accepted for older shells and ignored: the Mac binds the backend code it
  // issues to the phone itself (deviceAuth.bindBackendCode), so a phone can't
  // name another phone's backend device for a later revoke.
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

/**
 * A paired phone looking for this Mac at a new address (its LAN rescan): its
 * key over a nonce it chose (deviceAuth WHO_TAG_PREFIX), never its id, and the
 * nonce. Hex only, so neither looks like a sign-in nonce.
 */
const IdentifyBody = z.object({
  tag: z.string().regex(/^[0-9a-f]{64}$/),
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/**
 * A signed-in phone asking for this Mac's Tailscale address (POST /paths): only the
 * nonce it chose, hex like /identify's so it never looks like a sign-in nonce. Nothing
 * else is accepted: the address and the port are this Mac's to name, never the phone's.
 */
const PathsBody = z.object({
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** This Mac's own address on the request's socket (IPv4-mapped IPv6 as plain IPv4). */
function localAddressOf(req: Request): string {
  return (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
}

/** This Mac's own `address:port` on the request's socket. */
function reachedAt(req: Request): string {
  return `${localAddressOf(req)}:${req.socket.localPort ?? ''}`;
}

/** The desktop's new name for a phone: the same 80-character cap as pairing (deviceAuth MAX_LABEL). */
const RenameBody = z.object({
  label: z.string().trim().min(1).max(80),
}).strict();

/** The session token says which phone asks; the body says nothing. */
const BackendCodeBody = z.object({}).strict();

/**
 * The QR's link: the Mac's name, addresses, port and one-time code. Never a
 * backend code (AASC-52): the phone gets that over its signed-in session.
 */
export function buildPairingLink(target: PairingTarget, macCode: string): string {
  const params = new URLSearchParams({ v: '2', name: target.name });
  if (target.lan) params.set('lan', target.lan);
  if (target.tailnet) params.set('ts', target.tailnet);
  params.set('p', String(target.port));
  params.set('mc', macCode);
  return `${PAIRING_LINK_BASE}#${params.toString()}`;
}

const NO_CLOUD = {
  error: 'This Mac isn’t connected to the AASC cloud, so it has no notifications to set up.',
  code: 'NO_CLOUD',
} as const;
const CLOUD_UNAVAILABLE = { error: 'The AASC cloud didn’t answer. Try again later.', code: 'CLOUD_UNAVAILABLE' } as const;

/** A refused backend-code request as status + body. */
function backendCodeRefusal(out: Exclude<BackendCodeOutcome, { ok: true }>): [number, Record<string, unknown>] {
  switch (out.reason) {
    case 'pending': return [403, { error: 'Approve this phone on your Mac first', code: 'DEVICE_PENDING' }];
    case 'unknown':
    case 'revoked': return [401, { error: 'This phone is no longer paired', code: out.reason === 'revoked' ? 'DEVICE_REVOKED' : 'DEVICE_UNKNOWN' }];
    case 'no-cloud': return [409, NO_CLOUD];
    case 'busy': return [409, { error: 'A backend code for this phone is already being made', code: 'BACKEND_CODE_BUSY' }];
    case 'outstanding': return [409, { error: 'This phone’s last backend code is still unused', code: 'BACKEND_CODE_OUTSTANDING', retryAfter: out.retryAfter }];
    case 'rate-limited': return [429, { error: 'Too many backend code requests from this phone. Try again later.', code: 'RATE_LIMITED', retryAfter: out.retryAfter }];
    case 'cloud-failed': return [502, CLOUD_UNAVAILABLE];
  }
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
  // then the dashboard session. The cloud phone list calls the backend, so even
  // a GET of it must come from the AASC page itself (AASC-52).
  router.use('/cloud-phones', (req, res, next) => {
    if (isSameOriginWrite(req)) next();
    else res.status(404).json({ error: 'Not found' });
  });
  router.use(['/pairing', '/devices', '/cloud-phones'], (req, res, next) => {
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

  const pairingOffered = (): boolean => deps.pairingOffered?.() ?? true;

  router.post('/pairing', async (req, res) => {
    if (!pairingOffered()) {
      res.status(409).json({
        error: 'Pairing a phone isn’t available yet: the AASC phone app hasn’t been released.',
        code: 'PAIRING_NOT_OFFERED',
      });
      return;
    }
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
    // The Mac code only: the backend code goes to the phone once it is approved
    // and signed in (POST /backend-code, AASC-52).
    const target = await deps.pairingTarget();
    res.json({
      success: true,
      data: {
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        link: buildPairingLink(target, pairing.code),
        target,
      },
    });
  });

  router.get('/devices', (_req, res) => {
    // `online` feeds the header chip's 📱 count (Oct 22 2026): a paired phone with its app closed has no socket.
    const isOnline = deps.isPhoneOnline ?? (() => false);
    const devices = deps.deviceAuth.list().map((d) => ({ ...d, online: isOnline(d.id) }));
    res.json({ success: true, data: { devices, pairingOffered: pairingOffered() } });
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

  router.patch('/devices/:id', (req, res) => {
    const parsed = RenameBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A phone name is 1 to 80 characters' });
      return;
    }
    const view = deps.deviceAuth.rename(String(req.params.id), parsed.data.label);
    if (!view) {
      res.status(404).json({ error: 'No paired phone with that id' });
      return;
    }
    res.json({ success: true, data: { device: view } });
  });

  // End a phone's sessions without unpairing it: it signs in again with its key.
  router.post('/devices/:id/sign-out', (req, res) => {
    const view = deps.deviceAuth.signOut(String(req.params.id));
    if (!view) {
      res.status(404).json({ error: 'No approved phone with that id' });
      return;
    }
    log.info('mobile', `Phone signed out: ${view.label} (${view.platform})`);
    res.json({ success: true, data: { device: view } });
  });

  // Backend phone devices this Mac made that no paired phone holds any more
  // (AASC-52): a count, and one action that revokes them.
  router.get('/cloud-phones', async (_req, res) => {
    if (!deps.cloudPhones) {
      res.json({ success: true, data: { cloud: false } });
      return;
    }
    try {
      res.json({ success: true, data: await deps.cloudPhones.count() });
    } catch {
      res.status(502).json(CLOUD_UNAVAILABLE);
    }
  });

  router.post('/cloud-phones/remove-unlinked', async (_req, res) => {
    try {
      const out = deps.cloudPhones ? await deps.cloudPhones.removeUnlinked() : { cloud: false as const };
      if (!out.cloud) {
        res.status(409).json(NO_CLOUD);
        return;
      }
      res.json({ success: true, data: { removed: out.removed, failed: out.failed } });
    } catch {
      res.status(502).json(CLOUD_UNAVAILABLE);
    }
  });

  // ── Phone ────────────────────────────────────────────────────────────────

  router.post('/pair', (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = PairBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid pairing request' });
      return;
    }
    const { code, label, platform } = parsed.data;
    const result = deps.deviceAuth.redeem({ code, label, platform });
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

  // The Mac proves it holds the phone's key (deviceAuth.macProof), over the address
  // this request reached, so a phone that found an AASC at a new address knows it's
  // this Mac, and not a box passing the question on, before it signs in there.
  // Proving costs the phone nothing, so a failure records no login strike.
  router.post('/identify', (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = IdentifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const { tag, nonce } = parsed.data;
    res.json({ success: true, data: { proof: deps.deviceAuth.macProof(tag, nonce, reachedAt(req)) } });
  });

  /**
   * R27: /paths awaits the pairing target, which awaits the Tailscale probe, and its few-second cache is usually
   * cold by the time a phone signs in. Ask as soon as the phone is in, so the /paths call a moment later joins a
   * warm (or running) lookup instead of racing the phone's own 3 s budget. Never waited for, never throws.
   */
  function warmPairingTarget(): void {
    try {
      void Promise.resolve(deps.pairingTarget()).catch(() => undefined);
    } catch {
      // /paths asks again, and answers for itself.
    }
  }

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
    // How this phone reached the Mac, for Remote access: its home network or Tailscale (AASC-60).
    deps.pathLog?.signedIn(result.device.id, localAddressOf(req));
    warmPairingTarget();
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie',
      `auth_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${deps.sessionTtlSeconds}${isSecure ? '; Secure' : ''}`);
    res.json({ success: true, data: { token, expiresIn: deps.sessionTtlSeconds, device: toView(result.device) } });
  });

  // AASC-52: an approved phone's backend code for push, over its signed-in session.
  router.post('/backend-code', async (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    if (!BackendCodeBody.safeParse(req.body).success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const session = deps.sessionOf?.(req) ?? null;
    if (!session) {
      deps.rateLimit.record(clientIp(req));
      res.status(401).json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' });
      return;
    }
    if (!session.deviceId) {
      res.status(403).json({ error: 'Only a paired phone gets a backend code', code: 'NOT_A_PHONE' });
      return;
    }
    if (!deps.backendCodes) {
      res.status(409).json(NO_CLOUD);
      return;
    }
    const out = await deps.backendCodes.issue(session.deviceId);
    if (!out.ok) {
      const [status, body] = backendCodeRefusal(out);
      res.status(status).json(body);
      return;
    }
    res.json({ success: true, data: out.code });
  });

  // AASC-60: a signed-in phone asks for this Mac's Tailscale address. The answer crosses
  // the home network's plain HTTP, so it carries a proof made with the phone's key over
  // the phone's nonce, the address (or '-') and the port (deviceAuth.pathsProof): the
  // phone saves the address only if it computes the same proof. Gates and session
  // checks are /backend-code's.
  router.post('/paths', async (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = PathsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }
    const session = deps.sessionOf?.(req) ?? null;
    if (!session) {
      deps.rateLimit.record(clientIp(req));
      res.status(401).json({ error: 'Sign in first', code: 'NOT_SIGNED_IN' });
      return;
    }
    if (!session.deviceId) {
      res.status(403).json({ error: 'Only a paired phone gets this Mac’s Tailscale address', code: 'NOT_A_PHONE' });
      return;
    }
    const { tailnet, port } = await deps.pairingTarget();
    const proof = deps.deviceAuth.pathsProof(session.deviceId, parsed.data.nonce, tailnet, port);
    if (!proof) {
      res.status(401).json({ error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
      return;
    }
    if (tailnet) deps.pathLog?.sent(session.deviceId, tailnet);
    res.json({ success: true, data: { tailnet, port, proof } });
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
