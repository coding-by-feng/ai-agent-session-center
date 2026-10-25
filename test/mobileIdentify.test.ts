// test/mobileIdentify.test.ts — the Mac proves itself to a phone that lost its address (LAN rescan).
//
// A paired phone whose saved home-network address went stale looks for the Mac on the Wi-Fi it is on.
// Anything can answer on the port, so the phone opens an address only once the Mac there proves it holds
// this phone's key, over the address the phone reached it at:
//   the phone names itself by tag = HMAC(SHA-256(token), "aasc-who:" + nonce), never by its id;
//   the Mac answers HMAC(SHA-256(token), "aasc-mac:" + nonce + ":" + <its own address:port on that socket>).
// A relay on the network reaches the Mac from its own socket, so the address in the proof is the Mac's,
// not the relay's the phone dialled. The prefixes keep both apart from sign-in proofs (base64url nonces).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createHash } from 'node:crypto';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import {
  createDeviceAuth, MAC_PROOF_PREFIX, proofForToken, WHO_TAG_PREFIX, type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';

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

function hmac(deviceToken: string, message: string): string {
  const key = createHash('sha256').update(deviceToken).digest();
  return createHmac('sha256', key).update(message).digest('hex');
}

/** The phone's name for itself: its key over the "aasc-who:" nonce. */
const tagFor = (deviceToken: string, nonce: string) => hmac(deviceToken, `aasc-who:${nonce}`);
/** What the phone expects back from the Mac it dialled at `reachedAt`. */
const expectedMacProof = (deviceToken: string, nonce: string, reachedAt: string) => hmac(deviceToken, `aasc-mac:${nonce}:${reachedAt}`);

const NONCE = 'a1'.repeat(32);
const AT = '192.168.1.57:3334';
const STRANGER_TAG = 'b2'.repeat(32);

describe('deviceAuth.macProof', () => {
  let epoch: string | null;
  let auth: ReturnType<typeof createDeviceAuth>;

  beforeEach(() => {
    epoch = 'epoch-1';
    auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => epoch });
  });

  function phone(status: 'pending' | 'active'): { deviceId: string; deviceToken: string } {
    const { code } = auth.createPairingCode();
    const redeemed = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
    if (status === 'active') auth.approve(redeemed.device.id);
    return { deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken };
  }

  it('uses the "aasc-mac:" and "aasc-who:" prefixes', () => {
    expect(MAC_PROOF_PREFIX).toBe('aasc-mac:');
    expect(WHO_TAG_PREFIX).toBe('aasc-who:');
  });

  it('finds the approved phone by its tag and proves its key over the address it was reached at', () => {
    phone('active'); // another phone, first in the list
    const p = phone('active');
    expect(auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, AT)).toBe(expectedMacProof(p.deviceToken, NONCE, AT));
  });

  it('binds the address: reached elsewhere (a relay), the proof is for that other address', () => {
    const p = phone('active');
    const viaRelay = auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, '192.168.1.57:3334');
    expect(viaRelay).not.toBe(expectedMacProof(p.deviceToken, NONCE, '192.168.1.66:3334'));
  });

  it('is never the sign-in proof for the same nonce', () => {
    const p = phone('active');
    expect(auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, AT)).not.toBe(proofForToken(p.deviceToken, NONCE));
  });

  it('cannot be used to sign in, even over a nonce the Mac issued', () => {
    const p = phone('active');
    const { nonce } = auth.createChallenge(p.deviceId);
    const forged = auth.macProof(tagFor(p.deviceToken, nonce), nonce, AT);
    expect(auth.exchange(p.deviceId, nonce, forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each([
    ['an unknown tag', () => ({ deviceId: '', deviceToken: 'never-paired-token' })],
    ['a pending phone', () => phone('pending')],
  ])('answers %s with a decoy of the same shape', (_label, make) => {
    const p = make();
    const answer = auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, AT);
    expect(answer).toMatch(/^[0-9a-f]{64}$/);
    expect(answer).not.toBe(expectedMacProof(p.deviceToken, NONCE, AT));
  });

  it('gives a stranger the same decoy for the same question, so asking twice reveals nothing', () => {
    expect(auth.macProof(STRANGER_TAG, NONCE, AT)).toBe(auth.macProof(STRANGER_TAG, NONCE, AT));
    expect(auth.macProof(STRANGER_TAG, NONCE, AT)).not.toBe(auth.macProof(STRANGER_TAG, 'c3'.repeat(32), AT));
  });

  it('vouches for no revoked phone', () => {
    const p = phone('active');
    auth.revoke(p.deviceId);
    expect(auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, AT)).not.toBe(expectedMacProof(p.deviceToken, NONCE, AT));
  });

  it('vouches for no phone paired under an older password', () => {
    const p = phone('active');
    epoch = 'epoch-2';
    expect(auth.macProof(tagFor(p.deviceToken, NONCE), NONCE, AT)).not.toBe(expectedMacProof(p.deviceToken, NONCE, AT));
  });
});

describe('POST /api/mobile/identify', () => {
  interface Res { status: number; body: Record<string, any> }
  let server: http.Server;
  let port: number;
  let passwordEnabled: boolean;
  let failures: Map<string, number>;
  let auth: ReturnType<typeof createDeviceAuth>;

  beforeEach(async () => {
    passwordEnabled = true;
    failures = new Map();
    auth = createDeviceAuth({ store: memoryStore() });
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth,
      isPasswordEnabled: () => passwordEnabled,
      pairingOffered: () => true,
      requireSession: (_req, _res, next) => next(),
      createSessionToken: (id) => `session-for-${id}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
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

  function identify(body: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/identify',
        headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  function activePhone(): { deviceId: string; deviceToken: string } {
    const { code } = auth.createPairingCode();
    const redeemed = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
    auth.approve(redeemed.device.id);
    return { deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken };
  }

  it('answers with the Mac\'s proof over the address the request reached', async () => {
    const p = activePhone();
    const res = await identify({ tag: tagFor(p.deviceToken, NONCE), nonce: NONCE });
    expect(res.status).toBe(200);
    expect(res.body.data.proof).toBe(expectedMacProof(p.deviceToken, NONCE, `127.0.0.1:${port}`));
  });

  it('answers an unknown tag like a known one, with a proof that fails', async () => {
    const res = await identify({ tag: STRANGER_TAG, nonce: NONCE });
    expect(res.status).toBe(200);
    expect(res.body.data.proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['a nonce that is not 64 hex characters', { tag: STRANGER_TAG, nonce: 'abc' }],
    ['a base64url sign-in nonce', { tag: STRANGER_TAG, nonce: 'nonce-abcdefghijklmnopqrstuvwx' }],
    ['a nonce carrying a prefix', { tag: STRANGER_TAG, nonce: `aasc-mac:${'a'.repeat(55)}` }],
    ['a tag that is not 64 hex characters', { tag: 'not-a-tag', nonce: NONCE }],
    ['a device id instead of a tag', { deviceId: '6f1c2a10-0000-4000-8000-00000000dead', nonce: NONCE }],
    ['an extra field', { tag: STRANGER_TAG, nonce: NONCE, proof: 'x' }],
  ])('refuses %s (400)', async (_label, body) => {
    expect((await identify(body)).status).toBe(400);
  });

  it('is refused when no dashboard password is set', async () => {
    passwordEnabled = false;
    const res = await identify({ tag: STRANGER_TAG, nonce: NONCE });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
  });

  it('refuses cross-site browser requests', async () => {
    const res = await identify({ tag: STRANGER_TAG, nonce: NONCE }, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('is closed to an address the login limiter locked out', async () => {
    failures.set('127.0.0.1', 5);
    const res = await identify({ tag: STRANGER_TAG, nonce: NONCE });
    expect(res.status).toBe(429);
  });

  it('costs no login strike, whatever the tag', async () => {
    await identify({ tag: STRANGER_TAG, nonce: NONCE });
    await identify({ tag: tagFor(activePhone().deviceToken, NONCE), nonce: NONCE });
    expect(failures.size).toBe(0);
  });
});

// AASC listens on every interface ('::'), so an IPv4 request's local address arrives as ::ffff:a.b.c.d.
describe('POST /api/mobile/identify on a dual-stack listener', () => {
  it('signs over the plain IPv4 address the phone dialled', async () => {
    const auth = createDeviceAuth({ store: memoryStore() });
    const { code } = auth.createPairingCode();
    const redeemed = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
    auth.approve(redeemed.device.id);
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth, isPasswordEnabled: () => true, pairingOffered: () => true,
      requireSession: (_req, _res, next) => next(), createSessionToken: (id) => `s-${id}`, sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: null, tailnet: null }),
      rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
    }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, r)); // no host: '::', as server/index.ts
    const { port } = server.address() as AddressInfo;
    try {
      const payload = JSON.stringify({ tag: tagFor(redeemed.deviceToken, NONCE), nonce: NONCE });
      const proof = await new Promise<string>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/identify',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => resolve(JSON.parse(raw).data.proof));
        });
        req.on('error', reject);
        req.end(payload);
      });
      expect(proof).toBe(expectedMacProof(redeemed.deviceToken, NONCE, `127.0.0.1:${port}`));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
