// pairingClient.ts — the shell's calls to the Mac and the backend (AASC-17).
//
// Uses an injected HTTP client: on the phone it is Capacitor's native HTTP
// (no CORS, no cookies of its own); in tests it is a fake. Never follows
// redirects, never logs a token.
import type { PairingLink } from './pairingLink.js';

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
  | { status: 'revoked' }
  | { status: 'unreachable' }
  | { status: 'error'; message: string };

function field(data: unknown, path: string[]): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

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

/** Pair with the backend for push. Null when the QR carried no backend code. */
export async function pairWithBackend(
  http: HttpClient, link: PairingLink, label: string,
): Promise<{ deviceId: string; token: string } | null> {
  if (!link.backendHost || !link.backendCode) return null;
  const res = await http.post(`https://${link.backendHost}/v1/devices/pair`, { code: link.backendCode, name: label.slice(0, 128) });
  if (res.status !== 200 && res.status !== 201) throw new Error(`Backend pairing failed (${res.status})`);
  const token = field(res.data, ['data', 'token']);
  const deviceId = field(res.data, ['data', 'deviceId']);
  if (typeof token !== 'string' || typeof deviceId !== 'string') throw new Error('The backend sent an unexpected answer');
  return { deviceId, token };
}

/** Trade the device token for a one-hour session (the shell then sets the cookie). */
export async function openSession(http: HttpClient, origin: string, creds: MacCredentials): Promise<SessionResult> {
  let res: HttpResponse;
  try {
    res = await http.post(`${origin}/api/mobile/session`, creds);
  } catch {
    return { status: 'unreachable' };
  }
  if (res.status === 200) {
    const token = field(res.data, ['data', 'token']);
    return typeof token === 'string' ? { status: 'ok', token } : { status: 'error', message: 'Unexpected answer' };
  }
  const code = field(res.data, ['code']);
  if (res.status === 403 && code === 'DEVICE_PENDING') return { status: 'pending' };
  if (res.status === 401) return { status: 'revoked' };
  return { status: 'error', message: `Sign-in failed (${res.status})` };
}
