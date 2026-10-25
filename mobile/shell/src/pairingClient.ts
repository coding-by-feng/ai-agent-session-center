// pairingClient.ts — the shell's calls to the Mac and the backend (AASC-17).
//
// Uses an injected HTTP client: on the phone it is Capacitor's native HTTP
// (no CORS, no cookies of its own); in tests it is a fake. Never follows
// redirects, never logs a token.
//
// After pairing, the device token never travels again: signing in answers a
// single-use server nonce with HMAC-SHA256(key = SHA-256(token), nonce), so a
// sniffed exchange on the home network can't be replayed.
import { isBackendHost, isTailnetAddress, type PairingLink } from './pairingLink.js';
import { errorCode, field, jsonHeaders, type HttpRequester } from './http.js';

export interface HttpResponse {
  status: number;
  data: unknown;
}

export interface HttpClient {
  post(url: string, body: unknown): Promise<HttpResponse>;
}

export interface MacCredentials {
  deviceId: string;
  deviceToken: string;
}

export interface MacPairing extends MacCredentials {
  confirmCode: string;
}

export type SessionResult =
  | { status: 'ok'; token: string }
  | { status: 'pending' }
  /** `verified`: the Mac checked this key's proof before refusing it (DEVICE_REVOKED), so the key is that Mac's own,
   *  dropped; otherwise it doesn't know the key (DEVICE_UNKNOWN), and the failed proof cost a login-limit strike. */
  | { status: 'revoked'; verified?: boolean }
  | { status: 'unreachable' }
  | { status: 'error'; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function pairWithMac(
  http: HttpClient, origin: string, link: PairingLink, label: string, platform: 'ios' | 'android',
): Promise<MacPairing> {
  const res = await http.post(`${origin}/api/mobile/pair`, { code: link.macCode, label, platform });
  if (res.status !== 201) {
    const reason = field(res.data, ['code']);
    throw new Error(reason === 'INVALID_PAIRING_CODE' ? 'The pairing code expired. Show a new QR on your Mac.' : `Pairing failed (${res.status})`);
  }
  const deviceId = field(res.data, ['data', 'deviceId']);
  const deviceToken = field(res.data, ['data', 'deviceToken']);
  const confirmCode = field(res.data, ['data', 'confirmCode']);
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)
    || typeof deviceToken !== 'string' || deviceToken.length < 20
    || typeof confirmCode !== 'string' || !/^\d{6}$/.test(confirmCode)) {
    throw new Error('The Mac sent an unexpected answer');
  }
  return { deviceId, deviceToken, confirmCode };
}

const BACKEND_CODE = /^[A-Za-z0-9_-]{16,64}$/;
const MAC_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type BackendCodeResult =
  | { status: 'ok'; host: string; code: string; macDeviceId: string | null }
  /** The Mac has no cloud connection: Mac only, nothing to say. */
  | { status: 'no-cloud' }
  /** Anything else (offline, refused, too soon): asked again at the next sign-in. */
  | { status: 'unavailable' };

/**
 * AASC-52: ask the Mac that just allowed this phone for its backend code, over
 * the session it signed in with. Never throws; the code stays in memory only.
 */
export async function requestBackendCode(http: HttpRequester, origin: string, sessionToken: string): Promise<BackendCodeResult> {
  let res: HttpResponse;
  try {
    res = await http.request({ method: 'POST', url: `${origin}/api/mobile/backend-code`, headers: jsonHeaders(sessionToken), body: {} });
  } catch {
    return { status: 'unavailable' };
  }
  if (res.status === 409 && errorCode(res.data) === 'NO_CLOUD') return { status: 'no-cloud' };
  if (res.status !== 200) return { status: 'unavailable' };
  const host = field(res.data, ['data', 'host']);
  const code = field(res.data, ['data', 'code']);
  const macDeviceId = field(res.data, ['data', 'macDeviceId']);
  if (typeof host !== 'string' || !isBackendHost(host) || typeof code !== 'string' || !BACKEND_CODE.test(code)) {
    return { status: 'unavailable' };
  }
  return { status: 'ok', host, code, macDeviceId: typeof macDeviceId === 'string' && MAC_DEVICE_ID.test(macDeviceId) ? macDeviceId : null };
}

/** Redeem the backend code a Mac issued, for this phone's own backend device (push). */
export async function pairWithBackend(
  http: HttpClient, host: string, code: string, label: string,
): Promise<{ deviceId: string; token: string }> {
  if (!isBackendHost(host) || !BACKEND_CODE.test(code)) throw new Error('Not an AASC backend code');
  const res = await http.post(`https://${host}/v1/devices/pair`, { code, name: label.slice(0, 128) });
  if (res.status !== 200 && res.status !== 201) throw new Error(`Backend pairing failed (${res.status})`);
  const token = field(res.data, ['data', 'token']);
  const deviceId = field(res.data, ['data', 'deviceId']);
  if (typeof token !== 'string' || typeof deviceId !== 'string') throw new Error('The backend sent an unexpected answer');
  return { deviceId, token };
}

/** HMAC-SHA256(SHA-256(deviceToken), nonce) as hex, with WebCrypto (the Mac computes the same). */
export async function deviceProof(deviceToken: string, nonce: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(deviceToken));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(nonce));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** = server/mobile/deviceAuth.ts: the phone names itself with its key over WHO_TAG_PREFIX + nonce (never its id). */
export const WHO_TAG_PREFIX = 'aasc-who:';
/** = server/mobile/deviceAuth.ts: the Mac's proof is over this + nonce + ':' + the address it was reached at. */
export const MAC_PROOF_PREFIX = 'aasc-mac:';
/** = server/mobile/deviceAuth.ts: the Mac's /paths proof is over this + nonce + ':' + its Tailscale address ('-' for none) + ':' + its port. */
export const PATHS_PROOF_PREFIX = 'aasc-paths:';

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Same length and characters, compared without stopping at the first difference. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is the AASC at `origin` the Mac this phone paired with? It must prove it
 * holds this phone's key over a nonce the phone just chose and over `origin`'s
 * own address, as the Mac saw the request arrive (POST /identify,
 * deviceAuth.macProof): a box that passes the question on to the real Mac gets
 * a proof for the Mac's address, not its own. The phone names itself by a tag
 * that changes with every nonce, never its device id. Anyone can answer on the
 * port, so the LAN rescan saves or opens an address only once this is true.
 * False for any failure.
 */
export async function verifyMac(http: HttpClient, origin: string, creds: MacCredentials): Promise<boolean> {
  const nonce = randomNonce();
  const { hostname, port } = new URL(origin);
  let res: HttpResponse;
  try {
    const tag = await deviceProof(creds.deviceToken, `${WHO_TAG_PREFIX}${nonce}`);
    res = await http.post(`${origin}/api/mobile/identify`, { tag, nonce });
  } catch {
    return false;
  }
  const proof = field(res.data, ['data', 'proof']);
  if (res.status !== 200 || typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return sameHex(proof, await deviceProof(creds.deviceToken, `${MAC_PROOF_PREFIX}${nonce}:${hostname}:${port || '80'}`));
}

/** How long opening a Mac waits for its Tailscale address (POST /api/mobile/paths, AASC-60) before going on without it. */
export const PATHS_BUDGET_MS = 3_000;

/** What a Mac says of its own addresses (POST /paths): its Tailscale address, if it has one, and the port it listens on. */
export interface MacPaths {
  tailnet: string | null;
  port: number;
}

/**
 * Ask the Mac this phone just signed in to for its Tailscale address (POST /api/mobile/paths, AASC-60), over the
 * session it opened. The answer crosses the home network's plain HTTP, where a box could rewrite it, so it counts
 * only with the Mac's proof: the phone's key over PATHS_PROOF_PREFIX, a nonce the phone just chose, the address
 * ('-' for none) and the port, worked out here and compared without stopping at the first difference. Anything
 * else (a refusal, a malformed answer, an address outside Tailscale's 100.64.0.0/10, a proof that doesn't match)
 * is null: nothing is saved. Ask once per sign-in and never again after a failure: each call without a valid
 * session costs a login strike on the Mac. Never throws.
 */
export async function fetchMacPaths(
  http: HttpRequester, origin: string, sessionToken: string, creds: MacCredentials,
): Promise<MacPaths | null> {
  try {
    const nonce = randomNonce();
    const res = await http.request({
      method: 'POST', url: `${origin}/api/mobile/paths`, headers: jsonHeaders(sessionToken), body: { nonce },
      // Cancelled with the page's own wait (shellFlows), not left running to the native 15 s.
      timeoutMs: PATHS_BUDGET_MS,
    });
    if (res.status !== 200) return null;
    const tailnet = field(res.data, ['data', 'tailnet']);
    const port = field(res.data, ['data', 'port']);
    const proof = field(res.data, ['data', 'proof']);
    if (tailnet !== null && (typeof tailnet !== 'string' || !isTailnetAddress(tailnet))) return null;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof proof !== 'string' || !/^[0-9a-f]{64}$/.test(proof)) return null;
    const expected = await deviceProof(creds.deviceToken, `${PATHS_PROOF_PREFIX}${nonce}:${tailnet ?? '-'}:${port}`);
    return sameHex(proof, expected) ? { tailnet, port } : null;
  } catch {
    return null;
  }
}

/**
 * A sign-in nonce as the Mac issues them (base64url, the Mac's DeviceProof
 * schema). Signing nothing else keeps a sign-in proof from ever being a Mac
 * proof (MAC_PROOF_PREFIX has a ':'), whoever answers at the address.
 */
const SIGN_IN_NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** Ask the Mac for a nonce and answer it: the body for /session or /unpair. */
async function provenRequest(http: HttpClient, origin: string, creds: MacCredentials): Promise<{ deviceId: string; nonce: string; proof: string }> {
  const challenge = await http.post(`${origin}/api/mobile/challenge`, { deviceId: creds.deviceId });
  const nonce = field(challenge.data, ['data', 'nonce']);
  if (challenge.status !== 200 || typeof nonce !== 'string' || !SIGN_IN_NONCE.test(nonce)) throw new Error(`Challenge failed (${challenge.status})`);
  return { deviceId: creds.deviceId, nonce, proof: await deviceProof(creds.deviceToken, nonce) };
}

/** Prove the device token for a one-hour session (the shell then sets the cookie). */
export async function openSession(http: HttpClient, origin: string, creds: MacCredentials): Promise<SessionResult> {
  let res: HttpResponse;
  try {
    res = await http.post(`${origin}/api/mobile/session`, await provenRequest(http, origin, creds));
  } catch {
    return { status: 'unreachable' };
  }
  if (res.status === 200) {
    const token = field(res.data, ['data', 'token']);
    return typeof token === 'string' ? { status: 'ok', token } : { status: 'error', message: 'Unexpected answer' };
  }
  const code = field(res.data, ['code']);
  if (res.status === 403 && code === 'DEVICE_PENDING') return { status: 'pending' };
  if (res.status === 401) return { status: 'revoked', verified: code === 'DEVICE_REVOKED' };
  return { status: 'error', message: `Sign-in failed (${res.status})` };
}

/** The phone removes itself from the Mac (the Mac revokes its backend device too). */
export async function unpairSelf(http: HttpClient, origin: string, creds: MacCredentials): Promise<boolean> {
  try {
    const res = await http.post(`${origin}/api/mobile/unpair`, await provenRequest(http, origin, creds));
    return res.status === 200;
  } catch {
    return false;
  }
}
