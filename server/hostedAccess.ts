import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import express from 'express';
import {
  authMiddleware,
  createHostedToken,
  extractToken,
  getTokenLineage,
  getTokenDeviceId,
  validateToken,
  revokeHostedTokens,
  TOKEN_TTL_SECONDS,
} from './authManager.js';
import { UUID, type HostedConfig } from './hostedConfig.js';
import { authorizeHosted, type HostedIdentity } from './hostedAuthority.js';

export function hostedCookie(token: string, ttl = TOKEN_TTL_SECONDS): string {
  return `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${ttl}`;
}
export function hostedSessionAllowed(config: HostedConfig, req: IncomingMessage): boolean {
  const token = extractToken(req);
  return (
    validateToken(token) &&
    (getTokenLineage(token)?.startsWith(`hosted:${config.orderId}:`) === true ||
      getTokenDeviceId(token) !== null)
  );
}
export function hostedSocketAllowed(config: HostedConfig, req: IncomingMessage): boolean {
  return (
    (req.headers.origin === undefined || req.headers.origin === config.runtimeOrigin) &&
    hostedSessionAllowed(config, req)
  );
}
/** Exclusive create + fsync, with the directory synced before the launch is accepted. */
function durableCreate(file: string, value: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(join(file, '..'), 'r');
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
export function createHostedAccess(config: HostedConfig, onOwnerChanged: () => void = () => {}) {
  const directory = join(config.dataDir, 'hosted-launch');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const principalFile = join(directory, 'principal');
  if (existsSync(principalFile)) {
    const previous = JSON.parse(readFileSync(principalFile, 'utf8'));
    if (
      previous.orderId !== config.orderId ||
      (previous.accessMode !== 'verify' && previous.accessMode !== 'use')
    )
      throw new Error('Hosted owner receipt belongs to another order or lacks an order binding');
  }
  const orderFile = join(directory, 'order');
  // Bind even before the first launch: reusing a writable data directory for a new order
  // must fail before the process opens its listener or cloud connection.
  try {
    durableCreate(orderFile, config.orderId);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      readFileSync(orderFile, 'utf8') !== config.orderId
    )
      throw new Error(
        'Hosted data directory belongs to another order or has an invalid order binding',
      );
  }
  function inspect(ticket: unknown, pairing = false) {
    if (typeof ticket !== 'string' || ticket.length > 4096) throw new Error('Invalid launch');
    const parts = ticket.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
      throw new Error('Invalid launch');
    const [head, body, signature] = parts;
    const expected = createHmac('sha256', config.launchKey).update(`${head}.${body}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('Invalid launch');
    const header = JSON.parse(Buffer.from(head, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== 'HS256' ||
      header.typ !== 'JWT' ||
      claims.iss !== config.websiteOrigin ||
      claims.aud !== config.runtimeOrigin + (pairing ? '/hosted/order-pairing' : '') ||
      (pairing && (claims.accessMode !== 'use' || !['get', 'regenerate'].includes(claims.pairingAction))) ||
      claims.orderId !== config.orderId ||
      (claims.accessMode !== 'verify' && claims.accessMode !== 'use') ||
      typeof claims.sub !== 'string' ||
      claims.sub.length < 1 ||
      claims.sub.length > 256 ||
      typeof claims.jti !== 'string' ||
      !UUID.test(claims.jti) ||
      !Number.isSafeInteger(claims.ownerEpoch) ||
      claims.ownerEpoch < 0 ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat > now ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60
    )
      throw new Error('Invalid launch');
    return claims;
  }
  function consume(ticket: unknown, pairing = false) {
    const claims = inspect(ticket, pairing);
    // Expired proofs are already rejected above. Remove only their UUID receipts,
    // preserving durable order/principal binding and malformed receipts fail-closed.
    for (const name of readdirSync(directory).filter(name => UUID.test(name)).slice(0, 512)) {
      try {
        const receipt = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        if (Number.isSafeInteger(receipt.exp) && receipt.exp <= Math.floor(Date.now() / 1000))
          unlinkSync(join(directory, name));
      } catch { /* Keep unreadable receipts; they must never allow replay. */ }
    }
    if (readFileSync(orderFile, 'utf8') !== config.orderId)
      throw new Error('Hosted order binding changed');
    const principal = createHash('sha256').update(claims.sub).digest('hex');
    // The website may claim a guest order for a customer. A signed monotonically increasing epoch
    // permits that transition without letting an unused older ticket take ownership back.
    const previous = existsSync(principalFile)
      ? (JSON.parse(readFileSync(principalFile, 'utf8')) as {
          orderId: string;
          accessMode: 'verify' | 'use';
          epoch: number;
          principal: string;
        })
      : null;
    if (
      previous &&
      (previous.orderId !== config.orderId ||
        (previous.accessMode !== 'verify' && previous.accessMode !== 'use') ||
        !Number.isSafeInteger(previous.epoch) ||
        previous.epoch < 0 ||
        !/^[0-9a-f]{64}$/.test(previous.principal))
    )
      throw new Error('Invalid durable owner record');
    if (
      previous &&
      (claims.ownerEpoch < previous.epoch ||
        (claims.ownerEpoch === previous.epoch && previous.principal !== principal))
    )
      throw new Error('Order principal mismatch');
    durableCreate(
      join(directory, claims.jti.toLowerCase()),
      JSON.stringify({ orderId: config.orderId, accessMode: claims.accessMode, exp: claims.exp }),
    );
    if (!previous)
      durableCreate(
        principalFile,
        JSON.stringify({
          orderId: config.orderId,
          epoch: claims.ownerEpoch,
          accessMode: claims.accessMode,
          principal,
          subject: claims.sub,
        }),
      );
    else if (claims.ownerEpoch > previous.epoch || claims.accessMode !== previous.accessMode) {
      const next = join(directory, `${claims.jti}.owner`);
      durableCreate(
        next,
        JSON.stringify({
          orderId: config.orderId,
          epoch: claims.ownerEpoch,
          accessMode: claims.accessMode,
          principal,
          subject: claims.sub,
        }),
      );
      renameSync(next, principalFile);
      const parent = openSync(directory, 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
      revokeHostedTokens(config.orderId);
      onOwnerChanged();
    }
    return {
      principal,
      sub: claims.sub as string,
      ownerEpoch: claims.ownerEpoch as number,
      accessMode: claims.accessMode as 'verify' | 'use',
      ...(pairing ? { pairingAction: claims.pairingAction as 'get' | 'regenerate' } : {}),
    };
  }
  const router = express.Router();
  router.get('/hosted/launch-error.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res
      .type('js')
      .send(
        `window.parent.postMessage({type:'aasc:hosted-error'},${JSON.stringify(config.websiteOrigin)});`,
      );
  });
  router.post(
    '/hosted/launch',
    express.urlencoded({ extended: false, limit: '8kb' }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const refused = () =>
        res
          .status(403)
          .type('html')
          .send(
            '<!doctype html><title>Launch refused</title><p>Launch expired or refused. Open this order again on xclaude.dev.</p><script src="/hosted/launch-error.js"></script>',
          );
      if (req.headers.origin !== config.websiteOrigin) {
        refused();
        return;
      }
      try {
        const claims = inspect(req.body?.ticket);
        if (!(await authorizeHosted(config, claims as HostedIdentity, true))) {
          refused();
          return;
        }
        const identity = consume(req.body?.ticket);
        res.setHeader(
          'Set-Cookie',
          hostedCookie(createHostedToken(config.orderId, identity.principal, identity)),
        );
        res.redirect(303, req.body?.pair === '1' ? '/?hostedPair=1' : '/');
      } catch {
        refused();
      }
    },
  );
  router.get('/api/hosted/status', authMiddleware, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!hostedSessionAllowed(config, req)) {
      res.status(401).json({ error: 'Open this order on xclaude.dev to connect.' });
      return;
    }
    res.json({
      websiteOrigin: config.websiteOrigin,
      phoneBrowser: true,
      owner: getTokenLineage(extractToken(req))?.startsWith('hosted:') === true,
    });
  });
  return { router, consume, inspectPairing: (ticket: unknown) => inspect(ticket, true), consumePairing: (ticket: unknown) => consume(ticket, true) };
}
