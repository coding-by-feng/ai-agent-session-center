// test/mobileEnrollRoute.test.ts — plan 17: POST /api/mobile/enroll and the desktop's account-enroll switch.
//
// The phone's enroll call sits in the public group with /pair: JSON only, never cross-site, refused without a
// dashboard password, closed to a locked-out address, and a bad ticket costs a login strike. The desktop's
// PUT /pairing/account-enroll and the status in GET /devices sit behind the desktop gate like /pairing.
// Real sockets: the route signs over the address the request reached (reachedAt), the one /identify uses.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter, MAX_ENROLLS_TOTAL } from '../server/mobile/mobileRouter.js';
import type { AccountEnrollHooks, AccountEnrollInput, AccountEnrollOutcome } from '../server/mobile/accountEnroll.js';

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

const BODY = {
  macDeviceId: '00000000-0000-4000-8000-0000000000aa',
  ticket: 'k'.repeat(43),
  phoneKey: `B${'p'.repeat(86)}`,
  nonce: 'a1'.repeat(32),
  label: 'Kason iPhone',
  platform: 'ios',
};
const ANSWER = { macKey: `B${'m'.repeat(86)}`, iv: 'i'.repeat(16), sealed: 's'.repeat(80) };

interface Res { status: number; body: Record<string, any> }

/** Outcomes that never reach the backend, so cost no login strike (accountEnroll.ts steps 1–3). */
const LOCAL_REFUSALS = new Set(['off', 'not-this-mac', 'busy']);

describe('POST /api/mobile/enroll', () => {
  let server: http.Server;
  let port: number;
  let passwordEnabled: boolean;
  let failures: Map<string, number>;
  let strikesAtRedeem: number[];
  let outcome: AccountEnrollOutcome;
  let enrollCalls: AccountEnrollInput[];
  /** When set, each enroll waits on its own promise until the test lets it go. */
  let hold: null | Array<() => void>;
  let throwIt: boolean;

  async function start(withEnroll = true): Promise<void> {
    const auth = createDeviceAuth({ store: memoryStore() });
    const app = express();
    app.set('trust proxy', true); // lets a test speak for several client addresses with X-Forwarded-For
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth,
      isPasswordEnabled: () => passwordEnabled,
      pairingOffered: () => true,
      requireSession: (_req, _res, n) => n(),
      createSessionToken: (id) => `session-for-${id}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit: {
        check: (ip) => ((failures.get(ip) ?? 0) >= 5 ? 900 : 0),
        record: (ip) => { failures.set(ip, (failures.get(ip) ?? 0) + 1); },
        clear: (ip) => { failures.delete(ip); },
      },
      ...(withEnroll ? {
        accountEnroll: {
          enroll: async (input: AccountEnrollInput, hooks: AccountEnrollHooks = {}) => {
            enrollCalls.push(input);
            const current = outcome;
            if (current.ok || !LOCAL_REFUSALS.has(current.reason)) {
              hooks.beforeRedeem?.();
              strikesAtRedeem.push(failures.get('127.0.0.1') ?? 0);
            }
            if (hold) await new Promise<void>((release) => hold!.push(release));
            if (throwIt) throw new Error('enroll blew up');
            return current;
          },
          status: () => ({ enabled: true, available: true, email: 'me@example.com', blocked: null }),
        },
      } : {}),
    }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    passwordEnabled = true;
    failures = new Map();
    strikesAtRedeem = [];
    enrollCalls = [];
    hold = null;
    throwIt = false;
    const auth = createDeviceAuth({ store: memoryStore() });
    const device = auth.enrollActive({ label: 'Kason iPhone', platform: 'ios', accountEmail: 'me@example.com', accountPhoneId: null }).device;
    outcome = { ok: true, answer: ANSWER, device: { ...device, confirmCode: null, access: 'sessions-only' } as never };
  });

  afterEach(async () => {
    if (hold) for (const release of hold.splice(0)) release();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/enroll', agent: false,
        headers: { host: `192.168.1.20:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed: Record<string, any> = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* Express's own HTML error page */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async function heldUntil(count: number): Promise<void> {
    for (let i = 0; i < 200 && (hold?.length ?? 0) < count; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold?.length).toBe(count);
  }

  it('answers 201 with the sealed answer, and hands the address the request reached to the seal', async () => {
    await start();
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: ANSWER });
    expect(enrollCalls).toEqual([{ ...BODY, reachedAt: `127.0.0.1:${port}` }]);
  });

  it('records the login strike before the backend is asked, and clears it on success (review M4)', async () => {
    await start();
    expect((await post(BODY)).status).toBe(201);
    expect(strikesAtRedeem).toEqual([1]); // already counted while the backend call was in flight
    expect(failures.size).toBe(0);
  });

  it('accepts a body without a label: the record is named by the backend (review M3)', async () => {
    await start();
    const { label: _label, ...noLabel } = BODY;
    expect((await post(noLabel)).status).toBe(201);
  });

  it.each([
    ['off', 403, 'ACCOUNT_ENROLL_OFF'],
    ['not-this-mac', 409, 'NOT_THIS_MAC'],
  ] as const)('answers %s as %i %s, with no login strike (no backend call)', async (reason, status, code) => {
    await start();
    outcome = { ok: false, reason };
    const res = await post(BODY);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.data).toBeUndefined();
    expect(failures.size).toBe(0);
  });

  it('answers too many waiting phones as 429 TOO_MANY_NEW_PHONES with a retryAfter, no strike (review L2)', async () => {
    await start();
    outcome = { ok: false, reason: 'busy' };
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_NEW_PHONES', retryAfter: 120 });
    expect(failures.size).toBe(0);
  });

  it.each([
    ['phone-revoked', 401, 'PHONE_REVOKED'],
    ['cloud-failed', 502, 'CLOUD_UNAVAILABLE'],
    ['invalid', 401, 'INVALID_TICKET'],
    ['expired', 401, 'INVALID_TICKET'],
    ['used', 401, 'INVALID_TICKET'],
  ] as const)('answers %s as %i %s and keeps the strike it cost', async (reason, status, code) => {
    await start();
    outcome = { ok: false, reason };
    const res = await post(BODY);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(failures.get('127.0.0.1')).toBe(1);
  });

  it('answers ACCOUNT_ENROLL_OFF on a server built without account enroll', async () => {
    await start(false);
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_ENROLL_OFF');
  });

  it.each([
    ['a mac id that is no uuid', { ...BODY, macDeviceId: 'mac-1' }],
    ['a short ticket', { ...BODY, ticket: 'k'.repeat(42) }],
    ['a padded ticket', { ...BODY, ticket: `${'k'.repeat(42)}=` }],
    ['a short phone key', { ...BODY, phoneKey: 'p'.repeat(86) }],
    ['a nonce that is not hex', { ...BODY, nonce: 'z'.repeat(64) }],
    ['an upper-case nonce', { ...BODY, nonce: 'A1'.repeat(32) }],
    ['an empty label', { ...BODY, label: '' }],
    ['a label over 200', { ...BODY, label: 'x'.repeat(201) }],
    ['a desktop platform', { ...BODY, platform: 'desktop' }],
    ['an extra field', { ...BODY, deviceToken: 'x' }],
    ['a reachedAt from the phone', { ...BODY, reachedAt: '10.0.0.1:1' }],
    ['a missing field', { ...BODY, nonce: undefined }],
  ])('refuses %s (400) before enrolling', async (_label, body) => {
    await start();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(enrollCalls).toEqual([]);
  });

  it('is refused when no dashboard password is set', async () => {
    await start();
    passwordEnabled = false;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
    expect(enrollCalls).toEqual([]);
  });

  it('refuses cross-site browser requests and non-JSON bodies', async () => {
    await start();
    expect((await post(BODY, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('ticket=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect(enrollCalls).toEqual([]);
  });

  it('is closed to an address the login limiter locked out', async () => {
    await start();
    failures.set('127.0.0.1', 5);
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(enrollCalls).toEqual([]);
  });

  it('locks a guesser out after five bad tickets', async () => {
    await start();
    outcome = { ok: false, reason: 'invalid' };
    for (let i = 0; i < 5; i++) expect((await post(BODY)).status).toBe(401);
    expect((await post(BODY)).status).toBe(429);
    expect(enrollCalls).toHaveLength(5);
  });

  it('runs one enroll at a time per address: a second one waits its turn with 429 ENROLL_BUSY (review M4)', async () => {
    await start();
    hold = [];
    const first = post(BODY);
    await heldUntil(1);
    const second = await post(BODY);
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ code: 'ENROLL_BUSY', retryAfter: expect.any(Number) });
    expect(enrollCalls).toHaveLength(1);
    hold.shift()!();
    expect((await first).status).toBe(201);
    hold = null;
    expect((await post(BODY)).status).toBe(201); // the slot is free again
  });

  it(`runs at most ${MAX_ENROLLS_TOTAL} enrolls at once from all addresses`, async () => {
    await start();
    hold = [];
    const running = Array.from({ length: MAX_ENROLLS_TOTAL }, (_, i) => post(BODY, { 'x-forwarded-for': `10.0.0.${i + 1}` }));
    await heldUntil(MAX_ENROLLS_TOTAL);
    const extra = await post(BODY, { 'x-forwarded-for': '10.0.0.99' });
    expect(extra.status).toBe(429);
    expect(extra.body.code).toBe('ENROLL_BUSY');
    expect(enrollCalls).toHaveLength(MAX_ENROLLS_TOTAL);
    for (const release of hold.splice(0)) release();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(MAX_ENROLLS_TOTAL).fill(201));
  });

  it('frees the slot when the enroll throws', async () => {
    await start();
    throwIt = true;
    hold = [];
    const failing = post(BODY);
    await heldUntil(1);
    hold.shift()!();
    expect((await failing).status).toBe(500);
    hold = null;
    throwIt = false;
    expect((await post(BODY)).status).toBe(201); // not ENROLL_BUSY
  });
});

describe('the desktop account-enroll switch', () => {
  let server: http.Server;
  let port: number;
  let enabled: boolean;
  let setCalls: boolean[];
  let pinnedByEnv: boolean;
  let sessionOk: boolean;

  beforeEach(async () => {
    enabled = true;
    setCalls = [];
    pinnedByEnv = false;
    sessionOk = true;
    const auth = createDeviceAuth({ store: memoryStore() });
    auth.enrollActive({ label: 'Pixel', platform: 'android', accountEmail: 'me@example.com', accountPhoneId: null });
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth,
      isPasswordEnabled: () => true,
      pairingOffered: () => true,
      requireSession: (_req, res, next) => (sessionOk ? next() : void res.status(401).json({ error: 'Sign in' })),
      createSessionToken: (id) => `s-${id}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: null, tailnet: null }),
      rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
      accountEnroll: {
        enroll: async () => ({ ok: false, reason: 'off' }),
        status: () => ({ enabled, available: true, email: 'me@example.com', blocked: null }),
      },
      setAccountEnroll: (on) => {
        if (pinnedByEnv) return false;
        setCalls.push(on);
        enabled = on;
        return true;
      },
    }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
        headers: {
          host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('reports the switch, whether this Mac can redeem, and the account, beside the devices', async () => {
    const res = await call('GET', '/devices');
    expect(res.status).toBe(200);
    expect(res.body.data.accountEnroll).toEqual({ enabled: true, available: true, email: 'me@example.com', blocked: null });
    expect(res.body.data.devices[0]).toMatchObject({ origin: 'account', accountEmail: 'me@example.com' });
  });

  it('turns the switch off and on, answering the new state', async () => {
    const off = await call('PUT', '/pairing/account-enroll', { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ success: true, data: { accountEnroll: { enabled: false, available: true, email: 'me@example.com', blocked: null } } });
    expect((await call('PUT', '/pairing/account-enroll', { enabled: true })).body.data.accountEnroll.enabled).toBe(true);
    expect(setCalls).toEqual([false, true]);
  });

  it('says so when the environment pins the switch', async () => {
    pinnedByEnv = true;
    const res = await call('PUT', '/pairing/account-enroll', { enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SET_BY_ENVIRONMENT');
  });

  it.each([
    ['no body', undefined],
    ['a string', { enabled: 'false' }],
    ['an extra field', { enabled: false, email: 'x' }],
  ])('refuses %s (400)', async (_label, body) => {
    expect((await call('PUT', '/pairing/account-enroll', body)).status).toBe(400);
    expect(setCalls).toEqual([]);
  });

  it('is 404 to another device and to a cross-site page', async () => {
    expect((await call('PUT', '/pairing/account-enroll', { enabled: false }, { host: `192.168.1.20:${port}` })).status).toBe(404);
    expect((await call('PUT', '/pairing/account-enroll', { enabled: false }, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(404);
    expect(setCalls).toEqual([]);
  });

  it('needs the dashboard session', async () => {
    sessionOk = false;
    expect((await call('PUT', '/pairing/account-enroll', { enabled: false })).status).toBe(401);
    expect(setCalls).toEqual([]);
  });
});
