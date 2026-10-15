// test/phonePairingCloud.test.ts — AASC-51: one pairing gives a phone both the Mac and the cloud, and one
// revoke on the Mac cuts both.
//
// The pairing QR carries the Mac's code and a phone-scoped backend code minted alongside it. The phone
// redeems each half separately and never tells the Mac which backend device it became (the shell sends
// { code, label, platform } only). So the Mac must remember which backend code it put in the QR next to
// which Mac code, and revoke the backend device that code created when the phone is revoked, denied or
// unpairs itself. Over real sockets, with the same onRevoked the server wires (phoneRevocation.ts) and a
// fake cloud connector standing in for the backend.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { createPhoneCloudBridge, PHONE_BACKEND_SCOPES } from '../server/mobile/phoneCloudBridge.js';
import { createPhoneRevokedHandler } from '../server/mobile/phoneRevocation.js';
import type { CloudConnector, CloudStatus } from '../server/cloud/types.js';

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

/** A backend that mints phone codes and creates one phone device per redeemed code. */
function fakeBackend() {
  const calls: string[] = [];
  const minted: Array<{ code: string; codeRef: string }> = [];
  /** Backend devices: what a phone gets by redeeming a backend code (the shell does that itself). */
  const devices: Array<{ id: string; kind: 'phone'; createdByCode: string; revokedAt: string | null }> = [];
  const backend = { state: 'connected' as CloudStatus['state'], fail: false };
  const cloud = {
    client: {
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push(`${method} ${path}`);
        if (backend.fail) throw Object.assign(new Error('down'), { code: 'offline' });
        if (method === 'POST' && path === '/v1/devices/pairing-codes') {
          expect(body).toEqual({ kind: 'phone', scopes: [...PHONE_BACKEND_SCOPES], ttlSeconds: 600 });
          const n = minted.length + 1;
          const code = { code: `${'B'.repeat(21)}${n}`, codeRef: `00000000-0000-4000-8000-00000000000${n}` };
          minted.push(code);
          return { ...code, expiresAt: '2026-10-16T00:10:00.000Z' } as T;
        }
        if (method === 'GET' && path === '/v1/devices') return { devices, nextCursor: null } as T;
        const del = /^\/v1\/devices\/([\w-]+)$/.exec(path);
        if (method === 'DELETE' && del) {
          const device = devices.find((d) => d.id === del[1]);
          if (device) device.revokedAt = '2026-10-16T00:00:00.000Z';
          return { revoked: true } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
    status: (): CloudStatus => ({
      state: backend.state,
      lastError: null,
      connection: { backendOrigin: 'https://api.aasc.work', accountId: 'acct', deviceId: 'mac-device-1', deviceName: 'Mac', generation: 1 },
    }),
  } as unknown as CloudConnector;
  /** The phone redeeming the QR's backend half: the backend makes a device created by that code. */
  const redeemBackendCode = (code: string): string => {
    const ref = minted.find((m) => m.code === code)?.codeRef;
    if (!ref) throw new Error('unknown backend code');
    const id = `phone-be-${devices.length + 1}`;
    devices.push({ id, kind: 'phone', createdByCode: ref, revokedAt: null });
    return id;
  };
  return { cloud, calls, devices, backend, redeemBackendCode };
}

interface Res { status: number; body: Record<string, any> }

let server: http.Server;
let port: number;
let be: ReturnType<typeof fakeBackend>;
const warn = vi.fn();
const revokeTokens = vi.fn();
const disconnect = vi.fn();
let pendingRevokes: Promise<void>[];
let store: MobileDeviceStore;

beforeEach(async () => {
  be = fakeBackend();
  warn.mockClear();
  revokeTokens.mockClear();
  disconnect.mockClear();
  pendingRevokes = [];
  const bridge = createPhoneCloudBridge({ cloud: be.cloud, warn });
  const onRevoked = createPhoneRevokedHandler({
    revokeTokens,
    disconnect,
    // Kept so a test can wait for the backend half, which index.ts lets run on its own.
    revokeBackend: (codeRef) => {
      const p = bridge.revokeBackendPhone(codeRef);
      pendingRevokes.push(p);
      return p;
    },
    info: vi.fn(),
  });
  store = memoryStore();
  const deviceAuth = createDeviceAuth({ store, onRevoked });
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
    mintBackendCode: () => bridge.mintBackendCode(),
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function call(method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
      headers: {
        host: `localhost:${port}`,
        ...(payload !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
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

/** Scan the QR: pair with the Mac exactly as the shell does, and redeem the backend half with the backend. */
async function scanQr(extra: Record<string, unknown> = {}): Promise<{ deviceId: string; deviceToken: string; backendDevice: string }> {
  const pairing = await call('POST', '/pairing', {});
  expect(pairing.status).toBe(200);
  expect(pairing.body.data.backendIncluded).toBe(true);
  const params = new URLSearchParams(String(pairing.body.data.link).split('#')[1]);
  expect(params.get('be')).toBe('api.aasc.work');
  expect(params.get('md')).toBe('mac-device-1');
  // The backend code's ref is the Mac's to remember: it is never in the QR.
  expect(String(pairing.body.data.link)).not.toContain('00000000-0000-4000-8000');
  const pair = await call('POST', '/pair', { code: params.get('mc'), label: 'Kason iPhone', platform: 'ios', ...extra });
  expect(pair.status).toBe(201);
  const backendDevice = be.redeemBackendCode(params.get('bc')!);
  return { deviceId: pair.body.data.deviceId, deviceToken: pair.body.data.deviceToken, backendDevice };
}

const settle = () => Promise.all(pendingRevokes);
const deletes = () => be.calls.filter((c) => c.startsWith('DELETE'));

describe('one pairing, one revoke (AASC-51)', () => {
  it('revoking the phone on the Mac ends its Mac sessions and revokes its backend device', async () => {
    const phone = await scanQr();
    expect((await call('POST', `/devices/${phone.deviceId}/approve`, {})).status).toBe(200);
    expect((await call('DELETE', `/devices/${phone.deviceId}`)).status).toBe(200);
    await settle();
    expect(revokeTokens).toHaveBeenCalledWith(phone.deviceId);
    expect(disconnect).toHaveBeenCalledWith(phone.deviceId);
    expect(deletes()).toEqual([`DELETE /v1/devices/${phone.backendDevice}`]);
    expect(be.devices.find((d) => d.id === phone.backendDevice)?.revokedAt).not.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('denying a pending phone revokes the backend device it already made', async () => {
    const phone = await scanQr();
    expect((await call('DELETE', `/devices/${phone.deviceId}`)).status).toBe(200);
    await settle();
    expect(deletes()).toEqual([`DELETE /v1/devices/${phone.backendDevice}`]);
  });

  it('a phone that unpairs itself leaves no backend device behind', async () => {
    const phone = await scanQr();
    await call('POST', `/devices/${phone.deviceId}/approve`, {});
    const challenge = await call('POST', '/challenge', { deviceId: phone.deviceId });
    const nonce = challenge.body.data.nonce as string;
    const unpair = await call('POST', '/unpair', { deviceId: phone.deviceId, nonce, proof: proofForToken(phone.deviceToken, nonce) });
    expect(unpair.status).toBe(200);
    await settle();
    expect(deletes()).toEqual([`DELETE /v1/devices/${phone.backendDevice}`]);
  });

  it('revokes only the backend device of THIS phone, whatever a phone claims at /pair', async () => {
    const first = await scanQr();
    // A second phone names the first phone's backend code: the Mac goes by what it minted for this QR.
    const second = await scanQr({ beCodeRef: '00000000-0000-4000-8000-000000000001' });
    await call('POST', `/devices/${second.deviceId}/approve`, {});
    await call('DELETE', `/devices/${second.deviceId}`);
    await settle();
    expect(deletes()).toEqual([`DELETE /v1/devices/${second.backendDevice}`]);
    expect(be.devices.find((d) => d.id === first.backendDevice)?.revokedAt).toBeNull();
  });

  it('still revokes the backend device right after the Mac restarts (connection saved, not yet checked)', async () => {
    const phone = await scanQr();
    await call('POST', `/devices/${phone.deviceId}/approve`, {});
    be.backend.state = 'offline';
    await call('DELETE', `/devices/${phone.deviceId}`);
    await settle();
    expect(deletes()).toEqual([`DELETE /v1/devices/${phone.backendDevice}`]);
  });

  it('a backend that can’t be reached never blocks the Mac revoke, and says what to do', async () => {
    const phone = await scanQr();
    await call('POST', `/devices/${phone.deviceId}/approve`, {});
    be.backend.fail = true;
    expect((await call('DELETE', `/devices/${phone.deviceId}`)).status).toBe(200);
    await settle();
    expect(revokeTokens).toHaveBeenCalledWith(phone.deviceId);
    expect(warn.mock.calls.at(-1)?.[0]).toMatch(/owner revoke/);
  });

  it('a phone paired before AASC-51 never revokes the backend device its own /pair named; Mac-bound ones still do', async () => {
    const first = await scanQr();
    // A row from before the fix: its codeRef is whatever that phone sent at /pair, here the first phone's.
    const legacy = '7d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a';
    store.insert({
      id: legacy, label: 'Old phone', platform: 'android', tokenHash: 'f'.repeat(64), status: 'active', confirmCode: '123456',
      beCodeRef: '00000000-0000-4000-8000-000000000001', beCodeRefMacBound: false,
      credentialEpoch: null, createdAt: 1, approvedAt: 2, lastSeenAt: null, revokedAt: null,
    });
    expect((await call('DELETE', `/devices/${legacy}`)).status).toBe(200);
    await settle();
    expect(revokeTokens).toHaveBeenCalledWith(legacy);
    expect(disconnect).toHaveBeenCalledWith(legacy);
    expect(be.calls.filter((c) => c.startsWith('GET') || c.startsWith('DELETE'))).toEqual([]);
    expect(be.devices.find((d) => d.id === first.backendDevice)?.revokedAt).toBeNull();
    await call('POST', `/devices/${first.deviceId}/approve`, {});
    await call('DELETE', `/devices/${first.deviceId}`);
    await settle();
    expect(deletes()).toEqual([`DELETE /v1/devices/${first.backendDevice}`]);
  });

  it('a phone paired while the Mac had no cloud connection has nothing to revoke there', async () => {
    be.backend.state = 'disconnected';
    const pairing = await call('POST', '/pairing', {});
    expect(pairing.body.data.backendIncluded).toBe(false);
    const params = new URLSearchParams(String(pairing.body.data.link).split('#')[1]);
    const pair = await call('POST', '/pair', { code: params.get('mc'), label: 'Phone', platform: 'android' });
    await call('DELETE', `/devices/${pair.body.data.deviceId}`);
    await settle();
    expect(be.calls.filter((c) => !c.startsWith('POST'))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('createPhoneRevokedHandler', () => {
  const record = (over: Partial<MobileDeviceRecord>): MobileDeviceRecord => ({
    id: 'p1', label: 'Phone', platform: 'ios', tokenHash: 'a'.repeat(64), status: 'revoked', confirmCode: '000000',
    beCodeRef: 'ref-1', beCodeRefMacBound: true, credentialEpoch: null, createdAt: 1, approvedAt: null, lastSeenAt: null, revokedAt: 3,
    ...over,
  });
  it('hands the backend revoke a codeRef only when the Mac bound it', () => {
    const revokeBackend = vi.fn(async () => {});
    const handler = createPhoneRevokedHandler({ revokeTokens: vi.fn(), disconnect: vi.fn(), revokeBackend, info: vi.fn() });
    handler(record({}));
    handler(record({ id: 'p2', beCodeRef: 'phone-chosen', beCodeRefMacBound: false }));
    expect(revokeBackend.mock.calls).toEqual([['ref-1'], [null]]);
  });
});
