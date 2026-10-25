// test/mobilePaths.test.ts — the Mac tells a signed-in phone its Tailscale address, with a key proof (AASC-60, Remote access).
//
// A phone away from home asks the Mac "what is your Tailscale address?" over a session it already holds. The answer
// crosses the home network's plain HTTP, where anything can rewrite it, so the Mac signs it: the phone picks a nonce
// (64 hex characters) and gets back the address (or null when the Mac has none) and the port with
//   HMAC-SHA256(SHA-256(device token), "aasc-paths:" + nonce + ":" + (address or "-") + ":" + port)
// and saves the address only if it recomputes the same value. The prefix keeps this apart from a sign-in proof (the Mac's
// base64url nonces, no prefix) and from the LAN rescan's "aasc-who:" / "aasc-mac:" messages. The Mac also remembers, in
// memory only, how each phone last signed in (home network or Tailscale) and the address it last sent that phone.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createHash } from 'node:crypto';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { bearerSession, createToken } from '../server/authManager.js';
import {
  createDeviceAuth, PATHS_PROOF_PREFIX, proofForToken, type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';
import { createMobileRouter, type MobileRouterDeps } from '../server/mobile/mobileRouter.js';
import { createPairingTarget } from '../server/mobile/pairingTarget.js';
import { createPhonePathLog } from '../server/mobile/phonePathLog.js';
import { createTailscaleProbe } from '../server/tailscaleStatus.js';

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

/** What the phone computes: HMAC-SHA256 keyed with the SHA-256 of its device token, hex. */
function hmac(deviceToken: string, message: string): string {
  const key = createHash('sha256').update(deviceToken).digest();
  return createHmac('sha256', key).update(message).digest('hex');
}

/** The LAN rescan's name for a phone (never part of /paths): its key over the "aasc-who:" nonce. */
const tagFor = (deviceToken: string, nonce: string) => hmac(deviceToken, `aasc-who:${nonce}`);

const N64 = 'a1'.repeat(32);
const TAILNET = '100.101.102.103';
const MAC_PORT = 3334;
const NO_PATHS = { lastPath: null, lastPathAt: null, tailnetSent: null, tailnetSentAt: null };

type Auth = ReturnType<typeof createDeviceAuth>;

function pairPhone(auth: Auth, approve = true): { deviceId: string; deviceToken: string } {
  const { code } = auth.createPairingCode();
  const redeemed = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
  if (approve) auth.approve(redeemed.device.id);
  return { deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken };
}

describe('deviceAuth.pathsProof', () => {
  let epoch: string | null;
  let auth: Auth;

  beforeEach(() => {
    epoch = 'epoch-1';
    auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => epoch });
  });

  it('uses the "aasc-paths:" prefix', () => {
    expect(PATHS_PROOF_PREFIX).toBe('aasc-paths:');
  });

  it('proves the phone’s key over the nonce, the Tailscale address and the port', () => {
    pairPhone(auth); // another phone, first in the list
    const p = pairPhone(auth);
    expect(auth.pathsProof(p.deviceId, N64, TAILNET, MAC_PORT)).toBe(hmac(p.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`));
  });

  it('writes "-" when the Mac has no Tailscale address', () => {
    const p = pairPhone(auth);
    expect(auth.pathsProof(p.deviceId, N64, null, MAC_PORT)).toBe(hmac(p.deviceToken, `aasc-paths:${N64}:-:3334`));
  });

  it('binds the nonce, the address and the port: change any one and the proof changes', () => {
    const p = pairPhone(auth);
    const base = auth.pathsProof(p.deviceId, N64, TAILNET, MAC_PORT);
    const others = [
      auth.pathsProof(p.deviceId, 'b2'.repeat(32), TAILNET, MAC_PORT),
      auth.pathsProof(p.deviceId, N64, '100.101.102.104', MAC_PORT),
      auth.pathsProof(p.deviceId, N64, TAILNET, 3333),
      auth.pathsProof(p.deviceId, N64, null, MAC_PORT),
    ];
    for (const proof of [base, ...others]) expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([base, ...others]).size).toBe(5);
  });

  it('is null for an unknown id, a pending phone, a revoked phone, and one paired under an older password', () => {
    expect(auth.pathsProof('6f1c2a10-0000-4000-8000-00000000dead', N64, TAILNET, MAC_PORT)).toBeNull();
    expect(auth.pathsProof(pairPhone(auth, false).deviceId, N64, TAILNET, MAC_PORT)).toBeNull();
    const revoked = pairPhone(auth);
    auth.revoke(revoked.deviceId);
    expect(auth.pathsProof(revoked.deviceId, N64, TAILNET, MAC_PORT)).toBeNull();
    const older = pairPhone(auth);
    expect(auth.pathsProof(older.deviceId, N64, TAILNET, MAC_PORT)).not.toBeNull();
    epoch = 'epoch-2';
    expect(auth.pathsProof(older.deviceId, N64, TAILNET, MAC_PORT)).toBeNull();
  });

  it('cannot be used to sign in, even over a nonce the Mac issued', () => {
    const p = pairPhone(auth);
    const { nonce } = auth.createChallenge(p.deviceId);
    const forged = auth.pathsProof(p.deviceId, nonce, TAILNET, MAC_PORT)!;
    expect(auth.exchange(p.deviceId, nonce, forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('pathsProof never equals macProof or a sign-in proof for the same nonce', () => {
    const p = pairPhone(auth);
    const paths = auth.pathsProof(p.deviceId, N64, TAILNET, MAC_PORT)!;
    const mac = auth.macProof(tagFor(p.deviceToken, N64), N64, `${TAILNET}:${MAC_PORT}`);
    const signIn = proofForToken(p.deviceToken, N64);
    const who = tagFor(p.deviceToken, N64);
    expect(mac).toBe(hmac(p.deviceToken, `aasc-mac:${N64}:100.101.102.103:3334`)); // a real macProof, not a decoy
    expect(new Set([paths, mac, signIn, who]).size).toBe(4);
  });
});

describe('createPhonePathLog', () => {
  it('knows nothing about a phone it has not heard from', () => {
    expect(createPhonePathLog().view('nobody')).toEqual(NO_PATHS);
  });

  it.each([
    ['100.101.102.103', 'tailnet'],
    ['100.64.0.1', 'tailnet'],
    ['100.127.255.254', 'tailnet'],
    ['100.63.255.255', 'lan'],
    ['100.128.0.1', 'lan'],
    ['192.168.1.20', 'lan'],
    ['10.0.0.7', 'lan'],
    ['127.0.0.1', 'lan'],
  ])('records a sign-in that reached %s as %s', (address, path) => {
    const log = createPhonePathLog(() => 42);
    log.signedIn('phone-1', address);
    expect(log.view('phone-1')).toEqual({ ...NO_PATHS, lastPath: path, lastPathAt: 42 });
  });

  it('keeps what a phone was last sent apart from how it last signed in', () => {
    let t = 100;
    const log = createPhonePathLog(() => t);
    log.signedIn('phone-1', '192.168.1.20');
    t = 200;
    log.sent('phone-1', TAILNET);
    expect(log.view('phone-1')).toEqual({ lastPath: 'lan', lastPathAt: 100, tailnetSent: TAILNET, tailnetSentAt: 200 });
    t = 300;
    log.signedIn('phone-1', '100.64.0.9'); // the newest sign-in wins and leaves the sent address alone
    expect(log.view('phone-1')).toEqual({ lastPath: 'tailnet', lastPathAt: 300, tailnetSent: TAILNET, tailnetSentAt: 200 });
    t = 400;
    log.sent('phone-1', '100.64.0.10');
    expect(log.view('phone-1')).toEqual({ lastPath: 'tailnet', lastPathAt: 300, tailnetSent: '100.64.0.10', tailnetSentAt: 400 });
  });

  it('keeps one phone’s entry apart from another’s', () => {
    const log = createPhonePathLog(() => 7);
    log.signedIn('phone-1', TAILNET);
    log.sent('phone-2', '100.64.0.9');
    expect(log.view('phone-1')).toEqual({ ...NO_PATHS, lastPath: 'tailnet', lastPathAt: 7 });
    expect(log.view('phone-2')).toEqual({ ...NO_PATHS, tailnetSent: '100.64.0.9', tailnetSentAt: 7 });
  });

  it('hands out copies, so a caller cannot rewrite the log', () => {
    const log = createPhonePathLog(() => 7);
    log.signedIn('phone-1', TAILNET);
    const seen = log.view('phone-1');
    seen.lastPath = 'lan';
    seen.tailnetSent = 'tampered';
    (log.view('nobody') as { lastPath: string | null }).lastPath = 'lan';
    expect(log.view('phone-1')).toEqual({ ...NO_PATHS, lastPath: 'tailnet', lastPathAt: 7 });
    expect(log.view('nobody')).toEqual(NO_PATHS);
  });
});

describe('POST /api/mobile/paths', () => {
  interface Res { status: number; body: Record<string, any> }
  interface PostOptions { bearer?: string; headers?: Record<string, string> }

  let server: http.Server;
  let port: number;
  let routerDeps: MobileRouterDeps;
  let passwordEnabled: boolean;
  let failures: Map<string, number>;
  let epoch: string | null;
  let clock: number;
  let macTarget: { tailnet: string | null; port: number };
  /** This Mac's address on the request's socket: a loopback test socket can pretend to be reached over Tailscale. */
  let localAddress: string | null;
  let auth: Auth;
  let pathLog: ReturnType<typeof createPhonePathLog>;

  beforeEach(async () => {
    passwordEnabled = true;
    failures = new Map();
    epoch = 'epoch-1';
    clock = 1_000_000;
    macTarget = { tailnet: TAILNET, port: MAC_PORT };
    localAddress = null;
    auth = createDeviceAuth({ store: memoryStore(), now: () => clock, credentialEpoch: () => epoch });
    pathLog = createPhonePathLog(() => clock);
    routerDeps = {
      deviceAuth: auth,
      isPasswordEnabled: () => passwordEnabled,
      requireSession: (_req, _res, next) => next(),
      createSessionToken: (deviceId) => `session-for-${deviceId}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: macTarget.port, lan: '192.168.1.20', tailnet: macTarget.tailnet }),
      rateLimit: {
        check: (ip) => ((failures.get(ip) ?? 0) >= 5 ? 900 : 0),
        record: (ip) => { failures.set(ip, (failures.get(ip) ?? 0) + 1); },
        clear: (ip) => { failures.delete(ip); },
      },
      sessionOf: (req) => {
        const header = String(req.headers.authorization ?? '');
        if (header === 'Bearer desktop-session') return { deviceId: null }; // a password sign-in (a browser)
        const m = /^Bearer session-for-(.+)$/.exec(header);
        return m ? { deviceId: m[1] } : null;
      },
      pathLog,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Set or restore on every request: a kept-alive socket would otherwise carry the last test's address.
      if (localAddress) Object.defineProperty(req.socket, 'localAddress', { value: localAddress, configurable: true });
      else delete (req.socket as { localAddress?: string }).localAddress;
      next();
    });
    app.use('/api/mobile', createMobileRouter(routerDeps));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function post(path: string, body: unknown, opts: PostOptions = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path, agent: false,
        headers: {
          host: `localhost:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(opts.bearer && { authorization: `Bearer ${opts.bearer}` }),
          ...opts.headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          // A route that does not exist answers Express's HTML 404: report the status instead of hanging on a parse error.
          let body: Record<string, any> = {};
          try { body = raw ? JSON.parse(raw) : {}; } catch { body = { notJson: raw.slice(0, 80) }; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  const session = (deviceId: string) => `session-for-${deviceId}`;
  const asks = (deviceId: string, body: unknown = { nonce: N64 }, headers?: Record<string, string>) =>
    post('/api/mobile/paths', body, { bearer: session(deviceId), headers });
  const strikes = () => [...failures.values()].reduce((sum, n) => sum + n, 0);

  /** A phone signs in the way the app does: a challenge, then its key's proof of the nonce. */
  async function signIn(p: { deviceId: string; deviceToken: string }, proof?: string): Promise<Res> {
    const challenge = await post('/api/mobile/challenge', { deviceId: p.deviceId });
    const nonce = challenge.body.data.nonce as string;
    return post('/api/mobile/session', { deviceId: p.deviceId, nonce, proof: proof ?? proofForToken(p.deviceToken, nonce) });
  }

  it('answers the Mac’s Tailscale address with a proof over nonce, address and port', async () => {
    const p = pairPhone(auth);
    const res = await post('/api/mobile/paths', { nonce: N64 }, { bearer: session(p.deviceId) });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      tailnet: '100.101.102.103', port: 3334, proof: hmac(p.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`),
    });
  });

  it('waits for a pairing target that is still being worked out, and signs what it names', async () => {
    const p = pairPhone(auth);
    routerDeps.pairingTarget = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { name: 'Test-Mac', port: MAC_PORT, lan: '192.168.1.20', tailnet: TAILNET };
    };
    const res = await asks(p.deviceId);
    expect(res.body.data).toEqual({
      tailnet: TAILNET, port: 3334, proof: hmac(p.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`),
    });
  });

  it('signs the Tailscale probe’s address, not the 100.64.0.0/10 interface WARP or Meshnet holds', async () => {
    const p = pairPhone(auth);
    const WARP = '100.96.0.7';
    const probe = createTailscaleProbe({
      platform: 'darwin',
      exists: async (path) => path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      run: async () => ({ stdout: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: [TAILNET] } }) }),
      interfaceAddress: () => WARP,
    });
    routerDeps.pairingTarget = createPairingTarget({ name: () => 'Test-Mac', port: MAC_PORT, lan: () => null, probe });
    const res = await asks(p.deviceId);
    expect(res.body.data.tailnet).toBe(TAILNET);
    expect(res.body.data.proof).toBe(hmac(p.deviceToken, `aasc-paths:${N64}:${TAILNET}:3334`));
    expect(res.body.data.proof).not.toBe(hmac(p.deviceToken, `aasc-paths:${N64}:${WARP}:3334`));
    expect(pathLog.view(p.deviceId).tailnetSent).toBe(TAILNET);
  });

  it('answers each phone with its own key’s proof', async () => {
    const a = pairPhone(auth);
    const b = pairPhone(auth);
    const forA = (await asks(a.deviceId)).body.data.proof;
    const forB = (await asks(b.deviceId)).body.data.proof;
    expect(forA).toBe(hmac(a.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`));
    expect(forB).toBe(hmac(b.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`));
    expect(forA).not.toBe(forB);
  });

  it('writes "-" for a Mac without a Tailscale address', async () => {
    const p = pairPhone(auth);
    macTarget.tailnet = null;
    const res = await asks(p.deviceId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ tailnet: null, port: 3334, proof: hmac(p.deviceToken, `aasc-paths:${N64}:-:3334`) });
  });

  it('401 NOT_SIGNED_IN without a phone session, and records a login strike', async () => {
    const none = await post('/api/mobile/paths', { nonce: N64 });
    expect([none.status, none.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
    expect(none.body.data).toBeUndefined();
    expect(strikes()).toBe(1);
    const unknown = await post('/api/mobile/paths', { nonce: N64 }, { bearer: 'not-a-session' });
    expect([unknown.status, unknown.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
    expect(strikes()).toBe(2);
  });

  it('403 NOT_A_PHONE for a password session', async () => {
    const res = await post('/api/mobile/paths', { nonce: N64 }, { bearer: 'desktop-session' });
    expect([res.status, res.body.code]).toEqual([403, 'NOT_A_PHONE']);
    expect(res.body.data).toBeUndefined();
    expect(strikes()).toBe(0);
  });

  it('401 DEVICE_UNKNOWN for a revoked phone or one from an older password', async () => {
    const revoked = pairPhone(auth);
    auth.revoke(revoked.deviceId);
    const r = await asks(revoked.deviceId);
    expect([r.status, r.body.code]).toEqual([401, 'DEVICE_UNKNOWN']);
    expect(r.body.data).toBeUndefined();
    const older = pairPhone(auth);
    epoch = 'epoch-2';
    const o = await asks(older.deviceId);
    expect([o.status, o.body.code]).toEqual([401, 'DEVICE_UNKNOWN']);
    expect(o.body.data).toBeUndefined();
  });

  it('also 401 DEVICE_UNKNOWN for a phone nobody approved, or a session whose phone is gone', async () => {
    const pending = await asks(pairPhone(auth, false).deviceId);
    expect([pending.status, pending.body.code]).toEqual([401, 'DEVICE_UNKNOWN']);
    const gone = await asks('6f1c2a10-0000-4000-8000-00000000dead');
    expect([gone.status, gone.body.code]).toEqual([401, 'DEVICE_UNKNOWN']);
    expect(pending.body.data ?? gone.body.data).toBeUndefined();
  });

  it('400 for a nonce that is not 64 hex characters, or an extra key', async () => {
    const p = pairPhone(auth);
    const cases: Array<[string, unknown]> = [
      ['no nonce', {}],
      ['an empty body array', []],
      ['a short nonce', { nonce: 'abc' }],
      ['63 hex characters', { nonce: 'a'.repeat(63) }],
      ['65 hex characters', { nonce: 'a'.repeat(65) }],
      ['upper-case hex', { nonce: 'A'.repeat(64) }],
      ['a base64url sign-in nonce', { nonce: 'nonce-abcdefghijklmnopqrstuvwx' }],
      ['a prefixed nonce', { nonce: `aasc-paths:${'a'.repeat(53)}` }],
      ['a number', { nonce: 1234 }],
      ['an address to sign', { nonce: N64, tailnet: '100.64.0.9' }],
      ['a port to sign', { nonce: N64, port: 1 }],
      ['a device id', { nonce: N64, deviceId: p.deviceId }],
    ];
    for (const [label, body] of cases) {
      const res = await asks(p.deviceId, body);
      expect([label, res.status]).toEqual([label, 400]);
      expect(res.body.data).toBeUndefined();
    }
    expect(pathLog.view(p.deviceId)).toEqual(NO_PATHS);
  });

  it('403 cross-site, 415 non-JSON, 403 REMOTE_PASSWORD_REQUIRED without a password', async () => {
    const p = pairPhone(auth);
    const crossSite = await asks(p.deviceId, { nonce: N64 }, { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.data).toBeUndefined();
    const notJson = await asks(p.deviceId, { nonce: N64 }, { 'content-type': 'text/plain' });
    expect(notJson.status).toBe(415);
    expect(notJson.body.data).toBeUndefined();
    passwordEnabled = false;
    const noPassword = await asks(p.deviceId);
    expect([noPassword.status, noPassword.body.code]).toEqual([403, 'REMOTE_PASSWORD_REQUIRED']);
    expect(noPassword.body.data).toBeUndefined();
    expect(pathLog.view(p.deviceId)).toEqual(NO_PATHS);
  });

  it('is closed to an address the login limiter locked out', async () => {
    const p = pairPhone(auth);
    failures.set('127.0.0.1', 5);
    const res = await asks(p.deviceId);
    expect(res.status).toBe(429);
    expect(res.body.data).toBeUndefined();
  });

  it('path log: a sign-in that reached a 100.x local address records tailnet; 192.168.x records lan', async () => {
    const p = pairPhone(auth);
    localAddress = '100.101.102.103';
    expect((await signIn(p)).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual({ ...NO_PATHS, lastPath: 'tailnet', lastPathAt: clock });
    clock += 5_000;
    localAddress = '192.168.1.20';
    expect((await signIn(p)).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual({ ...NO_PATHS, lastPath: 'lan', lastPathAt: clock });
    clock += 5_000;
    localAddress = '::ffff:100.101.102.103'; // how the dual-stack listener reports an IPv4 connection
    expect((await signIn(p)).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual({ ...NO_PATHS, lastPath: 'tailnet', lastPathAt: clock });
    clock += 5_000;
    localAddress = null; // the loopback test socket itself: not Tailscale
    expect((await signIn(p)).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual({ ...NO_PATHS, lastPath: 'lan', lastPathAt: clock });
  });

  describe('warming the pairing target at sign-in (R27)', () => {
    // /paths awaits the Tailscale probe, whose 5 s cache is usually cold at a sign-in; asking for it as soon as the phone
    // is in lets the /paths call a moment later find it warm, instead of the phone's 3 s budget racing a cold CLI.
    it('a successful sign-in asks for the target once, without waiting for it', async () => {
      const target = vi.fn(() => new Promise<never>(() => undefined)); // never answers: a handler that waited would hang
      routerDeps.pairingTarget = target;
      const p = pairPhone(auth);
      const res = await signIn(p);
      expect(res.status).toBe(200);
      expect(res.body.data.token).toBe(`session-for-${p.deviceId}`);
      expect(target).toHaveBeenCalledTimes(1);
    });

    it('a failed, pending or revoked sign-in does not ask', async () => {
      const target = vi.fn(async () => ({ name: 'Test-Mac', port: MAC_PORT, lan: null, tailnet: TAILNET }));
      routerDeps.pairingTarget = target;
      const wrong = pairPhone(auth);
      expect((await signIn(wrong, 'f'.repeat(64))).status).toBe(401);
      expect((await signIn(pairPhone(auth, false))).status).toBe(403);
      const revoked = pairPhone(auth);
      auth.revoke(revoked.deviceId);
      expect((await signIn(revoked)).status).toBe(401);
      // A rescan question or a request for the address is not a sign-in either.
      expect((await post('/api/mobile/challenge', { deviceId: wrong.deviceId })).status).toBe(200);
      expect(target).not.toHaveBeenCalled();
    });

    it('a target that throws or rejects cannot fail the sign-in or leave a rejection behind', async () => {
      const p = pairPhone(auth);
      routerDeps.pairingTarget = async () => {
        throw new Error('probe broke');
      };
      expect((await signIn(p)).status).toBe(200);
      routerDeps.pairingTarget = () => {
        throw new Error('broke before it could answer');
      };
      expect((await signIn(p)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 10)); // a rejection nobody caught would surface as an unhandled error here
    });
  });

  it('path log: a sign-in that failed, or was only a rescan question, records nothing', async () => {
    const p = pairPhone(auth);
    const pending = pairPhone(auth, false);
    localAddress = '100.101.102.103';
    expect((await signIn(p, 'f'.repeat(64))).status).toBe(401); // wrong proof
    expect((await signIn(pending)).status).toBe(403); // not approved yet
    expect((await post('/api/mobile/identify', { tag: tagFor(p.deviceToken, N64), nonce: N64 })).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual(NO_PATHS);
    expect(pathLog.view(pending.deviceId)).toEqual(NO_PATHS);
  });

  it('path log: /paths records the address it sent, and nothing when there was none', async () => {
    const p = pairPhone(auth);
    macTarget.tailnet = null;
    expect((await asks(p.deviceId)).status).toBe(200);
    expect(pathLog.view(p.deviceId)).toEqual(NO_PATHS);
    macTarget.tailnet = TAILNET;
    clock += 1_000;
    expect((await asks(p.deviceId)).status).toBe(200);
    // Asking is not signing in: the way the phone last connected stays unknown.
    expect(pathLog.view(p.deviceId)).toEqual({ ...NO_PATHS, tailnetSent: TAILNET, tailnetSentAt: clock });
  });

  it('path log: an answer that was refused records nothing', async () => {
    const revoked = pairPhone(auth);
    auth.revoke(revoked.deviceId);
    expect((await asks(revoked.deviceId)).status).toBe(401);
    expect((await post('/api/mobile/paths', { nonce: N64 }, { bearer: 'desktop-session' })).status).toBe(403);
    expect(pathLog.view(revoked.deviceId)).toEqual(NO_PATHS);
  });

  it('works on a Mac that keeps no path log', async () => {
    routerDeps.pathLog = undefined;
    const p = pairPhone(auth);
    expect((await asks(p.deviceId)).status).toBe(200);
    expect((await signIn(p)).status).toBe(200);
  });

  // The phone's HttpOnly cookie lives in the shell's WebView next to the dashboard page, so a script in that page
  // could send it. Like /backend-code, the route reads the shell's own Bearer header only (the real lookup here).
  it('takes the phone from its Bearer session only: never the cookie or ?token=', async () => {
    routerDeps.sessionOf = bearerSession;
    const a = pairPhone(auth);
    const b = pairPhone(auth);
    const tokenA = createToken(a.deviceId);
    const tokenB = createToken(b.deviceId);
    const cookieOnly = await post('/api/mobile/paths', { nonce: N64 }, { headers: { cookie: `auth_token=${tokenA}` } });
    expect([cookieOnly.status, cookieOnly.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
    const queryOnly = await post(`/api/mobile/paths?token=${tokenA}`, { nonce: N64 });
    expect([queryOnly.status, queryOnly.body.code]).toEqual([401, 'NOT_SIGNED_IN']);
    const mixed = await post('/api/mobile/paths', { nonce: N64 }, { bearer: tokenB, headers: { cookie: `auth_token=${tokenA}` } });
    expect(mixed.status).toBe(200);
    expect(mixed.body.data.proof).toBe(hmac(b.deviceToken, `aasc-paths:${N64}:100.101.102.103:3334`));
  });
});
