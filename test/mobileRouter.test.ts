// test/mobileRouter.test.ts — AASC-15: /api/mobile over real sockets.
//
// Desktop routes must only work from the AASC page itself (loopback socket + loopback Host + same-origin),
// so a page open in the Mac's browser can't approve a phone it raced to pair, and a tunnel can't reach them.
// Phone routes must refuse cross-site browsers, non-JSON bodies and installs with no password.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter, buildPairingLink, PAIRING_LINK_BASE } from '../server/mobile/mobileRouter.js';

function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

interface Res { status: number; body: Record<string, any>; headers: http.IncomingHttpHeaders }

let server: http.Server;
let port: number;
let passwordEnabled: boolean;
let failures: Map<string, number>;
const createSessionToken = vi.fn((deviceId: string) => `session-for-${deviceId}`);
const onRevoked = vi.fn();

beforeEach(async () => {
  passwordEnabled = true;
  failures = new Map();
  createSessionToken.mockClear();
  onRevoked.mockClear();
  const deviceAuth = createDeviceAuth({ store: memoryStore(), onRevoked });
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => passwordEnabled,
    createSessionToken,
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: '100.100.1.2' }),
    rateLimit: {
      check: (ip) => ((failures.get(ip) ?? 0) >= 5 ? 900 : 0),
      record: (ip) => { failures.set(ip, (failures.get(ip) ?? 0) + 1); },
      clear: (ip) => { failures.delete(ip); },
    },
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function call(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
      headers: {
        host: `localhost:${port}`,
        ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...opts.headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {}, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function pairingCode(): Promise<string> {
  const res = await call('POST', '/pairing', { body: {} });
  expect(res.status).toBe(200);
  return res.body.data.code;
}

async function pairedPhone(): Promise<{ deviceId: string; deviceToken: string; confirmCode: string }> {
  const code = await pairingCode();
  const res = await call('POST', '/pair', { body: { code, label: 'Kason iPhone', platform: 'ios' } });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('POST /pairing (desktop)', () => {
  it('returns a code and an aasc.work link with the codes in the fragment', async () => {
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(200);
    const { code, link, backendIncluded } = res.body.data;
    expect(link.startsWith(`${PAIRING_LINK_BASE}#`)).toBe(true);
    const params = new URLSearchParams(link.split('#')[1]);
    expect(params.get('mc')).toBe(code);
    expect(params.get('lan')).toBe('192.168.1.20');
    expect(params.get('ts')).toBe('100.100.1.2');
    expect(params.get('p')).toBe('3333');
    expect(backendIncluded).toBe(false);
  });

  it('refuses when no dashboard password is set (phones are remote devices)', async () => {
    passwordEnabled = false;
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSWORD_REQUIRED');
  });

  it.each([
    ['another page on this machine (Sec-Fetch-Site: same-site)', { 'sec-fetch-site': 'same-site' }],
    ['a cross-site page', { 'sec-fetch-site': 'cross-site' }],
    ['a DNS-rebinding page (foreign Host)', { host: 'attacker.example' }],
    ['a tunnel (X-Forwarded-For)', { 'x-forwarded-for': '203.0.113.9' }],
  ])('is invisible to %s', async (_label, headers) => {
    const res = await call('POST', '/pairing', { body: {}, headers });
    expect(res.status).toBe(404);
  });
});

describe('approve / deny from the desktop', () => {
  it('approve only works from the AASC page itself', async () => {
    const phone = await pairedPhone();
    const csrf = await call('POST', `/devices/${phone.deviceId}/approve`, { headers: { 'sec-fetch-site': 'same-site' } });
    expect(csrf.status).toBe(404);
    const ok = await call('POST', `/devices/${phone.deviceId}/approve`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.device.status).toBe('active');
  });

  it('the device list shows the confirmation code while pending and never a hash', async () => {
    const phone = await pairedPhone();
    const res = await call('GET', '/devices');
    expect(res.body.data.devices[0]).toMatchObject({ id: phone.deviceId, status: 'pending', confirmCode: phone.confirmCode });
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|token_hash/);
    expect(JSON.stringify(res.body)).not.toContain(phone.deviceToken);
  });

  it('DELETE denies a pending phone and revokes an approved one', async () => {
    const a = await pairedPhone();
    expect((await call('DELETE', `/devices/${a.deviceId}`)).status).toBe(200);
    const b = await pairedPhone();
    await call('POST', `/devices/${b.deviceId}/approve`);
    expect((await call('DELETE', `/devices/${b.deviceId}`)).status).toBe(200);
    expect(onRevoked).toHaveBeenCalledTimes(2);
    const session = await call('POST', '/session', { body: { deviceId: b.deviceId, deviceToken: b.deviceToken } });
    expect(session.status).toBe(401);
    expect(session.body.code).toBe('DEVICE_REVOKED');
  });
});

describe('phone routes', () => {
  it('a pending phone is told to wait for approval; an approved one gets a session cookie', async () => {
    const phone = await pairedPhone();
    const creds = { deviceId: phone.deviceId, deviceToken: phone.deviceToken };
    const pending = await call('POST', '/session', { body: creds });
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe('DEVICE_PENDING');
    expect(createSessionToken).not.toHaveBeenCalled();

    await call('POST', `/devices/${phone.deviceId}/approve`);
    const ok = await call('POST', '/session', { body: creds });
    expect(ok.status).toBe(200);
    expect(createSessionToken).toHaveBeenCalledWith(phone.deviceId);
    expect(String(ok.headers['set-cookie'])).toContain(`auth_token=session-for-${phone.deviceId}; HttpOnly; SameSite=Strict`);
  });

  it('all phone routes refuse when no password is set', async () => {
    const phone = await pairedPhone();
    passwordEnabled = false;
    expect((await call('POST', '/pair', { body: { code: 'ABCDEFGHJK', label: 'x', platform: 'ios' } })).status).toBe(403);
    const session = await call('POST', '/session', { body: { deviceId: phone.deviceId, deviceToken: phone.deviceToken } });
    expect(session.status).toBe(403);
    expect(session.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
  });

  it('refuse cross-site browser requests and non-JSON bodies', async () => {
    const code = await pairingCode();
    const crossSite = await call('POST', '/pair', {
      body: { code, label: 'x', platform: 'ios' }, headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const textPlain = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/pair', headers: { 'content-type': 'text/plain' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end(`{"code":"${code}","label":"x","platform":"ios"}`);
    });
    expect(textPlain).toBe(415);
  });

  it('rejects unknown fields and bad platforms', async () => {
    const code = await pairingCode();
    expect((await call('POST', '/pair', { body: { code, label: 'x', platform: 'windows' } })).status).toBe(400);
    expect((await call('POST', '/pair', { body: { code, label: 'x', platform: 'ios', scopes: ['admin'] } })).status).toBe(400);
  });

  it('a wrong code counts against the rate limit, which then answers 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call('POST', '/pair', { body: { code: 'ABCDEFGHJK', label: 'x', platform: 'ios' } });
      expect(res.status).toBe(401);
    }
    const blocked = await call('POST', '/pair', { body: { code: 'ABCDEFGHJK', label: 'x', platform: 'ios' } });
    expect(blocked.status).toBe(429);
  });

  it('a phone can unpair itself with its own token', async () => {
    const phone = await pairedPhone();
    await call('POST', `/devices/${phone.deviceId}/approve`);
    expect((await call('POST', '/unpair', { body: { deviceId: phone.deviceId, deviceToken: 'w'.repeat(43) } })).status).toBe(401);
    expect((await call('POST', '/unpair', { body: { deviceId: phone.deviceId, deviceToken: phone.deviceToken } })).status).toBe(200);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('buildPairingLink', () => {
  it('adds the backend host and code when the Mac is connected to the backend', () => {
    const link = buildPairingLink({ name: 'Mac', port: 3333, lan: null, tailnet: null }, 'MACCODE234',
      { host: 'api.aasc.work', code: 'backendcode', codeRef: 'ref1' });
    const params = new URLSearchParams(link.split('#')[1]);
    expect(params.get('be')).toBe('api.aasc.work');
    expect(params.get('bc')).toBe('backendcode');
    expect(params.has('lan')).toBe(false);
    expect(link).not.toContain('ref1'); // the code reference is the Mac's own bookkeeping
  });
});
