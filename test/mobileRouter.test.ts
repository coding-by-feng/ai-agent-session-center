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

import { createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter, buildPairingLink, PAIRING_LINK_BASE, type PairingTarget } from '../server/mobile/mobileRouter.js';

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
let signedIn: boolean;
let offered: boolean;
let failures: Map<string, number>;
/** What this Mac names for pairing; a promise stands for one that has to ask Tailscale first (AASC-60). */
let pairingTarget: () => PairingTarget | Promise<PairingTarget>;
/** Phone ids with an open socket, for GET /devices' `online` (Oct 22 2026). */
let onlinePhones: Set<string>;
const createSessionToken = vi.fn((deviceId: string) => `session-for-${deviceId}`);
const createComputerSessionToken = vi.fn((deviceId: string) => `computer-session-for-${deviceId}`);
const onRevoked = vi.fn();
const onSignedOut = vi.fn();

beforeEach(async () => {
  passwordEnabled = true;
  signedIn = true;
  offered = true;
  failures = new Map();
  pairingTarget = () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: '100.100.1.2' });
  onlinePhones = new Set();
  createSessionToken.mockClear();
  createComputerSessionToken.mockClear();
  onRevoked.mockClear();
  onSignedOut.mockClear();
  const deviceAuth = createDeviceAuth({ store: memoryStore(), onRevoked, onSignedOut });
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => passwordEnabled,
    pairingOffered: () => offered,
    isPhoneOnline: (id) => onlinePhones.has(id),
    // Stands in for authMiddleware: the desktop page holds a dashboard session.
    requireSession: (_req, res, next) => (signedIn ? next() : res.status(401).json({ error: 'Unauthorized' })),
    createSessionToken,
    createComputerSessionToken,
    sessionTtlSeconds: 3600,
    pairingTarget: () => pairingTarget(),
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

/** The phone's sign-in over HTTP: challenge, then the HMAC proof. */
async function signIn(deviceId: string, deviceToken: string, path = '/session'): Promise<Res> {
  const challenge = await call('POST', '/challenge', { body: { deviceId } });
  expect(challenge.status).toBe(200);
  const nonce = challenge.body.data.nonce as string;
  return call('POST', path, { body: { deviceId, nonce, proof: proofForToken(deviceToken, nonce) } });
}

async function pairedPhone(): Promise<{ deviceId: string; deviceToken: string; confirmCode: string }> {
  const code = await pairingCode();
  const res = await call('POST', '/pair', { body: { code, label: 'Kason iPhone', platform: 'ios' } });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('POST /pairing (desktop)', () => {
  it('returns a code and an aasc.work link with the code in the fragment', async () => {
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(200);
    const { code, link } = res.body.data;
    expect(link.startsWith(`${PAIRING_LINK_BASE}#`)).toBe(true);
    const params = new URLSearchParams(link.split('#')[1]);
    expect(params.get('mc')).toBe(code);
    expect(params.get('lan')).toBe('192.168.1.20');
    expect(params.get('ts')).toBe('100.100.1.2');
    expect(params.get('p')).toBe('3333');
    expect(res.body.data).not.toHaveProperty('backendIncluded');
  });

  it('waits for a pairing target that asks Tailscale first, and puts its address in the link', async () => {
    pairingTarget = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103' };
    };
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(200);
    expect(new URLSearchParams(res.body.data.link.split('#')[1]).get('ts')).toBe('100.101.102.103');
    expect(res.body.data.target.tailnet).toBe('100.101.102.103');
  });

  it('pairs over Tailscale alone when there is no private home-network address', async () => {
    pairingTarget = () => ({ name: 'linux-box', port: 3333, lan: null, tailnet: '100.101.102.103' });
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(200);
    const params = new URLSearchParams(res.body.data.link.split('#')[1]);
    expect(params.has('lan')).toBe(false);
    expect(params.get('ts')).toBe('100.101.102.103');
  });

  // Oct 27 2026: a QR with no address the phone can dial reads "isn’t an AASC pairing code" on the phone.
  it('makes no pairing code when there is no address a phone can reach, and says why', async () => {
    pairingTarget = () => ({ name: 'linux-box', port: 3333, lan: null, tailnet: null });
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PHONE_ADDRESS');
    expect(res.body.error).toMatch(/same Wi-Fi.*Tailscale/);
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

describe('before the phone app ships (AASC-30)', () => {
  it('makes no pairing code and says why', async () => {
    offered = false;
    const res = await call('POST', '/pairing', { body: {} });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAIRING_NOT_OFFERED');
    expect(res.body.data).toBeUndefined();
  });

  it('the device list says whether pairing is offered', async () => {
    expect((await call('GET', '/devices')).body.data.pairingOffered).toBe(true);
    offered = false;
    expect((await call('GET', '/devices')).body.data.pairingOffered).toBe(false);
  });

  it('phones paired before still list, get approved and revoked', async () => {
    const a = await pairedPhone();
    const b = await pairedPhone();
    offered = false;
    expect((await call('GET', '/devices')).body.data.devices.map((d: { id: string }) => d.id).sort())
      .toEqual([a.deviceId, b.deviceId].sort());
    expect((await call('POST', `/devices/${a.deviceId}/approve`)).status).toBe(200);
    expect((await signIn(a.deviceId, a.deviceToken)).status).toBe(200);
    expect((await call('DELETE', `/devices/${b.deviceId}`)).status).toBe(200);
  });
});

describe('desktop routes need the dashboard session too', () => {
  it('a local caller without a signed-in session can’t mint, list or approve (curl, other accounts, header-less proxies)', async () => {
    const phone = await pairedPhone();
    signedIn = false;
    expect((await call('POST', '/pairing', { body: {} })).status).toBe(401);
    expect((await call('GET', '/devices')).status).toBe(401);
    expect((await call('POST', `/devices/${phone.deviceId}/approve`)).status).toBe(401);
    expect((await call('DELETE', `/devices/${phone.deviceId}`)).status).toBe(401);
  });

  it('the token never appears in a sign-in request: only a one-time proof', async () => {
    const phone = await pairedPhone();
    await call('POST', `/devices/${phone.deviceId}/approve`);
    const legacy = await call('POST', '/session', { body: { deviceId: phone.deviceId, deviceToken: phone.deviceToken } });
    expect(legacy.status).toBe(400);
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
    const session = await signIn(b.deviceId, b.deviceToken);
    expect(session.status).toBe(401);
    expect(session.body.code).toBe('DEVICE_REVOKED');
  });
});

describe('rename / sign out from the desktop', () => {
  it('PATCH renames a phone and the list shows the new name', async () => {
    const phone = await pairedPhone();
    const res = await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: '  Work iPhone ' } });
    expect(res.status).toBe(200);
    expect(res.body.data.device).toMatchObject({ id: phone.deviceId, label: 'Work iPhone' });
    expect((await call('GET', '/devices')).body.data.devices[0].label).toBe('Work iPhone');
  });

  it('PATCH refuses an empty, too long or extra-field body, and an unknown phone', async () => {
    const phone = await pairedPhone();
    expect((await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: '   ' } })).status).toBe(400);
    expect((await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: 'x'.repeat(81) } })).status).toBe(400);
    expect((await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: 'A', status: 'active' } })).status).toBe(400);
    expect((await call('PATCH', '/devices/00000000-0000-4000-8000-000000000000', { body: { label: 'A' } })).status).toBe(404);
  });

  it('PATCH and sign-out only answer the AASC page itself, signed in', async () => {
    const phone = await pairedPhone();
    await call('POST', `/devices/${phone.deviceId}/approve`);
    const cross = { 'sec-fetch-site': 'same-site' };
    expect((await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: 'A' }, headers: cross })).status).toBe(404);
    expect((await call('POST', `/devices/${phone.deviceId}/sign-out`, { headers: cross })).status).toBe(404);
    signedIn = false;
    expect((await call('PATCH', `/devices/${phone.deviceId}`, { body: { label: 'A' } })).status).toBe(401);
    expect((await call('POST', `/devices/${phone.deviceId}/sign-out`)).status).toBe(401);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('sign-out ends an approved phone\'s sessions without revoking it', async () => {
    const phone = await pairedPhone();
    await call('POST', `/devices/${phone.deviceId}/approve`);
    const res = await call('POST', `/devices/${phone.deviceId}/sign-out`);
    expect(res.status).toBe(200);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(onRevoked).not.toHaveBeenCalled();
    expect((await signIn(phone.deviceId, phone.deviceToken)).status).toBe(200);
  });

  it('sign-out answers 404 for a phone still waiting for approval', async () => {
    const phone = await pairedPhone();
    expect((await call('POST', `/devices/${phone.deviceId}/sign-out`)).status).toBe(404);
  });
});

describe('phone routes', () => {
  it('a pending phone is told to wait for approval; an approved one gets a session cookie', async () => {
    const phone = await pairedPhone();
    const pending = await signIn(phone.deviceId, phone.deviceToken);
    expect(pending.status).toBe(403);
    expect(pending.body.code).toBe('DEVICE_PENDING');
    expect(createSessionToken).not.toHaveBeenCalled();

    await call('POST', `/devices/${phone.deviceId}/approve`);
    const ok = await signIn(phone.deviceId, phone.deviceToken);
    expect(ok.status).toBe(200);
    expect(createSessionToken).toHaveBeenCalledWith(phone.deviceId);
    expect(String(ok.headers['set-cookie'])).toContain(`auth_token=session-for-${phone.deviceId}; HttpOnly; SameSite=Strict`);
  });

  // Paired computers (Oct 28 2026): another AASC desktop pairs like a phone and gets a computer session.
  it('pairs a computer, waits for Allow, then signs it in with a computer session', async () => {
    const code = await pairingCode();
    const res = await call('POST', '/pair', { body: { code, label: 'studio-mac', platform: 'desktop' } });
    expect(res.status).toBe(201);
    const { deviceId, deviceToken } = res.body.data;
    expect((await signIn(deviceId, deviceToken)).body.code).toBe('DEVICE_PENDING');
    const list = await call('GET', '/devices');
    expect(list.body.data.devices.find((d: { id: string }) => d.id === deviceId)).toMatchObject({ platform: 'desktop', label: 'studio-mac', status: 'pending' });
    await call('POST', `/devices/${deviceId}/approve`);
    const ok = await signIn(deviceId, deviceToken);
    expect(ok.status).toBe(200);
    expect(createComputerSessionToken).toHaveBeenCalledWith(deviceId);
    expect(createSessionToken).not.toHaveBeenCalled();
    expect(String(ok.headers['set-cookie'])).toContain(`auth_token=computer-session-for-${deviceId}`);
  });

  it('all phone routes refuse when no password is set', async () => {
    const phone = await pairedPhone();
    passwordEnabled = false;
    expect((await call('POST', '/pair', { body: { code: 'ABCDEFGHJK', label: 'x', platform: 'ios' } })).status).toBe(403);
    const challenge = await call('POST', '/challenge', { body: { deviceId: phone.deviceId } });
    expect(challenge.status).toBe(403);
    expect(challenge.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
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
    expect((await signIn(phone.deviceId, 'w'.repeat(43), '/unpair')).status).toBe(401);
    expect((await signIn(phone.deviceId, phone.deviceToken, '/unpair')).status).toBe(200);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('buildPairingLink', () => {
  it('carries the Mac code only: never a backend host, code or Mac device id (AASC-52)', () => {
    const link = buildPairingLink({ name: 'Mac', port: 3333, lan: null, tailnet: '100.100.1.2' }, 'MACCODE234');
    const params = new URLSearchParams(link.split('#')[1]);
    expect([...params.keys()]).toEqual(['v', 'name', 'ts', 'p', 'mc']);
    expect(params.get('mc')).toBe('MACCODE234');
    expect(params.has('lan')).toBe(false);
  });

  it('names a configured public address as pub=, after ts= (Oct 28 2026)', () => {
    const link = buildPairingLink({ name: 'claude-desktop', port: 3333, lan: null, tailnet: '100.74.194.86', publicAddress: '45.63.31.79' }, 'MACCODE234');
    const params = new URLSearchParams(link.split('#')[1]);
    expect([...params.keys()]).toEqual(['v', 'name', 'ts', 'pub', 'p', 'mc']);
    expect(params.get('pub')).toBe('45.63.31.79');
  });

  it('names none when no public address is set', () => {
    const link = buildPairingLink({ name: 'Mac', port: 3333, lan: '192.168.1.2', tailnet: null, publicAddress: null }, 'MACCODE234');
    expect(new URLSearchParams(link.split('#')[1]).has('pub')).toBe(false);
  });
});

describe('GET /devices — online (Oct 22 2026)', () => {
  it('marks a paired phone online only while it has an open socket', async () => {
    const { deviceId } = await pairedPhone();
    const phone = async () => (await call('GET', '/devices')).body.data.devices.find((d: { id: string }) => d.id === deviceId);
    expect((await phone()).online).toBe(false);
    onlinePhones.add(deviceId);
    expect((await phone()).online).toBe(true);
  });
});
