import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { loadHostedConfig } from '../server/hostedConfig.js';
import { createHostedAccess, hostedSocketAllowed } from '../server/hostedAccess.js';
import {
  authMiddleware,
  getTokenLineage,
  parseCookieToken,
  refreshToken,
} from '../server/authManager.js';
import { isLocalRequest } from '../server/requestLocality.js';
import { createHostedPairingRouter } from '../server/hostedPairing.js';
import {
  createDeviceAuth,
  proofForToken,
  type MobileDeviceRecord,
} from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { createToken, createHostedToken, getTokenDeviceId } from '../server/authManager.js';

const orderId = '63d17688-d822-4387-b876-9d081278849d';
const env = {
  AASC_HOSTED_ORDER_ID: orderId,
  AASC_HOSTED_WEBSITE_ORIGIN: 'https://xclaude.dev',
  AASC_HOSTED_RUNTIME_ORIGIN: 'https://order.example.com',
  AASC_HOSTED_LAUNCH_KEY: 'a'.repeat(64),
};
let dir: string;
let server: Server;
let port: number;
let access: ReturnType<typeof createHostedAccess>;
function ticket(patch: Record<string, unknown> = {}, key = env.AASC_HOSTED_LAUNCH_KEY): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://xclaude.dev',
    aud: 'https://order.example.com',
    sub: 'customer:opaque-a',
    ownerEpoch: 0,
    orderId,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...patch,
  };
  const content = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${content}.${createHmac('sha256', key).update(content).digest('base64url')}`;
}
function call(
  path: string,
  options: {
    ticket?: string;
    origin?: string;
    cookie?: string;
    method?: string;
    json?: unknown;
  } = {},
): Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const body = options.json
      ? JSON.stringify(options.json)
      : options.ticket
        ? new URLSearchParams({ ticket: options.ticket }).toString()
        : '';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? (body ? 'POST' : 'GET'),
        headers: {
          host: 'order.example.com',
          origin: options.origin ?? 'https://xclaude.dev',
          'content-type': options.json ? 'application/json' : 'application/x-www-form-urlencoded',
          ...(options.cookie ? { cookie: options.cookie } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: raw, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-hosted-'));
  vi.stubEnv('APP_USER_DATA', dir);
  vi.stubGlobal(
    'fetch',
    async () => new Response(JSON.stringify({ authorized: true }), { status: 200 }),
  );
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const config = loadHostedConfig({ ...env, APP_USER_DATA: dir })!;
  access = createHostedAccess(config);
  const app = express();
  app.use(access.router);
  app.use(express.json());
  const rows = new Map<string, MobileDeviceRecord>();
  const devices = createDeviceAuth({
    store: {
      insert: (record) => {
        rows.set(record.id, record);
      },
      get: (id) => rows.get(id) ?? null,
      update: (id, patch) => {
        Object.assign(rows.get(id)!, patch);
      },
      remove: (id) => {
        rows.delete(id);
      },
      listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked'),
    },
  });
  app.use(createHostedPairingRouter(config, devices));
  app.use(
    '/api/mobile',
    createMobileRouter({
      deviceAuth: devices,
      isPasswordEnabled: () => true,
      requireSession: authMiddleware,
      createSessionToken: createToken,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Hosted', lan: null, tailnet: null, port: 3333 }),
      rateLimit: {
        check: () => 0,
        record: () => ({ attemptsLeft: 4, lockedFor: 0 }),
        clear: () => {},
      },
    }),
  );
  app.get('/api/private', authMiddleware, (req, res) => res.json({ local: isLocalRequest(req) }));
  server = createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    if (!hostedSocketAllowed(config, req)) {
      ws.close(4001);
      return;
    }
    ws.send(JSON.stringify({ local: isLocalRequest(req) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as import('node:net').AddressInfo).port;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('strict opt-in configuration', () => {
  it('leaves native mode absent and refuses partial or insecure config', () => {
    expect(loadHostedConfig({})).toBeNull();
    for (const bad of [
      { AASC_HOSTED_ORDER_ID: orderId },
      { ...env, AASC_HOSTED_RUNTIME_ORIGIN: 'http://order.example.com' },
      { ...env, AASC_HOSTED_WEBSITE_ORIGIN: 'https://xclaude.dev/path' },
      { ...env, AASC_HOSTED_LAUNCH_KEY: 'short' },
      { ...env, AASC_HOSTED_ORDER_ID: 'other' },
      env,
    ]) {
      expect(() => loadHostedConfig(bad)).toThrow();
    }
  });
});
describe('launch exchange through real HTTP and WS sessions', () => {
  it('refuses a cryptographically valid launch when website authorization is disabled', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ authorized: false })));
    expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(403);
  });
  it('launches cold and warm with one stable identity, private cookie and refresh', async () => {
    const first = await call('/hosted/launch', { ticket: ticket() });
    expect(first.status).toBe(303);
    const cookie = first.headers['set-cookie']![0];
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=None/);
    expect(cookie).not.toContain('Domain=');
    const token = parseCookieToken(cookie)!;
    expect(getTokenLineage(token)).toMatch(/^hosted:/);
    const warm = await call('/hosted/launch', { ticket: ticket(), cookie });
    expect(warm.status).toBe(303);
    expect(getTokenLineage(parseCookieToken(warm.headers['set-cookie']![0]))).toBe(
      getTokenLineage(token),
    );
    expect(getTokenLineage(refreshToken(token))).toBe(
      getTokenLineage(parseCookieToken(warm.headers['set-cookie']![0])),
    );
    const authenticated = await call('/api/private', {
      cookie: warm.headers['set-cookie']![0],
      origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
    });
    expect(authenticated.status).toBe(200);
    expect(JSON.parse(authenticated.body).local).toBe(false);
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: {
          host: 'order.example.com',
          origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
          cookie: warm.headers['set-cookie']![0],
        },
      });
      ws.on('message', (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(JSON.parse(message)).toEqual({ local: false });
    expect((await call('/api/private')).status).toBe(401);
  });
  it.each([
    ['expired', { exp: 1 }],
    ['future', { iat: 9999999999, exp: 10000000059 }],
    ['wrong order', { orderId: randomUUID() }],
    ['wrong issuer', { iss: 'https://evil.example' }],
    ['wrong audience', { aud: 'https://other.example.com' }],
    ['missing subject', { sub: '' }],
    ['bad nonce', { jti: 'nonce' }],
    ['long lifetime', { exp: Math.floor(Date.now() / 1000) + 3600 }],
  ])('rejects %s', async (_name, patch) => {
    expect((await call('/hosted/launch', { ticket: ticket(patch) })).status).toBe(403);
  });
  it('rejects wrong form origin, forged signature and replay after rebuilding the access service', async () => {
    const token = ticket();
    expect(
      (await call('/hosted/launch', { ticket: token, origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await call('/hosted/launch', { ticket: ticket({}, 'b'.repeat(64)) })).status).toBe(403);
    expect((await call('/hosted/launch', { ticket: token })).status).toBe(303);
    expect((await call('/hosted/launch', { ticket: token })).status).toBe(403);
    const reopened = createHostedAccess(loadHostedConfig({ ...env, APP_USER_DATA: dir })!);
    expect(() => reopened.consume(token)).toThrow();
  });
  it('pins the order principal durably and refuses another account without consuming its session', async () => {
    expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(303);
    const reopened = createHostedAccess(loadHostedConfig({ ...env, APP_USER_DATA: dir })!);
    expect(() => reopened.consume(ticket({ sub: 'customer:other' }))).toThrow();
    expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(303);
  });
  it('allows a signed owner-epoch advance, revokes the old owner, and rejects rollback', async () => {
    const guestTicket = ticket({ sub: 'guest:opaque' });
    const old = await call('/hosted/launch', { ticket: guestTicket });
    expect(old.status).toBe(303);
    const claimed = await call('/hosted/launch', {
      ticket: ticket({ sub: 'customer:opaque', ownerEpoch: 1 }),
    });
    expect(claimed.status).toBe(303);
    expect((await call('/api/private', { cookie: old.headers['set-cookie']![0] })).status).toBe(
      401,
    );
    expect((await call('/api/private', { cookie: claimed.headers['set-cookie']![0] })).status).toBe(
      200,
    );
    expect((await call('/hosted/launch', { ticket: ticket({ sub: 'guest:opaque' }) })).status).toBe(
      403,
    );
    expect(
      (await call('/hosted/launch', { ticket: ticket({ sub: 'customer:opaque', ownerEpoch: 0 }) }))
        .status,
    ).toBe(403);
  });
});

describe('hosted phone browser', () => {
  it('never grants localhost privileges to a hosted session when a proxy rewrites Host', async () => {
    const result = await call('/hosted/launch', { ticket: ticket() });
    expect(
      isLocalRequest({
        headers: { host: 'localhost:3333', cookie: result.headers['set-cookie']![0] },
        socket: { remoteAddress: '127.0.0.1' },
      }),
    ).toBe(false);
  });
  it('pairs once, requires owner approval and key proof, and keeps the phone restricted', async () => {
    const owner = (await call('/hosted/launch', { ticket: ticket() })).headers['set-cookie']![0];
    const json = (body: unknown, cookie?: string) => ({
      json: body,
      cookie,
      origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
    });
    expect((await call('/api/hosted/phones/pairing', json({}))).status).toBe(401);
    expect(
      (
        await call('/api/hosted/phones/pairing', {
          ...json({}, owner),
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    const pairing = await call('/api/hosted/phones/pairing', json({}, owner));
    expect(pairing.status).toBe(200);
    const { code, link } = JSON.parse(pairing.body);
    expect(link).toBe(`https://order.example.com/hosted/pair#${code}`);
    expect(
      (await call('/api/mobile/pair', json({ code, label: 'Computer', platform: 'desktop' })))
        .status,
    ).toBe(400);
    const paired = await call(
      '/api/mobile/pair',
      json({ code, label: 'My phone', platform: 'ios' }),
    );
    expect(paired.status).toBe(201);
    const { deviceId, deviceToken, confirmCode } = JSON.parse(paired.body).data;
    expect(
      (await call('/api/mobile/pair', json({ code, label: 'Other', platform: 'ios' }))).status,
    ).toBe(401);
    async function signIn(proofOverride?: string) {
      const { nonce } = JSON.parse(
        (await call('/api/mobile/challenge', json({ deviceId }))).body,
      ).data;
      return call(
        '/api/mobile/session',
        json({ deviceId, nonce, proof: proofOverride ?? proofForToken(deviceToken, nonce) }),
      );
    }
    expect((await signIn()).status).toBe(403);
    expect(
      JSON.parse(
        (
          await call('/api/hosted/phones', {
            cookie: owner,
            origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
          })
        ).body,
      ).devices[0].confirmCode,
    ).toBe(confirmCode);
    expect((await call(`/api/hosted/phones/${deviceId}/approve`, json({}, owner))).status).toBe(
      200,
    );
    expect((await signIn('0'.repeat(64))).status).toBe(401);
    const signedIn = await signIn();
    expect(signedIn.status).toBe(200);
    expect(getTokenDeviceId(parseCookieToken(signedIn.headers['set-cookie']![0]))).toBe(deviceId);
    expect(
      (
        await call('/api/hosted/phones', {
          cookie: signedIn.headers['set-cookie']![0],
          origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
        })
      ).status,
    ).toBe(403);
  });
  it('rejects another order token and a generic password token on hosted HTTP and WS', async () => {
    for (const token of [createHostedToken(randomUUID(), 'other'), createToken()]) {
      const cookie = `auth_token=${token}`;
      expect((await call('/api/private', { cookie })).status).toBe(401);
      const code = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { origin: env.AASC_HOSTED_RUNTIME_ORIGIN, host: 'order.example.com', cookie },
        });
        ws.once('close', resolve);
        ws.once('error', reject);
      });
      expect(code).toBe(4001);
    }
  });
});
