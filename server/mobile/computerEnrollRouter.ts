// computerEnrollRouter.ts — POST /api/mobile/enroll-computer (plan 18, stage 2).
//
// A computer signed into this machine's AASC Cloud account connects without a pairing link
// (computerEnroll.ts). Mounted at /api/mobile right after the mobile router (before authMiddleware: this call
// IS the computer's authentication), so it passes everything that prefix passes, and behind the same gates as
// a phone's POST /enroll (publicRouteGates.ts): JSON only, never cross-site, refused without a dashboard
// password, closed to a locked-out address, one enroll at a time per address and three in all, and a login
// strike recorded before the backend is asked, cleared on success.
//
// The body names the machine, the ticket, the client's key and its nonce, and nothing else: the record's name
// is the backend's, its kind is always a computer, and the address the answer is bound to is this machine's to
// say (boundAddress.ts), never a field here.

import { Router } from 'express';
import { z } from 'zod';
import { MACHINE_KEY_RE, MACHINE_TICKET_RE } from '../cloud/machines.js';
import { boundAddressOf, type PublishedAddresses } from './boundAddress.js';
import type { ComputerEnroll, ComputerEnrollRefusal } from './computerEnroll.js';
import { MAX_ENROLLS_PER_IP, MAX_ENROLLS_TOTAL } from './mobileRouter.js';
import {
  clientIp, createEnrollSlots, createPublicGates, publicRequestAllowed, type LoginRateLimit,
} from './publicRouteGates.js';

/** Seconds a client is told to wait when another enroll holds its slot. */
const ENROLL_BUSY_RETRY_S = 5;
/** Seconds to wait when too many account devices still wait here (deviceAuth PROVISIONAL_ACCOUNT_TTL_MS). */
const WAITING_BUSY_RETRY_S = 120;

export interface ComputerEnrollRouterDeps {
  isPasswordEnabled: () => boolean;
  /** The login limiter, the one the mobile router uses. */
  rateLimit: LoginRateLimit;
  /** Omitted: account computers are off on this server. */
  computerEnroll?: Pick<ComputerEnroll, 'enroll'>;
  /** The public and Tailscale addresses this machine publishes, which a Host may name (boundAddress.ts). Omitted: none. */
  publishedAddresses?: () => Promise<PublishedAddresses | null>;
}

/** All base64url is unpadded: a ticket is 32 bytes, a client key a 65-byte point. UUIDs are lower-case. */
const EnrollComputerBody = z.object({
  machineId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  ticket: z.string().regex(MACHINE_TICKET_RE),
  clientKey: z.string().regex(MACHINE_KEY_RE),
  nonce: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const ACCOUNT_ENROLL_OFF = {
  error: 'This computer doesn’t let your account’s computers connect. Pair with a link instead.',
  code: 'ACCOUNT_ENROLL_OFF',
} as const;

/** A refused enroll as status + body. */
function refusal(reason: ComputerEnrollRefusal): [number, Record<string, unknown>] {
  switch (reason) {
    case 'off': return [403, ACCOUNT_ENROLL_OFF];
    case 'not-this-machine': return [409, { error: 'This isn’t the computer the ticket names', code: 'NOT_THIS_MACHINE' }];
    case 'invalid':
    case 'expired':
    case 'used': return [401, { error: 'The access ticket is wrong, used or expired. Try again.', code: 'INVALID_TICKET' }];
    case 'client-revoked': return [401, {
      error: 'This computer was removed. Sign in to AASC Cloud on it again, then connect.',
      code: 'CLIENT_REVOKED',
    }];
    case 'cloud-failed': return [502, { error: 'The AASC cloud didn’t answer. Try again later.', code: 'CLOUD_UNAVAILABLE' }];
    case 'busy': return [429, {
      error: 'Too many new devices are still connecting to this computer. Try again in a few minutes.',
      code: 'BUSY',
      retryAfter: WAITING_BUSY_RETRY_S,
    }];
  }
}

export function createComputerEnrollRouter(deps: ComputerEnrollRouterDeps): Router {
  const router = Router();
  const { passwordGate, rateLimited } = createPublicGates(deps);
  const slots = createEnrollSlots(MAX_ENROLLS_PER_IP, MAX_ENROLLS_TOTAL);

  router.post('/enroll-computer', async (req, res) => {
    if (!publicRequestAllowed(req, res) || !passwordGate(res) || rateLimited(req, res)) return;
    const parsed = EnrollComputerBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid enroll request' });
      return;
    }
    if (!deps.computerEnroll) {
      res.status(403).json(ACCOUNT_ENROLL_OFF);
      return;
    }
    const ip = clientIp(req);
    // The address this answer names: this machine's to say, before anything is spent.
    const bound = await boundAddressOf(req, deps.publishedAddresses);
    if (!slots.take(ip)) {
      res.status(429).json({ error: 'Another device is connecting. Try again in a moment.', code: 'ENROLL_BUSY', retryAfter: ENROLL_BUSY_RETRY_S });
      return;
    }
    let out: Awaited<ReturnType<typeof deps.computerEnroll.enroll>>;
    try {
      out = await deps.computerEnroll.enroll(
        { ...parsed.data, boundAddress: bound },
        { beforeRedeem: () => deps.rateLimit.record(ip) },
      );
    } finally {
      slots.release(ip);
    }
    if (!out.ok) {
      const [status, body] = refusal(out.reason);
      res.status(status).json(body);
      return;
    }
    deps.rateLimit.clear(ip);
    res.status(201).json({ success: true, data: out.answer });
  });

  return router;
}
