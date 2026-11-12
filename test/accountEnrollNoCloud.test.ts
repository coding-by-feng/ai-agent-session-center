// AASC-64 / plan 17: AASC Cloud sign-in stays strictly optional. A Mac that was never signed in (no saved
// connection), or one whose cloud storage failed to open (no connector at all), must make NO backend request from
// any account-enroll path: building the wiring, the desktop's GET /devices, a phone's POST /enroll, the switch, or
// revoking a phone. Built from the same factories server/index.ts uses (accountEnrollWiring.ts, the real phone
// cloud bridge and mobile router), with every cloud client and connector method a spy.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createAccountEnrollWiring } from '../server/mobile/accountEnrollWiring.js';
import { createPhoneCloudBridge } from '../server/mobile/phoneCloudBridge.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import type { CloudConnector } from '../server/cloud/types.js';

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

/** A connector with no saved connection: what a never-signed-in Mac opens at startup. Every network method is a spy. */
function signedOutConnector() {
  const request = vi.fn(async () => { throw new Error('no backend request may be made'); });
  const stream = vi.fn(async () => { throw new Error('no backend request may be made'); });
  const network = {
    connectCloud: vi.fn(), recheckCloud: vi.fn(), disconnectCloud: vi.fn(), revokeDevice: vi.fn(),
  };
  const connector: CloudConnector = {
    client: { request, stream } as CloudConnector['client'],
    status: () => ({ connection: null, state: 'disconnected', lastError: null }) as ReturnType<CloudConnector['status']>,
    ...(network as unknown as Pick<CloudConnector, 'connectCloud' | 'recheckCloud' | 'disconnectCloud' | 'revokeDevice'>),
    stop: vi.fn(async () => {}),
    onStop: () => () => {},
  };
  const calls = () => request.mock.calls.length + stream.mock.calls.length
    + Object.values(network).reduce((n, fn) => n + fn.mock.calls.length, 0);
  return { connector, calls };
}

const BODY = {
  macDeviceId: '00000000-0000-4000-8000-0000000000aa',
  ticket: 'k'.repeat(43),
  phoneKey: `B${'p'.repeat(86)}`,
  nonce: 'a1'.repeat(32),
  platform: 'ios',
};

let server: http.Server | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function setUp(cloud: CloudConnector | null) {
  dir = mkdtempSync(join(tmpdir(), 'aasc-noncloud-'));
  const warn = vi.fn();
  const denied = new Set<string>();
  const phoneCloud = createPhoneCloudBridge({ cloud, warn });
  const wiring = createAccountEnrollWiring({
    cloud,
    phoneCloud,
    configPath: join(dir, 'server-config.json'),
    savedSetting: undefined, // a fresh install
    env: {},
    pairingOffered: () => true,
    passwordEnabled: () => true,
    denyList: { has: (id) => denied.has(id), add: (id) => void denied.add(id) },
    info: vi.fn(),
    warn,
  });
  const deviceAuth = createDeviceAuth({ store: memoryStore(), onRemovedByOwner: wiring.onRemovedByOwner });
  const accountEnroll = wiring.createEnroll(deviceAuth);
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => true,
    pairingOffered: () => true,
    requireSession: (_req, _res, next) => next(),
    createSessionToken: (id) => `s-${id}`,
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: null, tailnet: null }),
    rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
    accountEnroll,
    setAccountEnroll: (on) => wiring.setting.set(on),
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
        headers: {
          host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
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
  return { deviceAuth, call, warn, denied };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe.each([
  ['a connector with no saved connection (never signed in)', true],
  ['no connector at all (cloud storage failed to open)', false],
])('no AASC Cloud: %s', (_label, withConnector) => {
  it('POST /api/mobile/enroll answers NOT_THIS_MAC with zero cloud client calls, valid ticket or not', async () => {
    const signedOut = signedOutConnector();
    const { call } = await setUp(withConnector ? signedOut.connector : null);
    for (const body of [BODY, { ...BODY, ticket: 'z'.repeat(43) }]) {
      const res = await call('POST', '/enroll', body, '192.168.1.20:3333');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NOT_THIS_MAC');
    }
    await flush();
    expect(signedOut.calls()).toBe(0);
  });

  it('makes no backend request from setup, GET /devices, POST /enroll, the switch or a revoke', async () => {
    const signedOut = signedOutConnector();
    const { deviceAuth, call } = await setUp(withConnector ? signedOut.connector : null);

    const devices = await call('GET', '/devices');
    expect(devices.status).toBe(200);
    expect(devices.body.data.accountEnroll).toMatchObject({ available: false, blocked: 'no-cloud', email: null });

    const enroll = await call('POST', '/enroll', BODY, '192.168.1.20:3333');
    expect(enroll.status).toBe(409);
    expect(enroll.body.code).toBe('NOT_THIS_MAC');

    expect((await call('PUT', '/pairing/account-enroll', { enabled: false })).status).toBe(200);

    // An account row left from when the Mac was signed in, revoked now that it isn't: refused locally, no request.
    const { device } = deviceAuth.enrollActive({
      label: 'Old Pixel', platform: 'android', accountEmail: 'me@example.com',
      accountPhoneId: '00000000-0000-4000-8000-0000000000cc',
    });
    expect((await call('DELETE', `/devices/${device.id}`)).status).toBeLessThan(300);
    await flush();

    expect(signedOut.calls()).toBe(0);
  });
});

describe('the revoke still sticks locally without a cloud', () => {
  it('deny-lists the phone and warns that the cloud sign-out could not happen', async () => {
    const signedOut = signedOutConnector();
    const { deviceAuth, warn, denied } = await setUp(signedOut.connector);
    const phoneId = '00000000-0000-4000-8000-0000000000cc';
    const { device } = deviceAuth.enrollActive({ label: 'Old Pixel', platform: 'android', accountEmail: null, accountPhoneId: phoneId });
    expect(deviceAuth.revoke(device.id)).toBe(true);
    await flush();
    expect(denied.has(phoneId)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Old Pixel'));
    expect(signedOut.calls()).toBe(0);
  });
});
