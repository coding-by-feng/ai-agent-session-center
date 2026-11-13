import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
  getTokenHostedIdentity,
  extractToken,
  parseCookieToken,
  refreshToken,
  bearerSession,
} from '../server/authManager.js';
import { isLocalRequest } from '../server/requestLocality.js';
import { authorizeHosted, currentHostedOwner } from '../server/hostedAuthority.js';
import { createHostedPairingRouter } from '../server/hostedPairing.js';
import {
  createDeviceAuth,
  proofForToken,
  type MobileDeviceRecord,
} from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { createToken, createComputerToken, createHostedToken, getTokenDeviceId } from '../server/authManager.js';

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
    accessMode: 'use',
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
    bearer?: string;
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
          ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
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
  let ownerChanged = () => {};
  access = createHostedAccess(config, () => ownerChanged());
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
  ownerChanged = () => devices.clearPairingCodes();
  app.use(createHostedPairingRouter(config, devices, () => true, access));
  app.use(
    '/api/mobile',
    createMobileRouter({
      deviceAuth: devices,
      isPasswordEnabled: () => true,
      requireSession: authMiddleware,
      createSessionToken: (deviceId) =>
        createToken(deviceId, currentHostedOwner(config) ?? undefined),
      createComputerSessionToken: (id) => createComputerToken(id, currentHostedOwner(config) ?? undefined),
      sessionOf: bearerSession,
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
  wss.on('connection', async (ws, req) => {
    if (
      !hostedSocketAllowed(config, req) ||
      !(await authorizeHosted(
        config,
        getTokenHostedIdentity(extractToken(req)) ?? currentHostedOwner(config),
      ))
    ) {
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
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('strict opt-in configuration', () => {
  it('durably binds the data directory before launch and fails closed when another order reuses it', () => {
    const otherOrder = loadHostedConfig({
      ...env,
      APP_USER_DATA: dir,
      AASC_HOSTED_ORDER_ID: '38b956f9-a9c2-46bc-ad32-005ea9253188',
    })!;
    expect(() => createHostedAccess(otherOrder)).toThrow(/order/i);
    expect(readFileSync(join(dir, 'hosted-launch', 'order'), 'utf8')).toBe(orderId);
    expect(() =>
      createHostedAccess(loadHostedConfig({ ...env, APP_USER_DATA: dir })!),
    ).not.toThrow();
  });
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
  it('rejects an owner receipt from a different order before startup and phone authority lookup', async () => {
    expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(303);
    const file = join(dir, 'hosted-launch', 'principal');
    const receipt = JSON.parse(readFileSync(file, 'utf8'));
    receipt.orderId = '38b956f9-a9c2-46bc-ad32-005ea9253188';
    writeFileSync(file, JSON.stringify(receipt));
    expect(JSON.parse(readFileSync(file, 'utf8')).orderId).toBe(receipt.orderId);
    const config = loadHostedConfig({ ...env, APP_USER_DATA: dir })!;
    expect(() => createHostedAccess(config)).toThrow(/order/i);
    expect(currentHostedOwner(config)).toBeNull();
  });
});
describe('launch exchange through real HTTP and WS sessions', () => {
  it('revokes a prior verification session immediately when an authorized use launch replaces its mode', async () => {
    const verify = await call('/hosted/launch', { ticket: ticket({ accessMode: 'verify' }) });
    expect(verify.status).toBe(303);
    const oldCookie = verify.headers['set-cookie']![0];
    expect(getTokenHostedIdentity(parseCookieToken(oldCookie))?.accessMode).toBe('verify');
    const use = await call('/hosted/launch', { ticket: ticket({ accessMode: 'use' }) });
    expect(use.status).toBe(303);
    expect(getTokenHostedIdentity(parseCookieToken(oldCookie))).toBeNull();
    expect((await call('/api/private', { cookie: oldCookie })).status).toBe(401);
    expect((await call('/api/private', { cookie: use.headers['set-cookie']![0] })).status).toBe(
      200,
    );
  });
  it('keeps verification and fulfilled use authority separate across real HTTP and WS startup', async () => {
    let phase = 'verifying';
    vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
      const { assertion } = JSON.parse(options.body as string);
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      const authorized =
        phase === 'verifying' ? claims.accessMode === 'verify' : claims.accessMode === 'use';
      return new Response(JSON.stringify({ authorized }), { status: authorized ? 200 : 403 });
    });
    expect((await call('/hosted/launch', { ticket: ticket({ accessMode: 'use' }) })).status).toBe(
      403,
    );
    const verify = await call('/hosted/launch', { ticket: ticket({ accessMode: 'verify' }) });
    expect(verify.status).toBe(303);
    const verifyCookie = verify.headers['set-cookie']![0];
    expect(getTokenHostedIdentity(parseCookieToken(verifyCookie))?.accessMode).toBe('verify');
    expect((await call('/api/private', { cookie: verifyCookie })).status).toBe(200);
    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: {
          host: 'order.example.com',
          origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
          cookie: verifyCookie,
        },
      });
      ws.once('message', (data) => {
        resolve(data.toString());
        ws.close();
      });
      ws.once('error', reject);
    });
    expect(JSON.parse(message)).toEqual({ local: false });
    phase = 'fulfilled';
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_001);
    expect((await call('/api/private', { cookie: verifyCookie })).status).toBe(401);
    const use = await call('/hosted/launch', { ticket: ticket({ accessMode: 'use' }) });
    expect(use.status).toBe(303);
    expect(
      getTokenHostedIdentity(parseCookieToken(use.headers['set-cookie']![0]))?.accessMode,
    ).toBe('use');
    expect(currentHostedOwner(loadHostedConfig({ ...env, APP_USER_DATA: dir })!)?.accessMode).toBe(
      'use',
    );
    expect((await call('/api/private', { cookie: use.headers['set-cookie']![0] })).status).toBe(
      200,
    );
    expect(
      (await call('/hosted/launch', { ticket: ticket({ accessMode: 'verify' }) })).status,
    ).toBe(403);
  });
  it('refuses a cryptographically valid launch when website authorization is disabled', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ authorized: false })));
    expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(403);
  });
  it('launches cold and warm with one stable identity, private cookie and refresh', async () => {
    const firstTicket = ticket();
    const first = await call('/hosted/launch', { ticket: firstTicket });
    expect(first.status).toBe(303);
    const { jti } = JSON.parse(Buffer.from(firstTicket.split('.')[1], 'base64url').toString());
    expect(JSON.parse(readFileSync(join(dir, 'hosted-launch', jti), 'utf8')).orderId).toBe(orderId);
    expect(JSON.parse(readFileSync(join(dir, 'hosted-launch', 'principal'), 'utf8')).orderId).toBe(
      orderId,
    );
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
    ['missing access mode', { accessMode: undefined }],
    ['invalid access mode', { accessMode: 'admin' }],
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
      ticket: ticket({ sub: 'customer:opaque', ownerEpoch: 1, accessMode: 'use' as const }),
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
      (
        await call('/hosted/launch', {
          ticket: ticket({ sub: 'customer:opaque', ownerEpoch: 0, accessMode: 'use' as const }),
        })
      ).status,
    ).toBe(403);
  });
});

describe('hosted phone browser', () => {
  it.each(['cancelled', 'disabled', 'unavailable'])(
    'denies every mounted mobile authentication/bearer route when site authority is %s',
    async (state) => {
      expect((await call('/hosted/launch', { ticket: ticket() })).status).toBe(303);
      const clock = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(clock + 20_001);
      vi.stubGlobal('fetch', async () => {
        if (state === 'unavailable') throw new Error('website unavailable');
        return new Response(JSON.stringify({ authorized: false }), { status: 403 });
      });
      for (const route of [
        'pair',
        'challenge',
        'identify',
        'session',
        'backend-code',
        'paths',
        'unpair',
      ]) {
        const result = await call(`/api/mobile/${route}`, {
          json: { deviceId: 'synthetic', nonce: 'a'.repeat(32), proof: '0'.repeat(64) },
          origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
        });
        expect(result.status, route).toBe(403);
        expect(JSON.parse(result.body).code, route).toBe('HOSTED_AUTHORITY_REQUIRED');
      }
    },
  );
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
    ).toBe(401);
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
    const phoneToken = parseCookieToken(signedIn.headers['set-cookie']![0])!;
    expect(getTokenHostedIdentity(phoneToken)?.accessMode).toBe('use');
    expect(
      (
        await call('/api/hosted/phones', {
          cookie: signedIn.headers['set-cookie']![0],
          origin: env.AASC_HOSTED_RUNTIME_ORIGIN,
        })
      ).status,
    ).toBe(403);
    const challenge = await call('/api/mobile/challenge', json({ deviceId }));
    expect(challenge.status).toBe(200);
    const { nonce } = JSON.parse(challenge.body).data;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_001);
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ authorized: false }), { status: 403 }),
    );
    for (const [route, payload] of [
      ['session', { deviceId, nonce, proof: proofForToken(deviceToken, nonce) }],
      ['backend-code', {}],
      ['paths', { nonce: 'b'.repeat(64) }],
    ] as const) {
      const denied = await call(`/api/mobile/${route}`, { ...json(payload), bearer: phoneToken });
      expect(denied.status, route).toBe(403);
      expect(JSON.parse(denied.body).code, route).toBe('HOSTED_AUTHORITY_REQUIRED');
    }
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


describe('order-panel pairing bridge', () => {
  const pairingTicket = (action = 'get', patch: Record<string, unknown> = {}) => ticket({ aud: env.AASC_HOSTED_RUNTIME_ORIGIN + '/hosted/order-pairing', pairingAction: action, ...patch });
  it('pairs an owner-authorized desktop during verification and authenticates its HTTPS session', async () => {
    const response = await call('/hosted/order-pairing', {json:{ticket:pairingTicket('get',{pairingKind:'desktop',accessMode:'verify'})}});
    expect(response.status).toBe(200);
    const data=JSON.parse(response.body);
    expect(data.kind).toBe('desktop');
    const link=new URL(data.link), fields=new URLSearchParams(link.hash.slice(1));
    expect(link.origin).toBe('https://aasc.work');
    expect(fields.get('https')).toBe(env.AASC_HOSTED_RUNTIME_ORIGIN);
    const json=(body:unknown)=>({origin:env.AASC_HOSTED_RUNTIME_ORIGIN,json:body});
    expect((await call('/api/mobile/pair',json({code:fields.get('mc'),label:'Phone',platform:'ios'}))).status).toBe(401);
    const paired=await call('/api/mobile/pair',json({code:fields.get('mc'),label:'Owner desktop',platform:'desktop'}));
    expect(paired.status).toBe(201);
    const device=JSON.parse(paired.body).data;
    expect(device.status).toBe('active');
    const challenge=JSON.parse((await call('/api/mobile/challenge',json({deviceId:device.deviceId}))).body).data;
    const session=await call('/api/mobile/session',json({deviceId:device.deviceId,nonce:challenge.nonce,proof:proofForToken(device.deviceToken,challenge.nonce)}));
    expect(session.status).toBe(200);
    const token=JSON.parse(session.body).data.token;
    expect(getTokenHostedIdentity(token)?.accessMode).toBe('verify');
    expect((await call('/api/private',{bearer:token})).status).toBe(200);
    expect((await call('/api/mobile/pair',json({code:fields.get('mc'),label:'Replay',platform:'desktop'}))).status).toBe(401);
    vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({authorized:false}),{status:403}));
    expect((await call('/hosted/order-pairing',{json:{ticket:pairingTicket('get',{pairingKind:'desktop',accessMode:'verify'})}})).status).toBe(403);
  });
  it('allows bounded issuer clock skew without accepting substantially future tickets', async () => {
    const now=Math.floor(Date.now()/1000);
    expect((await call('/hosted/order-pairing',{json:{ticket:pairingTicket('get',{iat:now+2,exp:now+60})}})).status).toBe(200);
    expect((await call('/hosted/order-pairing',{json:{ticket:pairingTicket('get',{iat:now+10,exp:now+60})}})).status).toBe(403);
  });
  it('issues and reuses a short-lived code without creating a terminal session; used code stays used', async () => {
    const first = await call('/hosted/order-pairing', { json: { ticket: pairingTicket() } });
    expect(first.status).toBe(200);
    expect(first.headers['set-cookie']).toBeUndefined();
    const pairing = JSON.parse(first.body);
    expect(pairing.kind).toBe('phone-browser');
    expect(pairing.state).toBe('active');
    expect(pairing.link).toMatch(/^https:\/\/order\.example\.com\/hosted\/pair#[A-Z2-9]{10}$/);
    const second = await call('/hosted/order-pairing', { json: { ticket: pairingTicket() } });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body).link).toBe(pairing.link);
    const paired = await call('/api/mobile/pair', { origin: env.AASC_HOSTED_RUNTIME_ORIGIN, json: { code: pairing.link.split('#')[1], label: 'Fixture phone', platform: 'ios' } });
    expect(paired.status).toBe(201);
    expect(JSON.parse(paired.body).data.status).toBe('pending');
    const used = await call('/hosted/order-pairing', { json: { ticket: pairingTicket() } });
    expect(JSON.parse(used.body).state).toBe('used');
    expect(JSON.parse(used.body).link).toBe(pairing.link);
  });
  it('regeneration invalidates previous codes and ticket replay cannot regenerate again', async () => {
    const first = JSON.parse((await call('/hosted/order-pairing', { json: { ticket: pairingTicket() } })).body);
    const proof = pairingTicket('regenerate');
    const next = await call('/hosted/order-pairing', { json: { ticket: proof } });
    expect(next.status).toBe(200);expect(JSON.parse(next.body).link).not.toBe(first.link);
    expect((await call('/hosted/order-pairing', { json: { ticket: proof } })).status).toBe(403);
    const old = await call('/api/mobile/pair', { origin: env.AASC_HOSTED_RUNTIME_ORIGIN, json: { code: first.link.split('#')[1], label: 'Old code', platform: 'ios' } });
    expect(old.status).toBe(401);
  });

  it('reports expiration without silently replacing a code and prunes expired replay receipts', async () => {
    const first = JSON.parse((await call('/hosted/order-pairing', {json:{ticket:pairingTicket()}})).body);
    const oldReceipt=join(dir,'hosted-launch',randomUUID());
    const validReceipt=join(dir,'hosted-launch',randomUUID());
    const later=Date.now()+601000;
    writeFileSync(oldReceipt,JSON.stringify({exp:Math.floor(Date.now()/1000)-1}));
    writeFileSync(validReceipt,JSON.stringify({exp:Math.floor(later/1000)+60}));
    const clock=vi.spyOn(Date,'now').mockReturnValue(later);
    try {
      const expired=JSON.parse((await call('/hosted/order-pairing',{json:{ticket:pairingTicket()}})).body);
      expect(expired.state).toBe('expired');expect(expired.link).toBe(first.link);
      expect(existsSync(oldReceipt)).toBe(false);expect(existsSync(validReceipt)).toBe(true);
      expect(existsSync(join(dir,'hosted-launch','principal'))).toBe(true);
    } finally {clock.mockRestore();}
  });
  it('owner change through launch invalidates outstanding codes before another pairing request',async()=>{
    const first=JSON.parse((await call('/hosted/order-pairing',{json:{ticket:pairingTicket()}})).body);
    expect((await call('/hosted/launch',{ticket:ticket({sub:'customer:next-owner',ownerEpoch:1})})).status).toBe(303);
    const old=await call('/api/mobile/pair',{origin:env.AASC_HOSTED_RUNTIME_ORIGIN,json:{code:first.link.split('#')[1],label:'Old owner',platform:'ios'}});
    expect(old.status).toBe(401);
  });
  it('refuses launch/pairing ticket interchange, verification mode, bad actions, extra fields and revoked authority', async () => {
    expect((await call('/hosted/order-pairing', { json: { ticket: ticket() } })).status).toBe(403);
    expect((await call('/hosted/launch', { ticket: pairingTicket() })).status).toBe(403);
    for (const proof of [pairingTicket('other'), pairingTicket('get', {accessMode:'verify'}), pairingTicket('get',{orderId:randomUUID()}), pairingTicket('get',{exp:Math.floor(Date.now()/1000)-1})])
      expect((await call('/hosted/order-pairing', {json:{ticket:proof}})).status).toBe(403);
    expect((await call('/hosted/order-pairing', {json:{ticket:pairingTicket(), extra:true}})).status).toBe(400);
    const assertion = vi.fn(async () => new Response(JSON.stringify({authorized:false}),{status:403}));vi.stubGlobal('fetch',assertion);
    expect((await call('/hosted/order-pairing', {json:{ticket:pairingTicket()}})).status).toBe(403);expect(assertion).toHaveBeenCalledOnce();
  });
});
