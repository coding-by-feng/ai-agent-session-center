// test/phoneBackendCode.test.ts — AASC-52: the backend code goes to an approved phone over its own Mac session.
//
// The QR used to carry a phone-scoped backend code beside the Mac's code. Anyone who photographed it could
// redeem that half alone for ten minutes and get a push device the Mac never listed and could never revoke.
// Now the Mac issues it only to a phone that is paired, approved, signed in and from the current password;
// binds it to that phone before answering; keeps one outstanding per phone; and revokes the backend device
// a phone's last code made before issuing another, so one phone never holds two.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { bearerSession, createToken } from '../server/authManager.js';
import { createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import {
  BACKEND_CODE_EXPIRY_MARGIN_MS, BACKEND_CODE_TTL_SECONDS, type PhoneCloudBridge, type RetiredBackendCode,
} from '../server/mobile/phoneCloudBridge.js';
import {
  createPhoneBackendCodes, MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR, MAX_BACKEND_CODES_PER_HOUR, type BackendCodeLedger,
} from '../server/mobile/phoneBackendCode.js';

function memoryStore(): MobileDeviceStore & { rows: Map<string, MobileDeviceRecord> } {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    rows,
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

function memoryLedger(): BackendCodeLedger & { rows: Map<string, { deviceId: string; mintedAt: number; expiresAt: number }> } {
  const rows = new Map<string, { deviceId: string; mintedAt: number; expiresAt: number }>();
  return {
    rows,
    record: ({ codeRef, deviceId, mintedAt, expiresAt }) => { rows.set(codeRef, { deviceId, mintedAt, expiresAt }); },
    expiresAt: (codeRef) => rows.get(codeRef)?.expiresAt ?? null,
    has: (codeRef) => rows.has(codeRef),
  };
}

/**
 * The cloud half: mints numbered codes; a code is 'unredeemed' until the test redeems it. Like the real
 * bridge, a minted code expires a full life after the backend's answer came back; `retireTakesMs` and
 * `mintTakesMs` move the clock on while the backend thinks.
 */
function fakeCloud() {
  const state = {
    available: true, failMint: false, failRetire: false, slow: null as Promise<void> | null, retireTakesMs: 0, mintTakesMs: 0,
  };
  const minted: Array<{ code: string; codeRef: string }> = [];
  const redeemed = new Set<string>();
  const revoked = new Set<string>();
  const calls: string[] = [];
  const cloud: Pick<PhoneCloudBridge, 'cloudAvailable' | 'mintBackendCode' | 'retireBackendCode'> = {
    cloudAvailable: () => state.available,
    async mintBackendCode() {
      calls.push('mint');
      if (state.slow) await state.slow;
      clock += state.mintTakesMs;
      if (state.failMint) return null;
      const n = minted.length + 1;
      const code = { code: `${'C'.repeat(21)}${n}`, codeRef: `ref-${n}` };
      minted.push(code);
      return { host: 'api.aasc.work', ...code, macDeviceId: 'mac-device-1', expiresAt: clock + BACKEND_CODE_TTL_SECONDS * 1000 };
    },
    async retireBackendCode(codeRef): Promise<RetiredBackendCode> {
      calls.push(`retire ${codeRef}`);
      clock += state.retireTakesMs;
      if (state.failRetire) throw Object.assign(new Error('down'), { code: 'offline' });
      if (!redeemed.has(codeRef)) return 'unredeemed';
      if (revoked.has(codeRef)) return 'already-revoked';
      revoked.add(codeRef);
      return 'revoked';
    },
  };
  /** The phone redeems the code it was given; returns the codeRef it came from. */
  const redeem = (code: string): string => {
    const ref = minted.find((m) => m.code === code)!.codeRef;
    redeemed.add(ref);
    return ref;
  };
  return { cloud, state, minted, redeemed, revoked, calls, redeem };
}

let clock: number;
let epoch: string;
let store: ReturnType<typeof memoryStore>;
let ledger: ReturnType<typeof memoryLedger>;
let fake: ReturnType<typeof fakeCloud>;
let deviceAuth: ReturnType<typeof createDeviceAuth>;
let passwordEnabled: boolean;
const info = vi.fn();
const warn = vi.fn();
let server: http.Server;
let port: number;

beforeEach(async () => {
  clock = 1_000_000;
  epoch = 'pw-1';
  passwordEnabled = true;
  info.mockClear();
  warn.mockClear();
  store = memoryStore();
  ledger = memoryLedger();
  fake = fakeCloud();
  deviceAuth = createDeviceAuth({ store, now: () => clock, credentialEpoch: () => epoch });
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => passwordEnabled,
    requireSession: (_req, _res, next) => next(),
    createSessionToken: (deviceId) => `session-for-${deviceId}`,
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
    rateLimit: { check: () => 0, record: () => {}, clear: () => {} },
    sessionOf: (req) => {
      const auth = String(req.headers.authorization ?? '');
      if (auth === 'Bearer desktop-session') return { deviceId: null }; // a password sign-in (an iPad's browser)
      const m = /^Bearer session-for-(.+)$/.exec(auth);
      return m ? { deviceId: m[1] } : null;
    },
    backendCodes: createPhoneBackendCodes({ deviceAuth, cloud: fake.cloud, ledger, now: () => clock, info, warn }),
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Res { status: number; body: Record<string, any> }

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
      headers: {
        host: `localhost:${port}`,
        ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A phone paired through the QR (and approved unless `approve` is false). */
function phone(approve = true): { deviceId: string; deviceToken: string } {
  const { code } = deviceAuth.createPairingCode();
  const { device, deviceToken } = deviceAuth.redeem({ code, label: 'Kason iPhone', platform: 'ios' })!;
  if (approve) deviceAuth.approve(device.id);
  return { deviceId: device.id, deviceToken };
}

const ask = (deviceId: string, headers: Record<string, string> = {}) =>
  call('POST', '/backend-code', {}, { authorization: `Bearer session-for-${deviceId}`, ...headers });

describe('POST /api/mobile/backend-code', () => {
  it('gives an approved, signed-in phone a code, bound to that phone before the answer', async () => {
    const p = phone();
    const res = await ask(p.deviceId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { host: 'api.aasc.work', code: fake.minted[0].code, macDeviceId: 'mac-device-1' } });
    expect(store.rows.get(p.deviceId)).toMatchObject({ beCodeRef: 'ref-1', beCodeRefMacBound: true });
    expect(ledger.rows.get('ref-1')).toEqual({ deviceId: p.deviceId, mintedAt: clock, expiresAt: clock + BACKEND_CODE_TTL_SECONDS * 1000 });
    // Logged without the code or its ref.
    const logged = [...info.mock.calls, ...warn.mock.calls].flat().join('\n');
    expect(logged).not.toContain(fake.minted[0].code);
    expect(logged).not.toContain('ref-1');
  });

  it('works with the device token the phone signed in with: /session’s token is what it presents', async () => {
    const p = phone();
    const challenge = await call('POST', '/challenge', { deviceId: p.deviceId });
    const nonce = challenge.body.data.nonce as string;
    const session = await call('POST', '/session', { deviceId: p.deviceId, nonce, proof: proofForToken(p.deviceToken, nonce) });
    const res = await call('POST', '/backend-code', {}, { authorization: `Bearer ${session.body.data.token}` });
    expect(res.status).toBe(200);
  });

  it('refuses anyone who isn’t a signed-in phone', async () => {
    const none = await call('POST', '/backend-code', {});
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('NOT_SIGNED_IN');
    const desktop = await call('POST', '/backend-code', {}, { authorization: 'Bearer desktop-session' });
    expect(desktop.status).toBe(403);
    expect(desktop.body.code).toBe('NOT_A_PHONE');
    expect(fake.calls).toEqual([]);
  });

  it('refuses a phone not approved yet, a revoked one, and one paired under an old password (revoking it)', async () => {
    const pending = phone(false);
    expect((await ask(pending.deviceId)).body.code).toBe('DEVICE_PENDING');
    expect((await ask(pending.deviceId)).status).toBe(403);
    const revoked = phone();
    deviceAuth.revoke(revoked.deviceId);
    const r = await ask(revoked.deviceId);
    expect([r.status, r.body.code]).toEqual([401, 'DEVICE_REVOKED']);
    const old = phone();
    epoch = 'pw-2';
    const o = await ask(old.deviceId);
    expect([o.status, o.body.code]).toEqual([401, 'DEVICE_REVOKED']);
    expect(store.rows.get(old.deviceId)?.status).toBe('revoked');
    expect(fake.calls).toEqual([]);
  });

  it('says clearly when the Mac has no cloud connection, and asks the backend nothing', async () => {
    const p = phone();
    fake.state.available = false;
    const res = await ask(p.deviceId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_CLOUD');
    expect(fake.calls).toEqual([]);
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBeNull();
  });

  it('keeps one outstanding code per phone: a second ask waits until the first is used or surely expired', async () => {
    const p = phone();
    await ask(p.deviceId);
    clock += 20_000;
    const again = await ask(p.deviceId);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('BACKEND_CODE_OUTSTANDING');
    // Its life plus a margin: the Mac's clock and the backend's may disagree by a few seconds.
    const wait = (BACKEND_CODE_TTL_SECONDS * 1000 + BACKEND_CODE_EXPIRY_MARGIN_MS - 20_000) / 1000;
    expect(again.body.retryAfter).toBe(wait);
    expect(fake.minted).toHaveLength(1);
    clock += wait * 1000 - 1;
    expect((await ask(p.deviceId)).body.code).toBe('BACKEND_CODE_OUTSTANDING');
    clock += 1;
    const later = await ask(p.deviceId);
    expect(later.status).toBe(200);
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBe('ref-2');
  });

  // AASC-52 review: a phone looping on its answer must not turn into backend round trips.
  it('answers "outstanding" from the ledger while the last code lives: the backend is looked at once per code', async () => {
    const p = phone();
    await ask(p.deviceId);
    clock += 5_000;
    const first = await ask(p.deviceId);
    expect([first.status, first.body.code]).toEqual([409, 'BACKEND_CODE_OUTSTANDING']);
    expect(fake.calls).toEqual(['mint', 'retire ref-1']);
    clock += 5_000;
    const again = await ask(p.deviceId);
    expect([again.status, again.body.code]).toEqual([409, 'BACKEND_CODE_OUTSTANDING']);
    expect(again.body.retryAfter).toBe((BACKEND_CODE_TTL_SECONDS * 1000 + BACKEND_CODE_EXPIRY_MARGIN_MS - 10_000) / 1000);
    expect(fake.calls).toEqual(['mint', 'retire ref-1']);
  });

  // The plain-HTTP LAN path: a sniffer may redeem the code before the phone does. The phone then asks again at
  // once, and that one look at the backend revokes the device the sniffer made before a new code is minted.
  it('a phone asking again right after its redemption failed gets the device someone else made revoked', async () => {
    const p = phone();
    fake.redeem((await ask(p.deviceId)).body.data.code); // the sniffer was first
    const again = await ask(p.deviceId);
    expect(again.status).toBe(200);
    expect(fake.calls).toEqual(['mint', 'retire ref-1', 'mint']);
    expect(fake.revoked).toEqual(new Set(['ref-1']));
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBe('ref-2');
  });

  it(`caps requests, not just codes: a looping phone causes at most ${MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR} backend calls an hour`, async () => {
    const p = phone();
    fake.state.failMint = true; // every try fails at the backend: each one would otherwise be a round trip
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      statuses.push((await ask(p.deviceId)).status);
      clock += 1_000;
    }
    expect(fake.calls).toHaveLength(MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR);
    expect(statuses.slice(0, MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR).every((s) => s === 502)).toBe(true);
    const blocked = await ask(p.deviceId);
    expect([blocked.status, blocked.body.code]).toEqual([429, 'RATE_LIMITED']);
    expect(blocked.body.error).toMatch(/Too many/);
    expect(blocked.body.retryAfter).toBe(3600 - 50);
    expect(fake.calls).toHaveLength(MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR);
    // Once the window has passed, the phone may try again.
    clock += blocked.body.retryAfter * 1000;
    fake.state.failMint = false;
    expect((await ask(p.deviceId)).status).toBe(200);
  });

  it('a phone that never redeems and keeps asking costs two backend calls, then waits out the hour', async () => {
    const p = phone();
    const answers: string[] = [];
    for (let i = 0; i < 200; i++) {
      const res = await ask(p.deviceId);
      answers.push(res.status === 200 ? 'ok' : String(res.body.code));
      clock += 1_000;
    }
    expect(fake.calls).toEqual(['mint', 'retire ref-1']);
    expect(answers.slice(0, MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR)).toEqual(
      ['ok', ...Array(MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR - 1).fill('BACKEND_CODE_OUTSTANDING')]);
    expect(answers.slice(MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR).every((a) => a === 'RATE_LIMITED')).toBe(true);
  });

  // AASC-52 review: the expiry comes from when the mint answered, not from when the phone asked.
  it('slow backend round trips before the mint never make a live code look expired', async () => {
    const p = phone();
    fake.redeem((await ask(p.deviceId)).body.data.code);
    fake.state.retireTakesMs = 30_000;
    fake.state.mintTakesMs = 10_000;
    const asked = clock;
    expect((await ask(p.deviceId)).status).toBe(200); // ref-2, answered 40 s after the phone asked
    const answered = asked + 40_000;
    expect(ledger.rows.get('ref-2')?.expiresAt).toBe(answered + BACKEND_CODE_TTL_SECONDS * 1000);
    fake.state.retireTakesMs = 0;
    fake.state.mintTakesMs = 0;
    // Past "asked + life + margin", still inside "answered + life + margin": ref-2 may still be redeemed.
    clock = asked + BACKEND_CODE_TTL_SECONDS * 1000 + BACKEND_CODE_EXPIRY_MARGIN_MS + 1_000;
    const again = await ask(p.deviceId);
    expect([again.status, again.body.code]).toEqual([409, 'BACKEND_CODE_OUTSTANDING']);
    expect(again.body.retryAfter).toBe((answered + BACKEND_CODE_TTL_SECONDS * 1000 + BACKEND_CODE_EXPIRY_MARGIN_MS - clock) / 1000);
    expect(fake.minted).toHaveLength(2);
  });

  it('asking again after redeeming revokes the backend device the last code made first: one phone, one device', async () => {
    const p = phone();
    fake.redeem((await ask(p.deviceId)).body.data.code);
    const again = await ask(p.deviceId);
    expect(again.status).toBe(200);
    expect(fake.calls).toEqual(['mint', 'retire ref-1', 'mint']);
    expect(fake.revoked).toEqual(new Set(['ref-1']));
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBe('ref-2');
  });

  it('mints nothing when the old backend device can’t be revoked first', async () => {
    const p = phone();
    fake.redeem((await ask(p.deviceId)).body.data.code);
    fake.state.failRetire = true;
    const res = await ask(p.deviceId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CLOUD_UNAVAILABLE');
    expect(fake.minted).toHaveLength(1);
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBe('ref-1');
    expect(String(warn.mock.calls.at(-1)?.[0])).not.toContain('ref-1');
  });

  it('answers 502 when the backend won’t mint, and binds nothing', async () => {
    const p = phone();
    fake.state.failMint = true;
    const res = await ask(p.deviceId);
    expect([res.status, res.body.code]).toEqual([502, 'CLOUD_UNAVAILABLE']);
    expect(store.rows.get(p.deviceId)?.beCodeRef).toBeNull();
  });

  it(`is rate-limited: at most ${MAX_BACKEND_CODES_PER_HOUR} codes per phone an hour`, async () => {
    const p = phone();
    for (let i = 0; i < MAX_BACKEND_CODES_PER_HOUR; i++) {
      const res = await ask(p.deviceId);
      expect(res.status).toBe(200);
      fake.redeem(res.body.data.code);
      clock += 60_000;
    }
    const blocked = await ask(p.deviceId);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.retryAfter).toBe(3600 - 3 * 60);
    expect(fake.minted).toHaveLength(MAX_BACKEND_CODES_PER_HOUR);
    clock += blocked.body.retryAfter * 1000;
    expect((await ask(p.deviceId)).status).toBe(200);
  });

  it('answers one request per phone at a time', async () => {
    const p = phone();
    let release!: () => void;
    fake.state.slow = new Promise<void>((r) => { release = r; });
    const first = ask(p.deviceId);
    await vi.waitFor(() => expect(fake.calls).toEqual(['mint']));
    const second = await ask(p.deviceId);
    expect([second.status, second.body.code]).toEqual([409, 'BACKEND_CODE_BUSY']);
    release();
    expect((await first).status).toBe(200);
    expect(fake.minted).toHaveLength(1);
  });

  it('a phone revoked while the backend answered gets nothing bound', async () => {
    const p = phone();
    let release!: () => void;
    fake.state.slow = new Promise<void>((r) => { release = r; });
    const pending = ask(p.deviceId);
    await vi.waitFor(() => expect(fake.calls).toEqual(['mint']));
    deviceAuth.revoke(p.deviceId);
    release();
    const res = await pending;
    expect([res.status, res.body.code]).toEqual([401, 'DEVICE_REVOKED']);
    expect(res.body.data).toBeUndefined();
  });

  it('uses the phone routes’ gates: JSON only, no cross-site page, a password set, nothing extra in the body', async () => {
    const p = phone();
    expect((await ask(p.deviceId, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('POST', '/backend-code', { scopes: ['admin'] }, { authorization: `Bearer session-for-${p.deviceId}` })).status).toBe(400);
    passwordEnabled = false;
    const noPassword = await ask(p.deviceId);
    expect([noPassword.status, noPassword.body.code]).toEqual([403, 'REMOTE_PASSWORD_REQUIRED']);
    const textPlain = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/backend-code',
        headers: { 'content-type': 'text/plain', authorization: `Bearer session-for-${p.deviceId}` },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end('{}');
    });
    expect(textPlain).toBe(415);
    expect(fake.calls).toEqual([]);
  });

  // AASC-52 review: the phone's HttpOnly cookie lives in the shell's WebView next to the dashboard page, so a
  // script in that page could send it. The route reads the shell's own Bearer header only (the real lookup here).
  it('takes the session from the Bearer header only: never the cookie or ?token=', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth,
      isPasswordEnabled: () => true,
      requireSession: (_req, _res, next) => next(),
      createSessionToken: (deviceId) => createToken(deviceId),
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit: { check: () => 0, record: () => {}, clear: () => {} },
      sessionOf: bearerSession,
      backendCodes: createPhoneBackendCodes({ deviceAuth, cloud: fake.cloud, ledger, now: () => clock, info, warn }),
    }));
    const real = http.createServer(app);
    await new Promise<void>((r) => real.listen(0, '127.0.0.1', r));
    const realPort = (real.address() as AddressInfo).port;
    const post = (path: string, headers: Record<string, string>) => new Promise<Res>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: realPort, method: 'POST', path: `/api/mobile${path}`,
        headers: { 'content-type': 'application/json', host: `localhost:${realPort}`, ...headers } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    try {
      const a = phone();
      const b = phone();
      const tokenA = createToken(a.deviceId);
      const tokenB = createToken(b.deviceId);
      const cookieOnly = await post('/backend-code', { cookie: `auth_token=${tokenA}` });
      expect([cookieOnly.status, cookieOnly.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
      const queryOnly = await post(`/backend-code?token=${tokenA}`, {});
      expect([queryOnly.status, queryOnly.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
      expect(fake.calls).toEqual([]);
      // A stale cookie, or another phone's, next to a valid Bearer: the Bearer's phone gets the code.
      const stale = await post('/backend-code', { cookie: 'auth_token=stale', authorization: `Bearer ${tokenA}` });
      expect(stale.status).toBe(200);
      expect(store.rows.get(a.deviceId)?.beCodeRef).toBe('ref-1');
      const mixed = await post('/backend-code', { cookie: `auth_token=${tokenA}`, authorization: `Bearer ${tokenB}` });
      expect(mixed.status).toBe(200);
      expect(store.rows.get(b.deviceId)?.beCodeRef).toBe('ref-2');
    } finally {
      await new Promise<void>((r) => real.close(() => r()));
    }
  });

  it('answers NO_CLOUD when the Mac was started without the cloud half at all', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth,
      isPasswordEnabled: () => true,
      requireSession: (_req, _res, next) => next(),
      createSessionToken: (deviceId) => `session-for-${deviceId}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit: { check: () => 0, record: () => {}, clear: () => {} },
      sessionOf: () => ({ deviceId: 'whoever' }),
    }));
    const bare = http.createServer(app);
    await new Promise<void>((r) => bare.listen(0, '127.0.0.1', r));
    const barePort = (bare.address() as AddressInfo).port;
    const status = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: barePort, method: 'POST', path: '/api/mobile/backend-code',
        headers: { 'content-type': 'application/json', host: `localhost:${barePort}` } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    await new Promise<void>((r) => bare.close(() => r()));
    expect(status.status).toBe(409);
    expect(JSON.parse(status.body).code).toBe('NO_CLOUD');
  });
});
