// fakeMac.ts — a pretend Mac and backend for development builds and tests (AASC-17).
//
// Answers the same routes as server/mobile/mobileRouter.ts and the backend's
// device pairing, with the same status codes, and checks the device proof the
// way the Mac does. Never bundled into a release build: only platform/dev.ts
// (development mode) and the tests import it.
import type { HttpMethod, HttpRequest, HttpRequester } from '../http.js';
import { deviceProof, type HttpClient, type HttpResponse } from '../pairingClient.js';

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
}

export interface FakeCall {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

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
  const devices = new Map<string, Device>();
  const nonces = new Map<string, string>();
  const calls: FakeCall[] = [];
  const issued: string[] = [];
  let code = opts.code ?? 'K7Q2M9XPZT';
  let codeUsed = false;
  const backendHost = opts.backendHost ?? 'api.aasc.work';
  let backendTargets = 0;

  const ok = (status: number, data: unknown): HttpResponse => ({ status, data });
  const issue = (value: string) => {
    issued.push(value);
    return value;
  };

  async function macRoute(path: string, method: HttpMethod, body: Record<string, unknown>): Promise<HttpResponse> {
    if (method === 'GET' && path === '/api/auth/status') return ok(200, { passwordRequired: true, authenticated: false });
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
      if (!device || device.status === 'revoked' || !proven) return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_REVOKED' });
      device.attempts += 1;
      if (device.status === 'pending' && opts.denyAfter != null && device.attempts > opts.denyAfter) {
        devices.delete(id);
        return ok(401, { error: 'This phone is no longer paired', code: 'DEVICE_UNKNOWN' });
      }
      if (device.status === 'pending' && opts.approveAfter != null && device.attempts > opts.approveAfter) device.status = 'active';
      if (device.status === 'pending') return ok(403, { error: 'Approve this phone on your Mac first', code: 'DEVICE_PENDING' });
      return ok(200, { success: true, data: { token: issue(`sess-${randomHex(16)}`), expiresIn: 3600 } });
    }
    if (path === '/api/mobile/unpair') {
      if (!device || !proven) return ok(401, { error: 'This phone is not paired', code: 'DEVICE_UNKNOWN' });
      device.status = 'revoked';
      return ok(200, { success: true });
    }
    return ok(404, { error: 'Not found' });
  }

  function backendRoute(path: string, method: HttpMethod): HttpResponse {
    if (method === 'POST' && path === '/v1/devices/pair') {
      return ok(201, { success: true, data: { deviceId: `be-${randomHex(4)}`, token: issue(randomHex(32)) } });
    }
    if (method === 'DELETE' && path === '/v1/push/targets/self') {
      backendTargets += 1;
      return ok(200, { success: true });
    }
    return ok(404, { error: { code: 'not_found' } });
  }

  async function handle(req: HttpRequest): Promise<HttpResponse> {
    calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body });
    const url = new URL(req.url);
    if (url.protocol === 'https:' && url.host === backendHost) return backendRoute(url.pathname, req.method);
    if (!reachable.has(url.origin)) throw new Error('network unreachable');
    return macRoute(url.pathname, req.method, (req.body ?? {}) as Record<string, unknown>);
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
  };
}

export type FakeMac = ReturnType<typeof createFakeMac>;
