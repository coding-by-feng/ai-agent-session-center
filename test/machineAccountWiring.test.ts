// test/machineAccountWiring.test.ts — plan 18, stage 2: "one account, all devices" as server/index.ts builds it.
//
// Built from the same factory the server uses (machineAccountWiring.ts), so these hold for the real thing:
//   - AASC Cloud stays optional. A computer that was never signed in (no saved connection), or one whose cloud
//     storage failed to open (no connector at all), makes NO backend request from any of it: building it,
//     starting the publisher and letting its timer run, a client's POST /enroll-computer, the settings, or
//     revoking a computer.
//   - account computers connect only while pairing is offered and this computer is shown to its account, as the
//     owner's choice (ask or auto) says at that moment, and never one the owner revoked here.
//   - the addresses an answer may be bound to by its Host are ones this computer publishes, and only while it does.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createMachineAccountWiring, type MachineAccountWiringDeps } from '../server/mobile/machineAccountWiring.js';
import { createComputerEnrollRouter } from '../server/mobile/computerEnrollRouter.js';
import { DIRECTORY_CHECK_MS } from '../server/mobile/machineDirectoryPublisher.js';
import { RECONCILE_EVERY_MS } from '../server/mobile/accountDeviceReconcile.js';
import { createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { cloudIdentity } from '../server/mobile/cloudReadLog.js';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import type { CloudConnector, CloudStatus } from '../server/cloud/types.js';
import type { CloudConnection } from '../src/types/cloud.js';

const MACHINE = '00000000-0000-4000-8000-0000000000aa';
const CLIENT = '00000000-0000-4000-8000-0000000000cc';
const PUBLIC = '45.63.31.79';
const PORT = 3333;
const AT = '2026-11-20T01:02:03.000Z';
const BODY = { machineId: MACHINE, ticket: 'k'.repeat(43), clientKey: `B${'p'.repeat(86)}`, nonce: 'a1'.repeat(32) };

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

const CONNECTION: CloudConnection = {
  backendOrigin: 'https://backend.example', accountId: '00000000-0000-4000-8000-0000000000a1', deviceId: MACHINE,
  deviceName: 'Mac mini', generation: 1, accountEmail: 'me@example.com',
};

/** A connector whose every network method is a spy. `status` decides whether it is signed in. */
function connector(status: CloudStatus, reply: (method: string, path: string, body: unknown) => unknown = () => { throw new Error('no backend request may be made'); }) {
  const request = vi.fn(async (method: string, path: string, body?: unknown) => reply(method, path, body));
  const stream = vi.fn(async () => { throw new Error('no backend request may be made'); });
  const network = { connectCloud: vi.fn(), recheckCloud: vi.fn(), disconnectCloud: vi.fn(async () => {}), revokeDevice: vi.fn() };
  const cloud: CloudConnector = {
    client: { request, stream } as unknown as CloudConnector['client'],
    status: () => status,
    ...(network as unknown as Pick<CloudConnector, 'connectCloud' | 'recheckCloud' | 'disconnectCloud' | 'revokeDevice'>),
    stop: vi.fn(async () => {}),
    onStop: () => () => {},
  };
  const calls = () => request.mock.calls.length + stream.mock.calls.length
    + Object.values(network).reduce((n, fn) => n + fn.mock.calls.length, 0);
  return { cloud, request, calls };
}
const signedOut: CloudStatus = { connection: null, state: 'disconnected', lastError: null };
const signedIn: CloudStatus = { connection: CONNECTION, state: 'connected', lastError: null };

let server: http.Server | null = null;
const dirs: string[] = [];
const stops: Array<() => void> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function build(cloud: CloudConnector | null, over: Partial<MachineAccountWiringDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aasc-machine-wiring-'));
  dirs.push(dir);
  const denied = new Set<string>();
  const state = { offered: true, password: true, publicAddress: PUBLIC as string | null, tailnet: null as string | null };
  const warn = vi.fn();
  const wiring = createMachineAccountWiring({
    cloud,
    configPath: join(dir, 'server-config.json'),
    savedSettings: {}, // a fresh install
    env: {},
    pairingOffered: () => state.offered,
    passwordEnabled: () => state.password,
    target: async () => ({ lan: '192.168.1.57', tailnet: state.tailnet, publicAddress: state.publicAddress, port: PORT }),
    denyList: { has: (id) => denied.has(id), add: (id) => void denied.add(id) },
    rememberedFile: join(dir, 'machine-directory.json'),
    info: vi.fn(),
    warn,
    debug: vi.fn(),
    ...over,
  });
  if (wiring.publisher) stops.push(() => wiring.publisher!.stop());
  const deviceAuth = createDeviceAuth({ store: memoryStore(), onRemovedByOwner: wiring.onRemovedByOwner });
  const enroll = wiring.createEnroll(deviceAuth);
  const reconcile = wiring.createReconcile(deviceAuth);
  if (reconcile) stops.push(() => reconcile.stop());
  return { wiring, deviceAuth, enroll, reconcile, state, denied, dir, warn };
}

async function serve(f: ReturnType<typeof build>) {
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createComputerEnrollRouter({
    isPasswordEnabled: () => true,
    rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
    computerEnroll: f.enroll,
    publishedAddresses: f.wiring.publishedAddresses,
  }));
  server = http.createServer(app);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return (body: unknown) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/api/mobile/enroll-computer',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
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

describe('AASC Cloud stays optional', () => {
  it('a computer that was never signed in makes no backend request from any of it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const c = connector(signedOut);
    const f = build(c.cloud);
    f.wiring.publisher!.start();
    f.reconcile!.start();
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS * 3);
    expect(f.wiring.publisher!.view().state).toBe('no-cloud');

    const post = await serve(f);
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_THIS_MACHINE');

    expect(f.wiring.settings.get()).toEqual({ showOnAccount: true, addresses: { lan: true, tailnet: true, public: false }, computerEnroll: 'ask' });
    expect(f.wiring.settings.set({ showOnAccount: false, addresses: { lan: true, tailnet: true, public: true }, computerEnroll: 'auto' })).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS);

    const { device } = f.deviceAuth.enrollComputer({ label: 'MacBook', accountEmail: null, backendDeviceId: CLIENT, approve: 'auto' });
    expect(f.deviceAuth.revoke(device.id)).toBe(true);
    expect(f.denied.has(CLIENT)).toBe(true);

    // The reconcile: a record made through an account, no connection. It looks at nothing and drops nothing.
    const kept = f.deviceAuth.enrollComputer({ label: 'Kept', accountEmail: null, backendDeviceId: '00000000-0000-4000-8000-0000000000dd', approve: 'ask' });
    expect(await f.reconcile!.run()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 2);
    expect(f.deviceAuth.list().map((d) => d.id)).toEqual([kept.device.id]);

    await f.wiring.connector!.disconnectCloud(); // signing out of nothing: no withdraw
    expect(c.request).not.toHaveBeenCalled();
    expect(c.calls()).toBe(1); // only the disconnect itself, which is local
    expect(existsSync(join(f.dir, 'machine-directory.json'))).toBe(false);
  });

  it('with no connector at all there is no publisher, and an enroll still answers NOT_THIS_MACHINE', async () => {
    const f = build(null);
    expect(f.wiring.publisher).toBeNull();
    expect(f.wiring.connector).toBeNull();
    expect(f.reconcile).toBeNull();
    const post = await serve(f);
    expect((await post(BODY)).body.code).toBe('NOT_THIS_MACHINE');
  });
});

describe('who may connect', () => {
  const redeemed = { clientDeviceId: CLIENT, clientName: 'MacBook Pro', clientKind: 'server', email: 'me@example.com', relation: 'self' };

  it.each([
    ['pairing is off on this computer', (s: ReturnType<typeof build>) => { s.state.offered = false; }],
    ['this computer is not shown to its account', (s: ReturnType<typeof build>) => {
      s.wiring.settings.set({ ...s.wiring.settings.get(), showOnAccount: false });
    }],
  ])('refuses as ACCOUNT_ENROLL_OFF, before the backend, when %s', async (_label, arrange) => {
    const c = connector(signedIn, (method) => (method === 'DELETE' ? { withdrawn: false } : { updatedAt: AT }));
    const f = build(c.cloud);
    arrange(f);
    await f.wiring.publisher!.check();
    c.request.mockClear();
    const post = await serve(f);
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_ENROLL_OFF');
    expect(c.request).not.toHaveBeenCalled();
  });

  it('redeems as this computer, and follows the owner\'s choice as it stands at that moment', async () => {
    const { createHash, createECDH } = await import('node:crypto');
    const keyOf = () => {
      const ecdh = createECDH('prime256v1');
      const raw = ecdh.generateKeys();
      return { clientKey: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest('hex') };
    };
    let key = keyOf();
    const c = connector(signedIn, (method, path) => {
      if (path === '/v1/machines/tickets/redeem') return { ...redeemed, clientKeyHash: key.hash, sealSecret: 's'.repeat(43) };
      return method === 'DELETE' ? { withdrawn: true } : { updatedAt: AT };
    });
    const f = build(c.cloud);
    const post = await serve(f);

    expect((await post({ ...BODY, clientKey: key.clientKey })).status).toBe(201);
    expect(c.request).toHaveBeenCalledWith('POST', '/v1/machines/tickets/redeem', { ticket: BODY.ticket }, undefined);
    expect(f.deviceAuth.list()).toEqual([expect.objectContaining({ status: 'pending', platform: 'desktop', origin: 'account', label: 'MacBook Pro' })]);

    f.wiring.settings.set({ ...f.wiring.settings.get(), computerEnroll: 'auto' });
    key = keyOf();
    expect((await post({ ...BODY, clientKey: key.clientKey })).status).toBe(201);
    expect(f.deviceAuth.list()).toEqual([expect.objectContaining({ status: 'active', platform: 'desktop', origin: 'account' })]);
  });

  it('keeps out a computer the owner revoked here, but not one that removed itself', async () => {
    const c = connector(signedIn);
    const f = build(c.cloud);
    const kept = f.deviceAuth.enrollComputer({ label: 'A', accountEmail: null, backendDeviceId: CLIENT, approve: 'auto' });
    const { nonce } = f.deviceAuth.createChallenge(kept.device.id);
    expect(f.deviceAuth.unpair(kept.device.id, nonce, proofForToken(kept.deviceToken, nonce))).toBe(true);
    expect(f.denied.size).toBe(0);
    const gone = f.deviceAuth.enrollComputer({ label: 'A', accountEmail: null, backendDeviceId: CLIENT, approve: 'auto' });
    expect(f.deviceAuth.revoke(gone.device.id)).toBe(true);
    expect([...f.denied]).toEqual([CLIENT]);
    expect(c.calls()).toBe(0); // and that computer is never signed out of AASC Cloud from here
  });
});

describe('the addresses an answer may be bound to by its Host', () => {
  const TAILNET = '100.101.102.103';
  const ALL = { lan: true, tailnet: true, public: true };

  it('are the Tailscale address while it has one, and the public address once Public IP is ticked', async () => {
    const f = build(connector(signedIn).cloud);
    expect(await f.wiring.publishedAddresses()).toEqual({ public: null, tailnet: null, port: PORT });
    f.state.tailnet = TAILNET;
    expect(await f.wiring.publishedAddresses()).toEqual({ public: null, tailnet: TAILNET, port: PORT });
    f.wiring.settings.set({ ...f.wiring.settings.get(), addresses: ALL });
    expect(await f.wiring.publishedAddresses()).toEqual({ public: PUBLIC, tailnet: TAILNET, port: PORT });
  });

  it('never carry the home-network address: it is published to the directory, and never bound by Host', async () => {
    const f = build(connector(signedIn).cloud);
    f.state.tailnet = TAILNET;
    f.wiring.settings.set({ ...f.wiring.settings.get(), addresses: ALL });
    expect(JSON.stringify(await f.wiring.publishedAddresses())).not.toContain('192.168.1.57');
  });

  it('follow the ticks: an address this computer does not publish is never one of them', async () => {
    const f = build(connector(signedIn).cloud);
    f.state.tailnet = TAILNET;
    f.wiring.settings.set({ ...f.wiring.settings.get(), addresses: { lan: true, tailnet: false, public: true } });
    expect(await f.wiring.publishedAddresses()).toEqual({ public: PUBLIC, tailnet: null, port: PORT });
    f.state.publicAddress = null;
    expect(await f.wiring.publishedAddresses()).toEqual({ public: null, tailnet: null, port: PORT });
  });

  it('are nothing at all while this computer is not shown to its account', async () => {
    const f = build(connector(signedIn).cloud);
    f.state.tailnet = TAILNET;
    f.wiring.settings.set({ showOnAccount: false, addresses: ALL, computerEnroll: 'ask' });
    expect(await f.wiring.publishedAddresses()).toBeNull();
  });

  it('do not wait on the cloud: they are what this computer would publish, signed in or not', async () => {
    const c = connector(signedOut);
    const f = build(c.cloud);
    f.state.tailnet = TAILNET;
    expect(await f.wiring.publishedAddresses()).toEqual({ public: null, tailnet: TAILNET, port: PORT });
    expect(c.calls()).toBe(0);
  });

  it('leave out an address of the wrong kind, whatever a source says', async () => {
    const f = build(connector(signedIn).cloud);
    f.state.tailnet = '10.8.0.2'; // another VPN's
    f.state.publicAddress = '192.168.1.57';
    f.wiring.settings.set({ ...f.wiring.settings.get(), addresses: ALL });
    expect(await f.wiring.publishedAddresses()).toEqual({ public: null, tailnet: null, port: PORT });
  });
});

describe('publishing', () => {
  it('publishes again as soon as a setting is saved, and remembers the account in a private file', async () => {
    const c = connector(signedIn, (method) => (method === 'DELETE' ? { withdrawn: true } : { updatedAt: AT }));
    const f = build(c.cloud);
    await f.wiring.publisher!.check();
    expect(c.request).toHaveBeenLastCalledWith('PUT', '/v1/machines/self', { lan: '192.168.1.57', port: PORT }, undefined);
    const file = join(f.dir, 'machine-directory.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ account: cloudIdentity(CONNECTION) });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    f.wiring.settings.set({ ...f.wiring.settings.get(), addresses: { lan: true, tailnet: true, public: true } });
    await f.wiring.publisher!.check();
    expect(c.request).toHaveBeenLastCalledWith('PUT', '/v1/machines/self', { lan: '192.168.1.57', public: PUBLIC, port: PORT }, undefined);
  });

  it('does not publish a computer nobody could connect to, and says why', async () => {
    const c = connector(signedIn);
    const f = build(c.cloud);
    f.state.password = false;
    expect((await f.wiring.publisher!.check()).state).toBe('no-password');
    f.state.offered = false; // both: pairing off is named first, as the phone switch does
    expect((await f.wiring.publisher!.check()).state).toBe('pairing-off');
    f.state.password = true;
    expect((await f.wiring.publisher!.check()).state).toBe('pairing-off');
    expect(c.request).not.toHaveBeenCalled();
  });

  it('a restart with the setting turned off withdraws what the last run published', async () => {
    const c = connector(signedIn, (method) => (method === 'DELETE' ? { withdrawn: true } : { updatedAt: AT }));
    const first = build(c.cloud);
    await first.wiring.publisher!.check();
    c.request.mockClear();
    const second = build(c.cloud, {
      rememberedFile: join(first.dir, 'machine-directory.json'),
      env: { AASC_SHOW_ON_ACCOUNT: '0' },
    });
    expect((await second.wiring.publisher!.check()).state).toBe('off');
    expect(c.request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(['DELETE /v1/machines/self']);
    expect(JSON.parse(readFileSync(join(first.dir, 'machine-directory.json'), 'utf8'))).toEqual({ account: null });
  });

  it('the connector for the cloud routes withdraws before signing out', async () => {
    const c = connector(signedIn, (method) => (method === 'DELETE' ? { withdrawn: true } : { updatedAt: AT }));
    const f = build(c.cloud);
    await f.wiring.publisher!.check();
    c.request.mockClear();
    await f.wiring.connector!.disconnectCloud();
    expect(c.request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(['DELETE /v1/machines/self']);
    expect(c.cloud.disconnectCloud).toHaveBeenCalledTimes(1);
  });
});

describe('signing in again while signed in', () => {
  const OWNER = '00000000-0000-4000-8000-0000000000a1';
  const DEVICES = ['00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000d2'];
  const TOKENS = ['1'.repeat(43), '2'.repeat(43)];
  const SIGN_IN = { backendUrl: 'https://backend.example', deviceName: 'Mac mini' };

  /** The real connection (so each request carries the token of the device that makes it) and the real publisher. */
  async function signedInWiring() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aasc-machine-resign-')));
    dirs.push(dir);
    const backend = { pairs: 0, refuseNextPair: false };
    const calls: string[] = [];
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const auth = new Headers(init?.headers).get('authorization');
      const who = auth === null ? '-' : `token${TOKENS.indexOf(auth.replace('Bearer ', '')) + 1}`;
      calls.push(`${method} ${url.pathname} ${who}`);
      if (url.pathname === '/v1/devices/pair') {
        if (backend.refuseNextPair) {
          backend.refuseNextPair = false;
          return new Response(JSON.stringify({ success: false, error: { code: 'pairing_invalid', message: 'x' } }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        const n = backend.pairs++;
        return Response.json({ success: true, data: { token: TOKENS[n], ownerId: OWNER, deviceId: DEVICES[n] } });
      }
      if (url.pathname === '/v1/machines/self') {
        return Response.json({ success: true, data: method === 'PUT' ? { updatedAt: AT } : { withdrawn: true } });
      }
      return new Response('{}', { status: 404 }); // the self-description of plan 18 stage 1, and anything else
    });
    const cloud = await createCloudConnection({
      directory: join(dir, 'cloud'), secrets: createFileSecretStore(join(dir, 'secrets')), fetch: fetcher as unknown as typeof fetch,
    });
    stops.push(() => void cloud.stop());
    const f = build(cloud);
    /** What this computer asked about itself in the directory, and each sign-in, in order. */
    const told = () => calls.filter((call) => call.includes('/v1/machines/self') || call.includes('/v1/devices/pair'));
    await f.wiring.connector!.connectCloud({ ...SIGN_IN, pairingCode: 'a'.repeat(22) });
    await f.wiring.publisher!.check();
    return { ...f, backend, told };
  }

  it('a first sign-in withdraws nothing, and publishes as the new device', async () => {
    const f = await signedInWiring();
    expect(f.told()).toEqual(['POST /v1/devices/pair -', 'PUT /v1/machines/self token1']);
  });

  it('the old device leaves the directory with its own token before the sign-in, then the new device publishes', async () => {
    const f = await signedInWiring();
    await f.wiring.connector!.connectCloud({ ...SIGN_IN, pairingCode: 'b'.repeat(22) });
    await f.wiring.publisher!.check();
    expect(f.told()).toEqual([
      'POST /v1/devices/pair -',
      'PUT /v1/machines/self token1',
      'DELETE /v1/machines/self token1',
      'POST /v1/devices/pair -',
      'PUT /v1/machines/self token2',
    ]);
  });

  it('when that sign-in fails, the old connection is still this computer\'s and it is published again', async () => {
    const f = await signedInWiring();
    f.backend.refuseNextPair = true;
    await expect(f.wiring.connector!.connectCloud({ ...SIGN_IN, pairingCode: 'b'.repeat(22) })).rejects.toBeTruthy();
    // Nothing here asks the publisher to look: the failed sign-in itself must put this computer back.
    await vi.waitFor(() => expect(f.told().at(-1)).toBe('PUT /v1/machines/self token1'));
    // While that request is out the view reads pending; once the cloud has answered, published again.
    await vi.waitFor(() => expect(f.wiring.publisher!.view().state).toBe('published'));
    expect(f.told()).toEqual([
      'POST /v1/devices/pair -',
      'PUT /v1/machines/self token1',
      'DELETE /v1/machines/self token1',
      'POST /v1/devices/pair -',
      'PUT /v1/machines/self token1',
    ]);
  });

  it('server/index.ts sends both ways of signing in through this connector: the cloud routes and Sign in with Google', () => {
    const source = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('connect: (input) => (machineAccount?.connector ?? cloud).connectCloud(input)');
    expect(source).toContain('cloud: machineAccountWiring.connector ?? cloudSetup.cloud');
    // And nothing else in the server signs in behind its back.
    const others = ['cloud/router.ts', 'cloud/googleSignIn.ts', 'cloud/googleCallbackRouter.ts', 'resourceRouter.ts']
      .map((file) => readFileSync(new URL(`../server/${file}`, import.meta.url), 'utf8'));
    expect(others[0].match(/\.connectCloud\(/g)).toHaveLength(1); // POST /connect, on the connector it was given
    expect(others[1]).not.toMatch(/\.connectCloud\(/);
    expect(others[2]).not.toMatch(/\.connectCloud\(/);
    expect(others[3]).not.toMatch(/\.connectCloud\(/);
  });
});

describe('a device the account signed out (the reconcile, as the server wires it)', () => {
  const GONE = '00000000-0000-4000-8000-0000000000e1';
  const listed = (revokedAt: string | null) => ({
    devices: [{ id: GONE, name: 'Lost iPhone', kind: 'phone', createdByCode: null, createdAt: AT, lastUsedAt: null, revokedAt, scopes: [] }],
    nextCursor: null,
  });
  const backend = (revokedAt: string | null) => (method: string, path: string) => {
    if (path === '/v1/devices') return listed(revokedAt);
    return method === 'DELETE' ? { withdrawn: true } : { updatedAt: AT };
  };
  const accountPhone = (f: ReturnType<typeof build>) =>
    f.deviceAuth.enrollActive({ label: 'Lost iPhone', platform: 'ios', accountEmail: 'me@example.com', accountPhoneId: GONE });

  it('is dropped here on a look, without joining the deny list and with nothing pushed back to the backend', async () => {
    const c = connector(signedIn, backend(AT));
    const f = build(c.cloud);
    const phone = accountPhone(f);
    expect(await f.reconcile!.run()).toBe(1);
    expect(f.deviceAuth.list()).toEqual([]);
    expect(f.denied.size).toBe(0);
    expect(c.request.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(['GET /v1/devices']);
    const { nonce } = f.deviceAuth.createChallenge(phone.device.id);
    expect(f.deviceAuth.exchange(phone.device.id, nonce, proofForToken(phone.deviceToken, nonce))).toEqual({ ok: false, reason: 'revoked' });
  });

  it('stays while the account still lists it live', async () => {
    const c = connector(signedIn, backend(null));
    const f = build(c.cloud);
    accountPhone(f);
    expect(await f.reconcile!.run()).toBe(0);
    expect(f.deviceAuth.list()).toHaveLength(1);
  });

  it('a sign-in looks at once; a sign-out stops the looking', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const c = connector(signedIn, backend(null));
    const f = build(c.cloud);
    accountPhone(f);
    const lists = () => c.request.mock.calls.filter(([, path]) => path === '/v1/devices').length;
    await f.wiring.connector!.connectCloud({ backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(lists()).toBe(2);
    await f.wiring.connector!.disconnectCloud();
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3);
    expect(lists()).toBe(2);
  });

  it('a sign-out that fails leaves the looking on, through the whole connector', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const c = connector(signedIn, backend(null));
    const f = build(c.cloud);
    accountPhone(f);
    const lists = () => c.request.mock.calls.filter(([, path]) => path === '/v1/devices').length;
    f.reconcile!.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lists()).toBe(1);
    vi.mocked(c.cloud.disconnectCloud).mockRejectedValueOnce(new Error('could not sign out'));
    await expect(f.wiring.connector!.disconnectCloud()).rejects.toThrow('could not sign out');
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(lists()).toBe(2); // still signed in, so still looked at
  });

  it('a sign-out made on this machine drops the record at once', () => {
    const c = connector(signedIn, backend(null));
    const f = build(c.cloud);
    accountPhone(f);
    expect(f.reconcile!.signedOut(GONE)).toBe(1);
    expect(f.deviceAuth.list()).toEqual([]);
    expect(c.request).not.toHaveBeenCalled();
  });
});
