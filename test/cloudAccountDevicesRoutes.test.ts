// test/cloudAccountDevicesRoutes.test.ts — plan 18 "Manage devices": the two local routes behind the table of the
// account's devices.
//
//   GET    /api/resources/cloud/account/devices      every device of the account (computers and phones)
//   DELETE /api/resources/cloud/account/devices/:id  sign that device out of AASC Cloud
//
// For this computer's own dashboard only: behind the RESOURCES local gate (404 for any other device), and both,
// the read too, only from the AASC page itself (a read here asks the backend). The DELETE also needs the
// connection the page reviewed (binding headers), refuses this computer's own device, and checks the id before
// anything is sent. Built through createResourceRouter, as the server mounts it, against a fake backend.
import express from 'express';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { allowedCloudRoute } from '../server/cloud/client.js';
import { createCloudConnection } from '../server/cloud/connection.js';
import { MAX_DEVICE_PAGES, findDeviceByPairingCode, listBackendDevices } from '../server/cloud/devices.js';
import { cloudJsonParser } from '../server/cloud/router.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { createResourceRouter, resourceErrorHandler } from '../server/resourceRouter.js';

const owner = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const mini = '00000000-0000-4000-8000-000000000003';
const phone = '00000000-0000-4000-8000-000000000004';
const gone = '00000000-0000-4000-8000-000000000005';
/** One device id as a backend might store it and as a page sends it. */
const OWN_UPPER = '00000000-0000-4000-8000-0000000000AB';
const OWN_LOWER = OWN_UPPER.toLowerCase();
const token = 't'.repeat(43);
const T1 = '2026-11-01T10:00:00.000Z';
const T2 = '2026-11-19T08:30:00.000Z';
const T3 = '2026-11-20T01:02:03.000Z';
const ms = (iso: string) => Date.parse(iso);

/** A device as the backend lists it (contract v1 DeviceMetadata). */
const row = (over: Record<string, unknown> = {}) => ({
  id: mini, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.10.81',
  scopes: ['devices:manage'], kind: 'server', createdByCode: null, createdAt: T1, lastUsedAt: T2, revokedAt: null, ...over,
});
const SELF_ROW = row({ id: self, name: 'MacBook Pro', edition: 'lite', lastUsedAt: T1 });
const PHONE_ROW = row({ id: phone, name: 'Kason’s iPhone', platform: 'ios', edition: 'phone', appVersion: '1.1.0', kind: 'phone', lastUsedAt: T3 });

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
  vi.clearAllMocks();
});

type Backend = (call: { method: string; path: string }) => Response;
const ok = (data: unknown) => Response.json({ success: true, data });
const failure = (status: number, code: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${token}` } }), {
    status, headers: { 'content-type': 'application/json' },
  });
const page = (devices: unknown[], nextCursor: string | null = null) => ok({ devices, nextCursor });

async function setup(options: {
  signedIn?: boolean; backend?: Backend; isLocalRequest?: () => boolean;
  /** This computer's own device id as the backend gave it at sign-in (default `self`). */
  ownId?: string;
  /** What the server does when a sign-out made here succeeds (the reconcile's `signedOut`). */
  onSignedOut?: (id: string) => void;
} = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-account-devices-')));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  /** `METHOD path?query`, with the token each request carried. */
  const calls: string[] = [];
  const state = { backend: options.backend ?? (() => page([SELF_ROW, row(), PHONE_ROW])) };
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/v1/devices/pair') return ok({ token, ownerId: owner, deviceId: options.ownId ?? self });
    if (url.pathname === '/v1/devices/self') return ok({}); // plan 18 stage 1's self-description, not this test's
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
    calls.push(`${method} ${url.pathname}${url.search}`);
    return state.backend({ method, path: `${url.pathname}${url.search}` });
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'),
    secrets: createFileSecretStore(join(dir, 'secrets')),
    fetch: fetcher as unknown as typeof fetch,
  });
  cleanup.push(() => cloud.stop());
  if (options.signedIn !== false) {
    await cloud.connectCloud({ backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac' });
  }

  const app = express();
  app.use('/api/resources/cloud', cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/resources', createResourceRouter({
    sessionProjectPaths: () => [],
    home: dir,
    cloud,
    cloudAliasDirectory: join(dir, 'cloud'),
    ...(options.onSignedOut ? { onAccountDeviceSignedOut: options.onSignedOut } : {}),
    ...(options.isLocalRequest ? { isLocalRequest: options.isLocalRequest } : {}),
  }));
  app.use('/api/resources', resourceErrorHandler);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as AddressInfo;
  /** The connection the page reviewed, as it names it on a state-changing call. */
  const binding = (over: Record<string, string> = {}): Record<string, string> => {
    const connection = cloud.status().connection;
    return {
      'x-aasc-cloud-backend': connection?.backendOrigin ?? 'https://backend.example',
      'x-aasc-cloud-account': connection?.accountId ?? owner,
      'x-aasc-cloud-generation': String(connection?.generation ?? 1),
      ...over,
    };
  };
  return { url: `http://127.0.0.1:${port}/api/resources/cloud/account/devices`, calls, cloud, state, binding };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
interface Device {
  id: string; name: string; kind: string | null; platform: string | null; edition: string | null;
  appVersion: string | null; createdAt: number; lastUsedAt: number | null; current: boolean;
}
const list = async (f: Fixture, headers: Record<string, string> = {}) => fetch(f.url, { headers });
const devicesOf = async (res: Response) => ((await res.json()) as { success: true; data: { devices: Device[] } }).data.devices;
const errorOf = async (res: Response) => ((await res.json()) as { success: false; error: { code: string; message: string } }).error;
const revoke = (f: Fixture, id: string, headers: Record<string, string> = f.binding()) =>
  fetch(`${f.url}/${id}`, { method: 'DELETE', headers });

describe('the bearer allow-list', () => {
  it('admits the two backend routes these use, the list with a cursor too', () => {
    expect(allowedCloudRoute('GET', '/v1/devices')).toBe(true);
    expect(allowedCloudRoute('GET', `/v1/devices?cursor=${mini}`)).toBe(true);
    expect(allowedCloudRoute('DELETE', `/v1/devices/${mini}`)).toBe(true);
    // And never a path that climbs out of it or carries anything odd.
    expect(allowedCloudRoute('DELETE', `/v1/devices/../account`)).toBe(false);
    expect(allowedCloudRoute('DELETE', `/v1/devices/${mini}#x`)).toBe(false);
    expect(allowedCloudRoute('DELETE', '/v1/account')).toBe(false);
  });
});

describe('GET /api/resources/cloud/account/devices', () => {
  it('answers the account\'s devices in the page\'s shape, times in ms, asked with this computer\'s token', async () => {
    const f = await setup();
    const res = await list(f);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      success: true,
      data: {
        devices: [
          { id: self, name: 'MacBook Pro', kind: 'server', platform: 'macos', edition: 'lite', appVersion: '2.10.81', createdAt: ms(T1), lastUsedAt: ms(T1), current: true },
          { id: phone, name: 'Kason’s iPhone', kind: 'phone', platform: 'ios', edition: 'phone', appVersion: '1.1.0', createdAt: ms(T1), lastUsedAt: ms(T3), current: false },
          { id: mini, name: 'Mac mini', kind: 'server', platform: 'macos', edition: 'full', appVersion: '2.10.81', createdAt: ms(T1), lastUsedAt: ms(T2), current: false },
        ],
      },
    });
    expect(f.calls).toEqual(['GET /v1/devices']);
  });

  it('never passes on what else the backend says about a device (its scopes, the code that made it)', async () => {
    const f = await setup({ backend: () => page([row({ createdByCode: gone, scopes: ['devices:manage'], addedLater: 'x' })]) });
    const text = await (await list(f)).text();
    for (const leaked of ['scopes', 'devices:manage', 'createdByCode', gone, 'addedLater', 'revokedAt']) expect(text).not.toContain(leaked);
  });

  it('orders them: this computer first, then the most recently used, then by name', async () => {
    const f = await setup({ backend: () => page([
      row({ id: '00000000-0000-4000-8000-00000000000a', name: 'Zed', lastUsedAt: null }),
      row({ id: '00000000-0000-4000-8000-00000000000b', name: 'alpha', lastUsedAt: null }),
      row({ id: '00000000-0000-4000-8000-00000000000c', name: 'Old', lastUsedAt: T1 }),
      row({ id: '00000000-0000-4000-8000-00000000000d', name: 'Beta', lastUsedAt: T3 }),
      row({ id: '00000000-0000-4000-8000-00000000000e', name: 'Alpha', lastUsedAt: T3 }),
      row({ id: self, name: 'Zzz this computer', lastUsedAt: null }),
    ]) });
    const devices = await devicesOf(await list(f));
    expect(devices.map((d) => d.name)).toEqual(['Zzz this computer', 'Alpha', 'Beta', 'Old', 'alpha', 'Zed']);
    expect(devices.map((d) => d.current)).toEqual([true, false, false, false, false, false]);
  });

  it('knows this computer\'s own row when its stored device id is in upper case', async () => {
    const f = await setup({ ownId: OWN_UPPER, backend: () => page([row(), row({ id: OWN_LOWER, name: 'This one', lastUsedAt: null })]) });
    expect(f.cloud.status().connection?.deviceId).toBe(OWN_UPPER);
    const devices = await devicesOf(await list(f));
    expect(devices.map((d) => [d.id, d.current])).toEqual([[OWN_LOWER, true], [mini, false]]);
  });

  it('leaves revoked devices out', async () => {
    const f = await setup({ backend: () => page([SELF_ROW, row({ revokedAt: T2 }), PHONE_ROW]) });
    expect((await devicesOf(await list(f))).map((d) => d.id)).toEqual([self, phone]);
  });

  it('reads every page, following the backend\'s cursor', async () => {
    const f = await setup({ backend: ({ path }) => {
      if (path === '/v1/devices') return page([SELF_ROW], self);
      if (path === `/v1/devices?cursor=${self}`) return page([row()], mini);
      if (path === `/v1/devices?cursor=${mini}`) return page([PHONE_ROW]);
      return failure(400, 'invalid_request');
    } });
    expect((await devicesOf(await list(f))).map((d) => d.id)).toEqual([self, phone, mini]);
    expect(f.calls).toEqual(['GET /v1/devices', `GET /v1/devices?cursor=${self}`, `GET /v1/devices?cursor=${mini}`]);
  });

  it(`is 502 cloud_unavailable, never a cut-off list, when ${MAX_DEVICE_PAGES} pages were read and there is still more`, async () => {
    let n = 0;
    const f = await setup({ backend: () => page([row()], `next-${++n}`) }); // a new cursor every time
    const res = await list(f);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: { code: 'cloud_unavailable', message: 'AASC Cloud didn’t answer. Try again.' } });
    expect(f.calls).toHaveLength(MAX_DEVICE_PAGES);
  });

  it('stops as soon as the backend repeats a cursor, and answers 502 rather than the part it has', async () => {
    const f = await setup({ backend: () => page([row()], mini) });
    const res = await list(f);
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ success: false, error: { code: 'cloud_unavailable' } });
    expect(body).not.toContain('Mac mini');
    expect(f.calls).toEqual(['GET /v1/devices', `GET /v1/devices?cursor=${mini}`]);
  });

  it('a cursor that comes round again later (a loop of two) stops it too', async () => {
    const f = await setup({ backend: ({ path }) => {
      if (path === '/v1/devices') return page([SELF_ROW], self);
      if (path === `/v1/devices?cursor=${self}`) return page([row()], mini);
      return page([PHONE_ROW], self); // back to the first cursor
    } });
    const res = await list(f);
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe('cloud_unavailable');
    expect(f.calls).toEqual(['GET /v1/devices', `GET /v1/devices?cursor=${self}`, `GET /v1/devices?cursor=${mini}`]);
  });

  it.each([
    ['an id that is no uuid', row({ id: 'device-1' })],
    ['no name', row({ name: undefined })],
    ['an empty name', row({ name: '' })],
    ['a name that is no string', row({ name: 7 })],
    ['a creation time that is no time', row({ createdAt: 'yesterday' })],
    ['no creation time', row({ createdAt: undefined })],
    ['a row that is no object', 'Mac mini'],
    ['a null row', null],
  ])('skips a device with %s, and still lists the rest', async (_label, bad) => {
    const f = await setup({ backend: () => page([SELF_ROW, bad, PHONE_ROW]) });
    const res = await list(f);
    expect(res.status).toBe(200);
    expect((await devicesOf(res)).map((d) => d.id)).toEqual([self, phone]);
  });

  it('takes a device from a backend that says less about it: no platform, edition or version, never used', async () => {
    const { platform: _p, edition: _e, appVersion: _v, ...older } = row({ lastUsedAt: null, kind: null });
    const f = await setup({ backend: () => page([older]) });
    expect(await devicesOf(await list(f))).toEqual([
      { id: mini, name: 'Mac mini', kind: null, platform: null, edition: null, appVersion: null, createdAt: ms(T1), lastUsedAt: null, current: false },
    ]);
  });

  it('reads a value of a kind it does not know as nothing, rather than dropping the device', async () => {
    const f = await setup({ backend: () => page([row({ platform: 7, edition: { x: 1 }, appVersion: ['2'], lastUsedAt: 'never', kind: 3 })]) });
    expect(await devicesOf(await list(f))).toEqual([
      { id: mini, name: 'Mac mini', kind: null, platform: null, edition: null, appVersion: null, createdAt: ms(T1), lastUsedAt: null, current: false },
    ]);
  });

  it('is 409 not_connected with no connection, and asks the backend nothing', async () => {
    const f = await setup({ signedIn: false });
    const res = await list(f);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_connected');
    expect(f.calls).toEqual([]);
  });

  it('is 409 not_connected once the connection is revoked, and asks the backend nothing more', async () => {
    const f = await setup({ backend: () => failure(401, 'unauthorized') });
    expect((await errorOf(await list(f))).code).toBe('not_connected'); // the request that learns it
    expect(f.cloud.status().state).toBe('revoked');
    f.calls.length = 0;
    const res = await list(f);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_connected');
    expect(f.calls).toEqual([]);
  });

  it('is 409 needs_sign_in when the backend says 403 (a sign-in without the right to manage devices)', async () => {
    const f = await setup({ backend: () => failure(403, 'forbidden') });
    const res = await list(f);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('needs_sign_in');
    expect(error.message).not.toContain('SECRET');
  });

  it.each([
    ['a backend fault', () => failure(500, 'internal')],
    ['an answer that is no device list', () => ok({ devices: 'none' })],
    ['a page that fails half way', ({ path }: { path: string }) => (path === '/v1/devices' ? page([SELF_ROW], self) : failure(500, 'internal'))],
    ['no answer at all', () => { throw new Error('ECONNREFUSED'); }],
  ])('is 502 cloud_unavailable for %s, in AASC\'s own words', async (_label, backend) => {
    const f = await setup({ backend: backend as Backend });
    const res = await list(f);
    expect(res.status).toBe(502);
    const error = await errorOf(res);
    expect(error.code).toBe('cloud_unavailable');
    expect(error.message).not.toMatch(/SECRET|ECONNREFUSED/);
  });

  it('is 404 for any other device', async () => {
    const f = await setup({ isLocalRequest: () => false });
    expect((await list(f)).status).toBe(404);
    expect((await revoke(f, mini)).status).toBe(404);
    expect(f.calls).toEqual([]);
  });

  it.each(['same-site', 'cross-site', 'none'])('is refused for a page that is not AASC\'s own (Sec-Fetch-Site: %s), before the backend is asked', async (site) => {
    const f = await setup({ isLocalRequest: () => true });
    const res = await list(f, { 'sec-fetch-site': site });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('forbidden');
    expect(f.calls).toEqual([]);
  });

  it('is refused for a tool that names another origin', async () => {
    const f = await setup();
    expect((await list(f, { origin: 'http://127.0.0.1:9' })).status).toBe(403);
    expect(f.calls).toEqual([]);
  });
});

describe('DELETE /api/resources/cloud/account/devices/:id', () => {
  const revoking: Backend = ({ method }) => (method === 'DELETE' ? ok({ revoked: true }) : page([]));

  it('signs that device out of AASC Cloud, with this computer\'s token', async () => {
    const f = await setup({ backend: revoking });
    const res = await revoke(f, mini);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ success: true, data: { revoked: true } });
    expect(f.calls).toEqual([`DELETE /v1/devices/${mini}`]);
  });

  it('tells this machine at once, so it drops its own record of that device without waiting for the next look', async () => {
    const onSignedOut = vi.fn();
    const f = await setup({ backend: revoking, onSignedOut });
    expect((await revoke(f, mini)).status).toBe(200);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledWith(mini);
  });

  it('tells it nothing when the sign-out did not happen', async () => {
    const onSignedOut = vi.fn();
    const f = await setup({ backend: revoking, onSignedOut });
    await revoke(f, self); // own device
    await revoke(f, mini, {}); // no binding
    await revoke(f, 'device-1'); // no id
    f.state.backend = () => failure(404, 'device_not_found');
    await revoke(f, gone);
    f.state.backend = () => failure(500, 'internal');
    await revoke(f, mini);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty answer', ok({})],
    ['revoked: false', ok({ revoked: false })],
    ['revoked as a word', ok({ revoked: 'true' })],
    ['a list', ok([{ revoked: true }])],
  ])('is 502 cloud_unavailable, and drops nothing here, when the backend answers 200 without confirming it (%s)', async (_label, answer) => {
    const onSignedOut = vi.fn();
    const f = await setup({ backend: ({ method }) => (method === 'DELETE' ? answer.clone() : page([])), onSignedOut });
    const res = await revoke(f, mini);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: { code: 'cloud_unavailable', message: 'AASC Cloud didn’t answer. Try again.' } });
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(f.calls).toEqual([`DELETE /v1/devices/${mini}`]);
    expect(f.cloud.status().state).toBe('connected');
  });

  it('still answers the sign-out when this machine\'s own tidy-up throws', async () => {
    const f = await setup({ backend: revoking, onSignedOut: () => { throw new Error('boom'); } });
    const res = await revoke(f, mini);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { revoked: true } });
  });

  it('refuses this computer\'s own device, and asks the backend nothing', async () => {
    const f = await setup({ backend: revoking });
    const res = await revoke(f, self);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'own_device', message: 'Sign out of AASC Cloud on this computer instead.' });
    expect(f.calls).toEqual([]);
  });

  it('refuses this computer\'s own device when its stored id is in upper case, too', async () => {
    const f = await setup({ ownId: OWN_UPPER, backend: revoking });
    expect(f.cloud.status().connection?.deviceId).toBe(OWN_UPPER);
    const res = await revoke(f, OWN_LOWER);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('own_device');
    expect(f.calls).toEqual([]);
    expect(f.cloud.status().state).toBe('connected');
  });

  it.each([
    ['not a uuid', 'device-1'],
    ['an upper-case uuid', mini.replace(/0/g, 'A')],
    ['a uuid with something glued on', `${mini}x`],
    ['a path that climbs', '..%2Faccount'],
    ['"self"', 'self'],
  ])('refuses an id that is %s (400) before anything is sent', async (_label, id) => {
    const f = await setup({ backend: revoking });
    const res = await revoke(f, id);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('invalid_input');
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['no binding headers at all', () => ({})],
    ['no generation', (b: Record<string, string>) => { const { 'x-aasc-cloud-generation': _g, ...rest } = b; return rest; }],
    ['another account', (b: Record<string, string>) => ({ ...b, 'x-aasc-cloud-account': '00000000-0000-4000-8000-0000000000ff' })],
    ['another backend', (b: Record<string, string>) => ({ ...b, 'x-aasc-cloud-backend': 'https://other.example' })],
    ['an older connection', (b: Record<string, string>) => ({ ...b, 'x-aasc-cloud-generation': '0' })],
    ['a generation that is no number', (b: Record<string, string>) => ({ ...b, 'x-aasc-cloud-generation': 'latest' })],
  ])('refuses a page that reviewed something else: %s (409 connection_changed), and asks the backend nothing', async (_label, headers) => {
    const f = await setup({ backend: revoking });
    const res = await revoke(f, mini, headers(f.binding()));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('connection_changed');
    expect(f.calls).toEqual([]);
  });

  it('checks the binding before it says whose device that is', async () => {
    const f = await setup({ backend: revoking });
    const res = await revoke(f, self, {});
    expect((await errorOf(res)).code).toBe('connection_changed');
  });

  it('is 409 not_connected with no connection, and asks the backend nothing', async () => {
    const f = await setup({ signedIn: false, backend: revoking });
    const res = await revoke(f, mini);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_connected');
    expect(f.calls).toEqual([]);
  });

  it.each([
    [404, 'device_not_found', 404, 'device_not_found'],
    [404, 'not_found', 404, 'device_not_found'],
    [403, 'forbidden', 409, 'needs_sign_in'],
    [500, 'internal', 502, 'cloud_unavailable'],
    [429, 'rate_limited', 502, 'cloud_unavailable'],
  ])('answers the backend\'s %i %s as %i %s, in AASC\'s own words', async (status, code, answered, as) => {
    const f = await setup({ backend: () => failure(status, code) });
    const res = await revoke(f, mini);
    expect(res.status).toBe(answered);
    const error = await errorOf(res);
    expect(error.code).toBe(as);
    expect(error.message).not.toContain('SECRET');
  });

  it('a device that is not on this account leaves this computer connected', async () => {
    const f = await setup({ backend: () => failure(404, 'device_not_found') });
    await revoke(f, gone);
    expect(f.cloud.status().state).toBe('connected');
  });

  it('is refused for a page that is not AASC\'s own, before the backend is asked', async () => {
    const f = await setup({ backend: revoking, isLocalRequest: () => true });
    for (const site of ['same-site', 'cross-site']) {
      const res = await revoke(f, mini, { ...f.binding(), 'sec-fetch-site': site });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('forbidden');
    }
    expect((await revoke(f, mini, { ...f.binding(), origin: 'http://127.0.0.1:9' })).status).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it('answers nothing else under /account/devices, and leaves the account\'s other routes alone', async () => {
    const f = await setup({ backend: revoking });
    expect((await fetch(`${f.url}/${mini}`)).status).toBe(404);
    expect((await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${f.url}/${mini}/extra`, { method: 'DELETE', headers: f.binding() })).status).toBe(404);
    expect((await fetch(f.url.replace(/\/account\/devices$/, '/status'))).status).toBe(200);
    expect(f.calls).toEqual([]);
  });
});

describe('the device rows other callers read (devices.ts)', () => {
  it('still parse a row that says only what they need, and are not failed by a new field of an odd shape', async () => {
    const f = await setup({ backend: () => page([
      { id: mini, kind: 'phone', createdByCode: gone, revokedAt: null },
      { id: phone, kind: 'phone', createdByCode: null, revokedAt: null, name: 7, platform: {}, createdAt: 5, lastUsedAt: [] },
    ]) });
    const first = await listBackendDevices(f.cloud.client);
    expect(first.devices.map((d) => [d.id, d.kind, d.createdByCode])).toEqual([[mini, 'phone', gone], [phone, 'phone', null]]);
    expect((await findDeviceByPairingCode(f.cloud.client, gone))?.id).toBe(mini);
  });
});
