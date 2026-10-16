// test/cloudPhoneAudit.test.ts — AASC-52: backend phone devices no paired phone holds any more.
//
// A backend revoke can fail while the Mac side goes through; a phone's last code can be redeemed late, by it
// or by someone who took it, after it asked for a new one. Each leaves a backend push device that isn't
// linked to a phone paired with this Mac. The desktop's phone list says how many and
// offers to remove them. It must never touch this Mac's own device, a non-phone device, a phone that IS
// paired here, or a phone another Mac on the same account made (the backend's device list doesn't say which
// Mac minted a code, so this Mac goes by its own ledger of the codes it minted).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { createPhoneCloudBridge } from '../server/mobile/phoneCloudBridge.js';
import { createCloudPhoneAudit } from '../server/mobile/cloudPhoneAudit.js';
import type { CloudConnector, CloudStatus } from '../server/cloud/types.js';

interface FakeDevice { id: string; kind: 'phone' | 'server' | null; createdByCode: string | null; revokedAt: string | null }

/** A cloud connector over an account's device list, with GET /v1/devices (2 per page) and DELETE. */
function fakeConnector(devices: FakeDevice[]) {
  const calls: string[] = [];
  const backend = { state: 'connected' as CloudStatus['state'], failList: false, failDelete: new Set<string>() };
  const cloud = {
    client: {
      async request<T>(method: string, path: string): Promise<T> {
        calls.push(`${method} ${path}`);
        if (method === 'GET' && path.startsWith('/v1/devices')) {
          if (backend.failList) throw Object.assign(new Error('down'), { code: 'offline' });
          const cursor = new URLSearchParams(path.split('?')[1] ?? '').get('cursor');
          const start = cursor ? devices.findIndex((d) => d.id === cursor) + 1 : 0;
          const page = devices.slice(start, start + 2);
          return { devices: page, nextCursor: start + 2 < devices.length ? page.at(-1)!.id : null } as T;
        }
        const del = /^\/v1\/devices\/([\w-]+)$/.exec(path);
        if (method === 'DELETE' && del) {
          if (backend.failDelete.has(del[1])) throw Object.assign(new Error('down'), { code: 'offline' });
          const d = devices.find((x) => x.id === del[1]);
          if (d) d.revokedAt = '2026-10-16T00:00:00.000Z';
          return { revoked: true } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
    status: (): CloudStatus => ({
      state: backend.state,
      lastError: null,
      connection: backend.state === 'disconnected' ? null : { backendOrigin: 'https://api.aasc.work', accountId: 'acct', deviceId: 'mac-1', deviceName: 'Mac', generation: 1 },
    }),
  } as unknown as CloudConnector;
  return { cloud, calls, backend };
}

const live = (id: string, kind: FakeDevice['kind'], createdByCode: string | null): FakeDevice => ({ id, kind, createdByCode, revokedAt: null });

let devices: FakeDevice[];
let connector: ReturnType<typeof fakeConnector>;
let linked: Set<string>;
let minted: Set<string>;
const warn = vi.fn();
let audit: ReturnType<typeof createCloudPhoneAudit>;

beforeEach(() => {
  devices = [
    live('mac-1', 'server', null), // this Mac
    live('owner-cli', 'server', null), // the owner CLI
    live('paired-phone', 'phone', 'ref-paired'), // a phone paired with this Mac now
    live('late-redeemed', 'phone', 'ref-replaced'), // a code this Mac replaced, redeemed after the phone got a new one
    live('failed-revoke', 'phone', 'ref-revoked-phone'), // its phone was revoked, the backend revoke failed
    live('other-mac-phone', 'phone', 'ref-other-mac'), // a phone another Mac on the account issued
    { ...live('done', 'phone', 'ref-done'), revokedAt: '2026-10-01T00:00:00.000Z' }, // already revoked
    live('unclassified', null, 'ref-odd'), // a row the backend couldn't classify
  ];
  connector = fakeConnector(devices);
  linked = new Set(['ref-paired']);
  minted = new Set(['ref-paired', 'ref-replaced', 'ref-revoked-phone', 'ref-done', 'ref-odd']);
  warn.mockClear();
  audit = createCloudPhoneAudit({
    cloud: createPhoneCloudBridge({ cloud: connector.cloud, warn }),
    linkedCodeRefs: () => linked,
    mintedHere: (codeRef) => minted.has(codeRef),
    warn,
  });
});

describe('createCloudPhoneAudit', () => {
  it('counts this Mac’s live backend phone devices that no paired phone holds', async () => {
    expect(await audit.count()).toEqual({ cloud: true, unlinked: 2 });
    expect(connector.calls.every((c) => c.startsWith('GET'))).toBe(true);
  });

  it('removes exactly those, and never this Mac, a server device, a paired phone or another Mac’s phone', async () => {
    expect(await audit.removeUnlinked()).toEqual({ cloud: true, removed: 2, failed: 0 });
    expect(connector.calls.filter((c) => c.startsWith('DELETE')).sort()).toEqual(['DELETE /v1/devices/failed-revoke', 'DELETE /v1/devices/late-redeemed']);
    expect(await audit.count()).toEqual({ cloud: true, unlinked: 0 });
  });

  it('decides at removal time: a phone linked since the count is kept', async () => {
    expect(await audit.count()).toEqual({ cloud: true, unlinked: 2 });
    linked.add('ref-replaced');
    expect(await audit.removeUnlinked()).toEqual({ cloud: true, removed: 1, failed: 0 });
    expect(devices.find((d) => d.id === 'late-redeemed')?.revokedAt).toBeNull();
  });

  it('counts what it could not remove, and logs a count only', async () => {
    connector.backend.failDelete.add('late-redeemed');
    expect(await audit.removeUnlinked()).toEqual({ cloud: true, removed: 1, failed: 1 });
    const message = String(warn.mock.calls.at(-1)?.[0]);
    expect(message).toMatch(/1 cloud phone device/);
    expect(message).not.toMatch(/late-redeemed|ref-/);
  });

  it('says there is no cloud without asking the backend', async () => {
    connector.backend.state = 'disconnected';
    expect(await audit.count()).toEqual({ cloud: false });
    expect(await audit.removeUnlinked()).toEqual({ cloud: false });
    expect(connector.calls).toEqual([]);
  });

  it('throws when the backend can’t list devices (the route answers 502)', async () => {
    connector.backend.failList = true;
    await expect(audit.count()).rejects.toMatchObject({ code: 'offline' });
    await expect(audit.removeUnlinked()).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('/api/mobile/cloud-phones (desktop only)', () => {
  let server: http.Server;
  let port: number;
  let signedIn: boolean;

  beforeEach(async () => {
    signedIn = true;
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: createDeviceAuth({ store: { insert: () => {}, get: () => null, update: () => {}, listLive: () => [], remove: () => {} } }),
      isPasswordEnabled: () => true,
      requireSession: (_req, res, next) => (signedIn ? next() : res.status(401).json({ error: 'Unauthorized' })),
      createSessionToken: (deviceId) => `session-for-${deviceId}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit: { check: () => 0, record: () => {}, clear: () => {} },
      // A paired phone's session must not reach these either.
      sessionOf: () => ({ deviceId: 'some-phone' }),
      cloudPhones: audit,
    }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function call(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path: `/api/mobile${path}`,
        headers: { host: `localhost:${port}`, ...(method === 'POST' && { 'content-type': 'application/json' }), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  }

  it('the AASC page counts them and removes them', async () => {
    expect(await call('GET', '/cloud-phones')).toEqual({ status: 200, body: { success: true, data: { cloud: true, unlinked: 2 } } });
    expect(await call('POST', '/cloud-phones/remove-unlinked')).toEqual({ status: 200, body: { success: true, data: { removed: 2, failed: 0 } } });
  });

  it.each([
    ['another page on this machine (Sec-Fetch-Site: same-site)', { 'sec-fetch-site': 'same-site' }],
    ['a DNS-rebinding page (foreign Host)', { host: 'attacker.example' }],
    ['a tunnel or a phone through one (X-Forwarded-For)', { 'x-forwarded-for': '203.0.113.9' }],
  ])('is invisible to %s, and removes nothing', async (_label, headers) => {
    expect((await call('GET', '/cloud-phones', headers)).status).toBe(404);
    expect((await call('POST', '/cloud-phones/remove-unlinked', headers)).status).toBe(404);
    expect(connector.calls).toEqual([]);
  });

  it('needs the dashboard session', async () => {
    signedIn = false;
    expect((await call('GET', '/cloud-phones')).status).toBe(401);
    expect((await call('POST', '/cloud-phones/remove-unlinked')).status).toBe(401);
    // Another page on this machine learns nothing, signed in or not.
    expect((await call('GET', '/cloud-phones', { 'sec-fetch-site': 'same-site' })).status).toBe(404);
    expect(connector.calls).toEqual([]);
  });

  it('answers plainly without a cloud connection, and 502 when the backend fails', async () => {
    connector.backend.state = 'disconnected';
    expect((await call('GET', '/cloud-phones')).body).toEqual({ success: true, data: { cloud: false } });
    const remove = await call('POST', '/cloud-phones/remove-unlinked');
    expect([remove.status, remove.body.code]).toEqual([409, 'NO_CLOUD']);
    connector.backend.state = 'connected';
    connector.backend.failList = true;
    const failed = await call('GET', '/cloud-phones');
    expect([failed.status, failed.body.code]).toEqual([502, 'CLOUD_UNAVAILABLE']);
  });
});
