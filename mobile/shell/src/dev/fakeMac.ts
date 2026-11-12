// fakeMac.ts — a pretend Mac and backend for development builds and tests (AASC-17).
//
// Answers the same routes as server/mobile/mobileRouter.ts and the backend's
// device pairing, with the same status codes, and checks the device proof the
// way the Mac does. The backend code comes from the Mac to a signed-in phone
// (POST /api/mobile/backend-code, AASC-52) and is single use at the backend.
// The backend also answers GET /v1/mac-paths (AASC-60): the Macs on the owner's account, with the auth, module and
// scope checks in the order the real one runs them.
// Plan 17: the backend's account routes for a phone signed in with Google (fakeAccount.ts) and the
// Mac's POST /api/mobile/enroll, which redeems the ticket and seals the device token to the phone's
// key with WebCrypto over the address the request reached, as the real Mac does.
// Never bundled into a release build: only platform/dev.ts (development mode)
// and the tests import it.
import { b64urlDecode, b64urlEncode, enrollAad, enrollKey } from '../enrollCrypto.js';
import type { HttpMethod, HttpRequest, HttpRequester } from '../http.js';
import { createFakeAccount, type FakeAccountOptions } from './fakeAccount.js';
import { deviceProof, MAC_PROOF_PREFIX, PATHS_PROOF_PREFIX, WHO_TAG_PREFIX, type HttpClient, type HttpResponse } from '../pairingClient.js';

export type FakeDeviceStatus = 'pending' | 'active' | 'revoked';

export interface FakeMacOptions {
  /** Origins that answer, e.g. 'http://100.101.102.103:3333'. Others fail like a dead network. */
  reachable?: readonly string[];
  /** The Mac's one-time code (the `mc` of the link). */
  code?: string;
  /** Approve by itself after this many sign-in attempts; null never does. */
  approveAfter?: number | null;
  /** Deny by itself after this many sign-in attempts (the Mac's Deny button). */
  denyAfter?: number | null;
  confirmCode?: string;
  backendHost?: string;
  /** Does this Mac have a cloud connection (AASC-52)? Without one it answers NO_CLOUD. Default: yes. */
  cloud?: boolean;
  /** This Mac's own backend device id, sent with each backend code. */
  macDeviceId?: string | null;
  /**
   * Other AASC Macs on the network, e.g. 'http://192.168.1.30:3333': they answer the status probe
   * and /identify, but know none of this phone's keys (the LAN rescan must pass over them).
   */
  strangers?: readonly string[];
  /**
   * Boxes on the network that pass /identify on to this Mac (at its first reachable origin) and hand
   * back its answer: a proof for the Mac's own address, never theirs.
   */
  relays?: readonly string[];
  /** What GET /api/sessions lists to a signed-in phone (the sessions shared with it). */
  sessions?: ReadonlyArray<{ sessionId: string; status: string; title: string; lastActivityAt?: number }>;
  /**
   * The Tailscale address this Mac tells a signed-in phone in POST /api/mobile/paths (AASC-60). Absent or null:
   * none, as a Mac without Tailscale answers.
   */
  tailnetAnswer?: string | null;
  /** The port /paths reports. Absent: the port the request reached this Mac on, which is the Mac's own PORT. */
  pathsPort?: number;
  /** A box on the home network rewrote the /paths answer: its proof is not the Mac's, so it verifies for no address. */
  forgePaths?: boolean;
  /**
   * What the backend's GET /v1/mac-paths lists to a phone allowed to read it (AASC-60): the Macs on this owner's
   * account, each with the address its Mac published. Absent: a backend without the mac-paths module, which
   * answers 404.
   */
  cloudMacs?: ReadonlyArray<{ deviceId: string; tailnet: string; port: number }>;
  /**
   * The backend refuses `mac-paths:read`, so this Mac's phone codes fall back to push only: a backend device made
   * while this is set can't read the list and gets 403 (scopes are fixed when the device is made). A device made
   * earlier keeps what it had; `setCloudReadForbidden(false)` is the backend upgrade.
   */
  cloudReadForbidden?: boolean;
  /**
   * Plan 17: the AASC Cloud account a phone signs in to with Google. Absent: the owner's account lists this Mac
   * (`macDeviceId`, named Kason-MBP) at 100.101.102.103:3333.
   */
  account?: FakeAccountOptions;
  /** The Mac's "Let phones signed into my AASC Cloud account connect" setting (default on). */
  accountEnroll?: boolean;
  /**
   * Plan 17: how each stranger (by origin) answers POST /api/mobile/enroll. Default NOT_THIS_MAC (another owner's
   * Mac). FORGE: a box that seals a token of its own to the phone's key for the dialled address, without the ticket's
   * seal secret (it never had it).
   */
  strangerEnroll?: Readonly<Record<string, StrangerEnroll>>;
}

export type StrangerEnroll =
  | 'NOT_THIS_MAC' | 'ACCOUNT_ENROLL_OFF' | 'REMOTE_PASSWORD_REQUIRED' | 'RATE_LIMITED' | 'ENROLL_BUSY' | 'TOO_MANY_NEW_PHONES' | 'FORGE';

/** This fake Mac's own backend device id (a UUID, as the backend makes them). */
export const FAKE_MAC_DEVICE_ID = '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `host:port` as the Mac's socket sees it: the URL's port, or the scheme's default (80 / 443), which URL leaves out. */
export function socketAddress(url: URL): string {
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

/** The codes POST /api/mobile/enroll answers with, besides 201. */
export type FakeEnrollRefusal =
  | 'ACCOUNT_ENROLL_OFF' | 'NOT_THIS_MAC' | 'INVALID_TICKET' | 'PHONE_REVOKED' | 'CLOUD_UNAVAILABLE' | 'ENROLL_BUSY' | 'TOO_MANY_NEW_PHONES';
const ENROLL_STATUS: Record<FakeEnrollRefusal, number> = {
  ACCOUNT_ENROLL_OFF: 403, NOT_THIS_MAC: 409, INVALID_TICKET: 401, PHONE_REVOKED: 401, CLOUD_UNAVAILABLE: 502,
  ENROLL_BUSY: 429, TOO_MANY_NEW_PHONES: 429,
};
/** The Mac's Retry-After hint (seconds) on its two 429s. */
const ENROLL_RETRY_AFTER: Partial<Record<FakeEnrollRefusal, number>> = { ENROLL_BUSY: 5, TOO_MANY_NEW_PHONES: 120 };
const B64U43 = /^[A-Za-z0-9_-]{43}$/;
const PHONE_KEY = /^[A-Za-z0-9_-]{87}$/;
const ENROLL_FIELDS = ['label', 'macDeviceId', 'nonce', 'phoneKey', 'platform', 'ticket'];

export interface FakeCall {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** The native timeout the caller asked for, when it asked for one. */
  timeoutMs?: number;
}

/** When the fake's Macs published their addresses (the list's `updatedAt`). */
const PUBLISHED_AT = '2026-10-21T00:00:00.000Z';

interface Device {
  token: string;
  status: FakeDeviceStatus;
  confirmCode: string;
  attempts: number;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function uuid(): string {
  const h = randomHex(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function createFakeMac(opts: FakeMacOptions = {}) {
  const reachable = new Set(opts.reachable ?? []);
  const strangers = new Set(opts.strangers ?? []);
  const relays = new Set(opts.relays ?? []);
  const devices = new Map<string, Device>();
  const nonces = new Map<string, string>();
  const calls: FakeCall[] = [];
  const issued: string[] = [];
  let code = opts.code ?? 'K7Q2M9XPZT';
  let codeUsed = false;
  const backendHost = opts.backendHost ?? 'api.aasc.work';
  let backendTargets = 0;
  let cloud = opts.cloud ?? true;
  let backendDown = false;
  let backendHang = false;
  /** Holds the next backend request until released (tests: a redemption that outlives its sign-in). */
  let nextBackendHold: Promise<void> | null = null;
  /** The next backend code is redeemed by someone else before the phone (a sniffer on the LAN's plain HTTP). */
  let stealNextCode = false;
  /** Backend codes the Mac issued, and whether the backend has redeemed each. */
  const backendCodes = new Map<string, boolean>();
  /** Backend device tokens by device id, and the ids revoked. */
  const backendDevices = new Map<string, string>();
  const revokedBackend = new Set<string>();
  /** Does the backend refuse mac-paths:read right now (the Mac then issues push-only codes)? */
  let cloudReadForbidden = opts.cloudReadForbidden ?? false;
  /** The backend devices made without mac-paths:read, and the backend codes that make them. */
  const pushOnlyDevices = new Set<string>();
  const pushOnlyCodes = new Set<string>();
  /** Session tokens the Mac issued, each with the id of the phone it was issued to. */
  const sessionTokens = new Map<string, string>();
  /** Failed proofs, which the real Mac records against the phone's IP in its login limiter (5 per 15 min). */
  let strikes = 0;
  /** Items the phone appended to a queue: [sessionId, body]. */
  const queued: Array<[string, unknown]> = [];
  /** This Mac's own backend device (its cloud connection), which a ticket must name. */
  const thisMacDeviceId = opts.macDeviceId === undefined ? FAKE_MAC_DEVICE_ID : opts.macDeviceId;
  const account = createFakeAccount(backendHost, {
    macs: [{ deviceId: thisMacDeviceId ?? FAKE_MAC_DEVICE_ID, name: 'Kason-MBP', tailnet: '100.101.102.103', port: 3333, lastUsedAt: PUBLISHED_AT }],
    ...opts.account,
  }, (v) => {
    issued.push(v);
    return v;
  });
  let accountEnroll = opts.accountEnroll ?? true;
  /** The next POST /api/mobile/enroll answers this (tests: each refusal's message). */
  let forcedRefusal: FakeEnrollRefusal | null = null;
  /** Phones this Mac enrolled through the account (device ids). */
  const enrolled: string[] = [];

  const ok = (status: number, data: unknown): HttpResponse => ({ status, data });
  const issue = (value: string) => {
    issued.push(value);
    return value;
  };

  /** The routes a signed-in phone uses (Bearer session token, as the shell sends it). */
  function sessionRoute(path: string, method: HttpMethod, headers: Record<string, string>, body: unknown): HttpResponse | null {
    const queue = /^\/api\/sessions\/([^/]+)\/queue\/items$/.exec(path);
    const backendCode = method === 'POST' && path === '/api/mobile/backend-code';
    if (!(method === 'GET' && path === '/api/sessions') && !(method === 'POST' && queue) && !backendCode) return null;
    const token = (headers.Authorization ?? '').replace(/^Bearer /, '');
    if (!sessionTokens.has(token)) return ok(401, { error: 'Sign in first', code: 'NOT_SIGNED_IN' });
    if (backendCode) {
      if (!cloud) return ok(409, { error: 'This Mac isn’t connected to the AASC cloud', code: 'NO_CLOUD' });
      const code = issue(randomHex(16)); // 32 characters, inside the backend code's alphabet
      backendCodes.set(code, stealNextCode);
      if (cloudReadForbidden) pushOnlyCodes.add(code);
      stealNextCode = false;
      return ok(200, { success: true, data: { host: backendHost, code, macDeviceId: opts.macDeviceId === undefined ? FAKE_MAC_DEVICE_ID : opts.macDeviceId } });
    }
    const listed = opts.sessions ?? [];
    if (!queue) return ok(200, Object.fromEntries(listed.map((x) => [x.sessionId, x])));
    const id = decodeURIComponent(queue[1]);
    if (!listed.some((x) => x.sessionId === id && x.status !== 'ended')) return ok(404, { error: 'Not found' });
    queued.push([id, body]);
    return ok(200, { success: true, data: { paused: true } });
  }

  /** As deviceAuth.macProof: the approved phone whose key made `tag`, over the address the request reached; else random. */
  async function identify(body: Record<string, unknown>, reachedAt: string): Promise<HttpResponse> {
    const nonce = String(body.nonce);
    for (const device of devices.values()) {
      if (device.status !== 'active') continue;
      if (await deviceProof(device.token, `${WHO_TAG_PREFIX}${nonce}`) === body.tag) {
        return ok(200, { success: true, data: { proof: await deviceProof(device.token, `${MAC_PROOF_PREFIX}${nonce}:${reachedAt}`) } });
      }
    }
    return ok(200, { success: true, data: { proof: randomHex(32) } });
  }

  /**
   * As mobileRouter's POST /paths (AASC-60): a signed-in phone gets this Mac's Tailscale address (or none) and port,
   * signed with its own key over the nonce it chose. The gates run in the real order: JSON only, a well-formed
   * body, a live session (a missing one costs a login strike), then a phone this Mac still holds approved.
   */
  async function paths(body: Record<string, unknown>, headers: Record<string, string>, reachedAt: string): Promise<HttpResponse> {
    const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
    if (!/^application\/json\b/i.test(contentType)) return ok(415, { error: 'Expected application/json' });
    const nonce = body.nonce;
    if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce) || Object.keys(body).length !== 1) {
      return ok(400, { error: 'Invalid request' });
    }
    const deviceId = sessionTokens.get((headers.Authorization ?? '').replace(/^Bearer /, ''));
    if (!deviceId) {
      strikes += 1;
      return ok(401, { error: 'Sign in first', code: 'NOT_SIGNED_IN' });
    }
    const device = devices.get(deviceId);
    if (!device || device.status !== 'active') return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
    const tailnet = opts.tailnetAnswer ?? null;
    const port = opts.pathsPort ?? (Number(new URL(`http://${reachedAt}`).port) || 80);
    const proof = opts.forgePaths
      ? randomHex(32)
      : await deviceProof(device.token, `${PATHS_PROOF_PREFIX}${nonce}:${tailnet ?? '-'}:${port}`);
    return ok(200, { success: true, data: { tailnet, port, proof } });
  }

  const refuseEnroll = (code: FakeEnrollRefusal) => ok(ENROLL_STATUS[code], {
    error: code, code, ...(ENROLL_RETRY_AFTER[code] ? { retryAfter: ENROLL_RETRY_AFTER[code] } : {}),
  });

  /** As server/mobile/accountEnroll.ts behind POST /api/mobile/enroll (plan 17), in the same order. */
  async function enroll(body: Record<string, unknown>, reachedAt: string): Promise<HttpResponse> {
    const keys = Object.keys(body).sort();
    if (keys.join() !== ENROLL_FIELDS.join() || typeof body.macDeviceId !== 'string' || !UUID.test(body.macDeviceId)
      || typeof body.ticket !== 'string' || !B64U43.test(body.ticket)
      || typeof body.phoneKey !== 'string' || !PHONE_KEY.test(body.phoneKey)
      || typeof body.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(body.nonce)
      || typeof body.label !== 'string' || !body.label || (body.platform !== 'ios' && body.platform !== 'android')) {
      return ok(400, { error: 'Invalid request' });
    }
    const forced = forcedRefusal;
    forcedRefusal = null;
    if (!accountEnroll) return refuseEnroll('ACCOUNT_ENROLL_OFF');
    if (!cloud || !thisMacDeviceId || body.macDeviceId !== thisMacDeviceId) return refuseEnroll('NOT_THIS_MAC');
    if (forced) return refuseEnroll(forced);
    if (backendDown) return refuseEnroll('CLOUD_UNAVAILABLE');
    const redeemed = account.redeem(body.ticket, thisMacDeviceId);
    if (!redeemed.ok && redeemed.why === 'phone-revoked') return refuseEnroll('PHONE_REVOKED');
    const phoneRaw = b64urlDecode(body.phoneKey)!;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', phoneRaw))].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!redeemed.ok || hash !== redeemed.phoneKeyHash) {
      strikes += 1;
      return refuseEnroll('INVALID_TICKET');
    }
    const deviceId = uuid();
    const deviceToken = issue(randomHex(32));
    devices.set(deviceId, { token: deviceToken, status: 'active', confirmCode: '000000', attempts: 0 });
    enrolled.push(deviceId);
    return ok(201, { success: true, data: await sealFor(phoneRaw, body.nonce, reachedAt, redeemed.sealSecret, { deviceId, deviceToken }) });
  }

  /**
   * The seal (plan 17, C1): an ephemeral Mac key, ECDH with the phone's, HKDF over ECDH ‖ the ticket's seal secret
   * with both points in `info`, AES-256-GCM with the address reached in the AAD.
   */
  async function sealFor(
    phoneRaw: Uint8Array<ArrayBuffer>, nonce: string, reachedAt: string, sealSecret: string, creds: { deviceId: string; deviceToken: string },
  ): Promise<{ macKey: string; iv: string; sealed: string }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']) as CryptoKeyPair;
    const macKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const key = await enrollKey(pair.privateKey, phoneRaw, nonce, { sealSecret: b64urlDecode(sealSecret)!, phoneKeyRaw: phoneRaw, macKeyRaw: macKey }, 'encrypt');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const at = reachedAt.lastIndexOf(':');
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(enrollAad(nonce, reachedAt.slice(0, at), Number(reachedAt.slice(at + 1)))), tagLength: 128 },
      key, new TextEncoder().encode(JSON.stringify(creds)),
    );
    return { macKey: b64urlEncode(macKey), iv: b64urlEncode(iv), sealed: b64urlEncode(new Uint8Array(sealed)) };
  }

  /** A stranger's answer to POST /api/mobile/enroll (opts.strangerEnroll). */
  async function strangerEnroll(origin: string, body: Record<string, unknown>, reachedAt: string): Promise<HttpResponse> {
    switch (opts.strangerEnroll?.[origin] ?? 'NOT_THIS_MAC') {
      case 'NOT_THIS_MAC': return refuseEnroll('NOT_THIS_MAC');
      case 'ACCOUNT_ENROLL_OFF': return refuseEnroll('ACCOUNT_ENROLL_OFF');
      case 'REMOTE_PASSWORD_REQUIRED': return ok(403, { error: 'Set a dashboard password first', code: 'REMOTE_PASSWORD_REQUIRED' });
      case 'RATE_LIMITED': return ok(429, { error: 'Too many attempts. Try again later.', retryAfter: 60 });
      case 'ENROLL_BUSY': return refuseEnroll('ENROLL_BUSY');
      case 'TOO_MANY_NEW_PHONES': return refuseEnroll('TOO_MANY_NEW_PHONES');
      case 'FORGE': {
        const phoneRaw = typeof body.phoneKey === 'string' ? b64urlDecode(body.phoneKey) : null;
        if (!phoneRaw || typeof body.nonce !== 'string') return ok(400, { error: 'Invalid request' });
        const own = { deviceId: uuid(), deviceToken: randomHex(32) }; // the box's own token, which it could then watch
        return ok(201, { success: true, data: await sealFor(phoneRaw, body.nonce, reachedAt, b64urlEncode(crypto.getRandomValues(new Uint8Array(32))), own) });
      }
    }
  }

  /** `reachedAt` as /identify and /paths have always read it (url.host); `socketAt` with the default port filled in (enroll). */
  async function macRoute(
    path: string, method: HttpMethod, body: Record<string, unknown>, headers: Record<string, string> = {}, reachedAt = '', socketAt = reachedAt,
  ): Promise<HttpResponse> {
    if (method === 'GET' && path === '/api/auth/status') return ok(200, { passwordRequired: true, authenticated: false });
    const signedIn = sessionRoute(path, method, headers, body);
    if (signedIn) return signedIn;
    if (method === 'POST' && path === '/api/mobile/paths') return paths(body, headers, reachedAt);
    if (method !== 'POST') return ok(404, { error: 'Not found' });
    if (path === '/api/mobile/pair') {
      if (codeUsed || body.code !== code) return ok(401, { error: 'Pairing code is wrong or expired', code: 'INVALID_PAIRING_CODE' });
      codeUsed = true;
      const deviceId = uuid();
      const confirmCode = opts.confirmCode ?? String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
      const token = issue(randomHex(32));
      devices.set(deviceId, { token, status: 'pending', confirmCode, attempts: 0 });
      return ok(201, { success: true, data: { deviceId, deviceToken: token, confirmCode, status: 'pending' } });
    }
    if (path === '/api/mobile/identify') return identify(body, reachedAt);
    if (path === '/api/mobile/enroll') return enroll(body, socketAt);
    if (path === '/api/mobile/challenge') {
      const nonce = randomHex(16);
      nonces.set(nonce, String(body.deviceId));
      return ok(200, { success: true, data: { nonce, expiresAt: Date.now() + 60_000 } });
    }
    const id = String(body.deviceId);
    const device = devices.get(id);
    const nonceFor = nonces.get(String(body.nonce));
    nonces.delete(String(body.nonce));
    const proven = device && nonceFor === id && body.proof === (await deviceProof(device.token, String(body.nonce)));
    if (path === '/api/mobile/session') {
      // As deviceAuth.exchange: an unproven key is "invalid" (a strike, DEVICE_UNKNOWN); a proven revoked one isn't.
      if (!device || !proven) {
        strikes += 1;
        return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      if (device.status === 'revoked') return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_REVOKED' });
      device.attempts += 1;
      if (device.status === 'pending' && opts.denyAfter != null && device.attempts > opts.denyAfter) {
        devices.delete(id);
        return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      if (device.status === 'pending' && opts.approveAfter != null && device.attempts > opts.approveAfter) device.status = 'active';
      if (device.status === 'pending') return ok(403, { error: 'Approve this phone on your Mac first', code: 'DEVICE_PENDING' });
      const token = issue(`sess-${randomHex(16)}`);
      sessionTokens.set(token, id);
      return ok(200, { success: true, data: { token, expiresIn: 3600 } });
    }
    if (path === '/api/mobile/unpair') {
      if (!device || !proven || device.status === 'revoked') {
        strikes += 1;
        return ok(401, { error: 'This phone is not paired', code: 'DEVICE_UNKNOWN' });
      }
      device.status = 'revoked';
      return ok(200, { success: true });
    }
    return ok(404, { error: 'Not found' });
  }

  /** Someone else's AASC: it answers like a Mac but has never seen this phone. */
  function strangerRoute(path: string, method: HttpMethod): HttpResponse {
    if (method === 'GET' && path === '/api/auth/status') return ok(200, { passwordRequired: true, authenticated: false });
    if (method === 'POST' && path === '/api/mobile/identify') return ok(200, { success: true, data: { proof: randomHex(32) } });
    if (method === 'POST' && path === '/api/mobile/challenge') return ok(200, { success: true, data: { nonce: randomHex(16) } });
    return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
  }

  /**
   * As the backend's mac-paths router (aasc-backend: auth, then the route map, then the scope): a token it doesn't know
   * or has revoked is 401, a backend without the module 404, a device made without mac-paths:read 403, else the list.
   */
  function macPathsRoute(device: string | undefined): HttpResponse {
    if (!device || revokedBackend.has(device)) return ok(401, { success: false, error: { code: 'unauthorized' } });
    if (!opts.cloudMacs) return ok(404, { success: false, error: { code: 'not_found' } });
    if (pushOnlyDevices.has(device)) return ok(403, { success: false, error: { code: 'forbidden' } });
    return ok(200, { success: true, data: { macs: opts.cloudMacs.map((m) => ({ ...m, name: 'Mac', updatedAt: PUBLISHED_AT })) } });
  }

  async function backendRoute(path: string, method: HttpMethod, headers: Record<string, string>, body: Record<string, unknown>): Promise<HttpResponse> {
    if (backendDown) throw new Error('backend unreachable');
    const accountAnswer = await account.route(path, method, headers, body);
    if (accountAnswer) return accountAnswer;
    if (method === 'POST' && path === '/v1/devices/pair') {
      const code = String(body.code ?? '');
      if (backendCodes.get(code) !== false) return ok(401, { success: false, error: { code: 'invalid_pairing_code' } });
      backendCodes.set(code, true);
      const deviceId = `be-${randomHex(4)}`;
      const token = issue(randomHex(32));
      backendDevices.set(deviceId, token);
      if (pushOnlyCodes.has(code)) pushOnlyDevices.add(deviceId);
      return ok(201, { success: true, data: { deviceId, token } });
    }
    const bearerToken = (headers.Authorization ?? '').replace(/^Bearer /, '');
    const device = [...backendDevices.entries()].find(([, t]) => t === bearerToken)?.[0];
    if (method === 'GET' && path === '/v1/mac-paths') return macPathsRoute(device);
    if (path === '/v1/push/targets/self' && (!device || revokedBackend.has(device))) {
      return ok(401, { success: false, error: { code: 'unauthorized' } });
    }
    if (method === 'PUT' && path === '/v1/push/targets/self') return ok(200, { success: true, data: { targetId: `t-${device}` } });
    if (method === 'DELETE' && path === '/v1/push/targets/self') {
      backendTargets += 1;
      return ok(200, { success: true });
    }
    return ok(404, { error: { code: 'not_found' } });
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body, timeoutMs: req.timeoutMs });
    const url = new URL(req.url);
    if (url.protocol === 'https:' && url.host === backendHost) {
      if (backendHang) return new Promise<HttpResponse>(() => undefined); // a cloud that never answers
      const hold = nextBackendHold;
      nextBackendHold = null;
      if (hold) await hold;
      return backendRoute(url.pathname, req.method, req.headers ?? {}, (req.body ?? {}) as Record<string, unknown>);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (relays.has(url.origin) && req.method === 'POST' && url.pathname === '/api/mobile/identify') {
      const mac = [...reachable][0];
      return mac ? identify(body, new URL(mac).host) : strangerRoute(url.pathname, req.method);
    }
    // Plan 17: a relay passes the enrollment on too; the Mac seals for the address it was reached at, not the relay's.
    if (relays.has(url.origin) && req.method === 'POST' && url.pathname === '/api/mobile/enroll') {
      const mac = [...reachable][0];
      return mac ? enroll(body, socketAddress(new URL(mac))) : strangerRoute(url.pathname, req.method);
    }
    // Plan 17: another owner's Mac, or a box (opts.strangerEnroll), before any backend call.
    if (strangers.has(url.origin) && req.method === 'POST' && url.pathname === '/api/mobile/enroll') {
      return strangerEnroll(url.origin, body, socketAddress(url));
    }
    if (strangers.has(url.origin) || relays.has(url.origin)) return strangerRoute(url.pathname, req.method);
    if (!reachable.has(url.origin)) throw new Error('network unreachable');
    return macRoute(url.pathname, req.method, body, req.headers ?? {}, url.host, socketAddress(url));
  }

  const http: HttpClient = {
    post: (url, body) => handle({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body }),
  };
  const requester: HttpRequester = { request: handle };

  const only = (): [string, Device] | undefined => [...devices.entries()].at(-1);

  /** A phone this Mac already knows (development seeds and tests). */
  function seedDevice(status: FakeDeviceStatus): { deviceId: string; deviceToken: string } {
    const deviceId = uuid();
    const deviceToken = issue(randomHex(32));
    devices.set(deviceId, { token: deviceToken, status, confirmCode: '482913', attempts: 0 });
    return { deviceId, deviceToken };
  }

  return {
    http,
    requester,
    calls,
    /** Every secret this fake handed out (device, backend and session tokens). */
    issued,
    devices,
    queued,
    seedDevice,
    setReachable(origins: readonly string[]) {
      reachable.clear();
      origins.forEach((o) => reachable.add(o));
    },
    /** A fresh code, as "Pair a phone" makes on the Mac. */
    newCode(next: string) {
      code = next;
      codeUsed = false;
    },
    /** The Mac's devices panel: Allow / Deny / Revoke on the newest phone. */
    approve() {
      const d = only();
      if (d) d[1].status = 'active';
    },
    deny() {
      const d = only();
      if (d) devices.delete(d[0]);
    },
    revoke() {
      const d = only();
      if (d) d[1].status = 'revoked';
    },
    pushTargetsRemoved: () => backendTargets,
    /** Failed device proofs so far (the Mac's login limiter locks the phone out at 5). */
    strikes: () => strikes,
    /** The Mac gets (or loses) its cloud connection. */
    setCloud(on: boolean) {
      cloud = on;
    },
    /** The backend stops (or starts) answering: refused at once. */
    setBackendDown(down: boolean) {
      backendDown = down;
    },
    /** The backend hangs: requests never come back. */
    setBackendHang(hang: boolean) {
      backendHang = hang;
    },
    /** The next backend request waits until the returned function is called; later ones don't. */
    holdNextBackendRequest(): () => void {
      let release!: () => void;
      nextBackendHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    /** Someone else redeems the next backend code the Mac issues before the phone can. */
    stealNextBackendCode() {
      stealNextCode = true;
    },
    /** Every backend code the Mac issued, oldest first. */
    backendCodes: () => [...backendCodes.keys()],
    /**
     * A backend device this phone redeemed earlier (tests): its credential, as the vault keeps it. Made without
     * mac-paths:read when the backend refuses it right now, unless `pushOnly` says otherwise.
     */
    seedBackendDevice(seed: { pushOnly?: boolean } = {}): { host: string; deviceId: string; token: string } {
      const deviceId = `be-${randomHex(4)}`;
      const token = issue(randomHex(32));
      backendDevices.set(deviceId, token);
      if (seed.pushOnly ?? cloudReadForbidden) pushOnlyDevices.add(deviceId);
      return { host: backendHost, deviceId, token };
    },
    /** The backend starts (or stops) refusing mac-paths:read: only the codes the Mac issues from now on are affected. */
    setCloudReadForbidden(forbidden: boolean) {
      cloudReadForbidden = forbidden;
    },
    /** Plan 17: the owner's AASC Cloud account (Google codes, account devices, tickets, the Mac list). */
    account,
    /** Where the sign-in sheet lands after Google for this start URL (null: the backend refuses it). */
    googleRedirect: (startUrl: string) => account.googleRedirect(startUrl),
    /** The Mac's account-enroll setting. */
    setAccountEnroll(on: boolean) {
      accountEnroll = on;
    },
    /** The next POST /api/mobile/enroll that gets past the setting and the Mac check answers `code`. */
    refuseNextEnroll(code: FakeEnrollRefusal | null) {
      forcedRefusal = code;
    },
    /** Phones this Mac enrolled through the account, oldest first. */
    enrolled: () => [...enrolled],
    /** Revoke a backend device, as "Remove them" on the Mac or the owner CLI would. */
    revokeBackendDevice(deviceId: string) {
      revokedBackend.add(deviceId);
    },
  };
}

export type FakeMac = ReturnType<typeof createFakeMac>;
