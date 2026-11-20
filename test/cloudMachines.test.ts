// test/cloudMachines.test.ts — plan 18, stage 2: this computer's five calls under /v1/machines.
//
// Through the server-owned cloud connection, against a fake backend (no network): list the account's computers,
// publish and withdraw this computer's addresses, ask a ticket for another computer, redeem a ticket that names
// this one. Only those five method + path pairs are allowed. Every answer is validated and rebuilt from known
// fields; a revoked CLIENT (401 client_revoked on the redeem) must never read as this computer's own connection
// being revoked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { allowedCloudRoute } from '../server/cloud/client.js';
import { CloudError } from '../server/cloud/types.js';
import { EnrollRedeemError, redeemEnrollTicket } from '../server/cloud/enroll.js';
import {
  MachineRedeemError, listAccountMachines, publishMachinePaths, redeemMachineTicket, requestMachineTicket,
  withdrawMachinePaths,
} from '../server/cloud/machines.js';

const owner = '00000000-0000-4000-8000-000000000001';
const self = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const client = '00000000-0000-4000-8000-000000000004';
const token = 't'.repeat(43);
const origin = 'https://backend.example';
const TICKET = 'k'.repeat(43);
const SEAL_SECRET = 's'.repeat(43);
const CLIENT_KEY = `B${'p'.repeat(86)}`;
const KEY_HASH = 'ab'.repeat(32);
const AT = '2026-11-20T01:02:03.000Z';

const MACHINE = {
  deviceId: other, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.10.81', lastUsedAt: AT,
  current: false, connectable: true, relation: 'self',
  paths: { lan: '192.168.1.57', tailnet: '100.101.102.103', public: null, port: 3333, updatedAt: AT },
};
const SELF_MACHINE = {
  deviceId: self, name: 'MacBook Pro', platform: 'macos', edition: 'lite', appVersion: null, lastUsedAt: null,
  current: true, connectable: true, relation: 'self', paths: null,
};
const REDEEMED = {
  clientDeviceId: client, clientName: 'Kason’s MacBook Pro', clientKind: 'server', clientPlatform: 'macos',
  email: 'me@example.com', clientKeyHash: KEY_HASH, sealSecret: SEAL_SECRET, relation: 'self',
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

type Route = (call: { method: string; path: string; body: unknown }) => Response;
async function connected(route: Route) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-machines-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ path: url.pathname, method, body, auth: headers.get('authorization') });
    if (url.pathname === '/v1/devices/pair')
      return Response.json({ success: true, data: { token, ownerId: owner, deviceId: self } });
    return route({ method, path: url.pathname, body });
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'),
    secrets: createFileSecretStore(join(dir, 'secrets')),
    fetch: fetcher as unknown as typeof fetch,
  });
  cleanups.push(() => cloud.stop());
  await cloud.connectCloud({ backendUrl: origin, pairingCode: 'c'.repeat(22), deviceName: 'Mac' });
  calls.length = 0;
  return { cloud, calls };
}

const ok = (data: unknown) => () => Response.json({ success: true, data });
const failure = (status: number, code: string, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${token}` } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

async function cloudErrorOf(promise: Promise<unknown>): Promise<CloudError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudError);
    expect(String((error as Error).message)).not.toContain('SECRET');
    return error as CloudError;
  }
  throw new Error('expected a refusal');
}

async function redeemReasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MachineRedeemError);
    expect(String((error as Error).message)).not.toContain('SECRET');
    return (error as MachineRedeemError).reason;
  }
  throw new Error('expected a refusal');
}

describe('the cloud allow-list (plan 18, stage 2)', () => {
  const ALLOWED: ReadonlyArray<readonly [string, string]> = [
    ['GET', '/v1/machines'],
    ['PUT', '/v1/machines/self'],
    ['DELETE', '/v1/machines/self'],
    ['POST', '/v1/machines/tickets'],
    ['POST', '/v1/machines/tickets/redeem'],
  ];
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
  const PATHS = ['/v1/machines', '/v1/machines/self', '/v1/machines/tickets', '/v1/machines/tickets/redeem'];

  it('lets exactly five method + path pairs through', () => {
    for (const path of PATHS) {
      for (const method of METHODS) {
        const expected = ALLOWED.some(([m, p]) => m === method && p === path);
        expect(allowedCloudRoute(method, path), `${method} ${path}`).toBe(expected);
      }
    }
  });

  it.each([
    '/v1/machines/',
    `/v1/machines/${other}`,
    `/v1/machines/${other}/paths`,
    '/v1/machines/self/extra',
    '/v1/machines/tickets/redeem/extra',
    '/v1/machines/tickets/../self',
    '/v1/machines/Self',
    '/v1/machine',
    '/v1/machines-admin',
  ])('refuses every method on %s', (path) => {
    for (const method of METHODS) expect(allowedCloudRoute(method, path), `${method} ${path}`).toBe(false);
  });
});

describe('listAccountMachines', () => {
  it('asks with this computer\'s token and answers the validated list', async () => {
    const f = await connected(ok({ machines: [MACHINE, SELF_MACHINE] }));
    await expect(listAccountMachines(f.cloud.client)).resolves.toEqual([MACHINE, SELF_MACHINE]);
    expect(f.calls).toEqual([{ path: '/v1/machines', method: 'GET', body: undefined, auth: `Bearer ${token}` }]);
  });

  it('drops fields the backend added later, at every level', async () => {
    const f = await connected(ok({
      machines: [{ ...MACHINE, addedLater: 1, paths: { ...MACHINE.paths, httpsOrigin: 'https://x.example' } }],
      nextCursor: 'x',
    }));
    await expect(listAccountMachines(f.cloud.client)).resolves.toEqual([MACHINE]);
  });

  it('leaves out a computer whose relation this build does not know (groups come later)', async () => {
    const f = await connected(ok({ machines: [{ ...MACHINE, relation: 'group' }, SELF_MACHINE] }));
    await expect(listAccountMachines(f.cloud.client)).resolves.toEqual([SELF_MACHINE]);
  });

  it.each([
    ['a device id that is no uuid', { ...MACHINE, deviceId: 'mac-1' }],
    ['an upper-case device id', { ...MACHINE, deviceId: other.toUpperCase().replace(/0/g, 'A') }],
    ['a name that is no string', { ...MACHINE, name: 7 }],
    ['a public address as the home-network one', { ...MACHINE, paths: { ...MACHINE.paths, lan: '45.63.31.79' } }],
    ['the cloud metadata address', { ...MACHINE, paths: { ...MACHINE.paths, lan: '169.254.169.254' } }],
    ['a leading-zero octet', { ...MACHINE, paths: { ...MACHINE.paths, lan: '192.168.001.57' } }],
    ['a Tailscale address outside 100.64.0.0/10', { ...MACHINE, paths: { ...MACHINE.paths, tailnet: '100.20.1.1' } }],
    ['a private address as the public one', { ...MACHINE, paths: { ...MACHINE.paths, public: '10.0.0.5' } }],
    ['a host name as an address', { ...MACHINE, paths: { ...MACHINE.paths, public: 'evil.example' } }],
    ['port 0', { ...MACHINE, paths: { ...MACHINE.paths, port: 0 } }],
    ['port 70000', { ...MACHINE, paths: { ...MACHINE.paths, port: 70000 } }],
    ['a missing connectable', { ...MACHINE, connectable: undefined }],
    ['a relation that is no string', { ...MACHINE, relation: 1 }],
    ['an entry that is no object', 'Mac mini'],
  ])('refuses the whole answer for %s', async (_label, machine) => {
    const f = await connected(ok({ machines: [machine] }));
    expect((await cloudErrorOf(listAccountMachines(f.cloud.client))).code).toBe('invalid_response');
  });

  it('refuses more than 50 computers and an answer with no list', async () => {
    const many = Array.from({ length: 51 }, () => MACHINE);
    const f = await connected(ok({ machines: many }));
    expect((await cloudErrorOf(listAccountMachines(f.cloud.client))).code).toBe('invalid_response');
    const g = await connected(ok({}));
    expect((await cloudErrorOf(listAccountMachines(g.cloud.client))).code).toBe('invalid_response');
  });

  it('answers needs_sign_in for a 403 (a sign-in from before the backend listed computers), still connected', async () => {
    const f = await connected(failure(403, 'forbidden'));
    const error = await cloudErrorOf(listAccountMachines(f.cloud.client));
    expect(error).toMatchObject({ code: 'needs_sign_in', status: 403 });
    expect(f.cloud.status().state).toBe('connected');
  });

  it('answers unsupported for a backend without the service', async () => {
    const f = await connected(failure(404, 'not_found'));
    expect(await cloudErrorOf(listAccountMachines(f.cloud.client))).toMatchObject({ code: 'unsupported', status: 404 });
  });
});

describe('publishMachinePaths', () => {
  it('sends only the addresses it was given, and the port', async () => {
    const f = await connected(ok({ updatedAt: AT }));
    await expect(publishMachinePaths(f.cloud.client, { lan: '192.168.1.57', tailnet: null, port: 3333 }))
      .resolves.toEqual({ updatedAt: AT });
    expect(f.calls).toEqual([
      { path: '/v1/machines/self', method: 'PUT', body: { lan: '192.168.1.57', port: 3333 }, auth: `Bearer ${token}` },
    ]);
  });

  it('sends all three kinds when it has them', async () => {
    const f = await connected(ok({ updatedAt: AT }));
    await publishMachinePaths(f.cloud.client, { lan: '10.0.0.5', tailnet: '100.64.0.1', public: '45.63.31.79', port: 8443 });
    expect(f.calls[0].body).toEqual({ lan: '10.0.0.5', tailnet: '100.64.0.1', public: '45.63.31.79', port: 8443 });
  });

  it.each([
    ['no address at all', { port: 3333 }],
    ['only null addresses', { lan: null, tailnet: null, public: null, port: 3333 }],
    ['a public address as the home-network one', { lan: '45.63.31.79', port: 3333 }],
    ['the cloud metadata address', { lan: '169.254.169.254', port: 3333 }],
    ['another VPN\'s address as Tailscale\'s', { tailnet: '10.8.0.2', port: 3333 }],
    ['a private address as the public one', { public: '192.168.1.57', port: 3333 }],
    ['a Tailscale address as the public one', { public: '100.101.102.103', port: 3333 }],
    ['port 0', { lan: '192.168.1.57', port: 0 }],
    ['a port that is no integer', { lan: '192.168.1.57', port: 33.5 }],
    ['an extra field', { lan: '192.168.1.57', port: 3333, name: 'Mac' }],
  ])('refuses %s before any request', async (_label, input) => {
    const f = await connected(ok({ updatedAt: AT }));
    const error = await cloudErrorOf(publishMachinePaths(f.cloud.client, input as Parameters<typeof publishMachinePaths>[1]));
    expect(error).toMatchObject({ code: 'invalid_input', status: 400 });
    expect(f.calls).toEqual([]);
  });

  it('refuses an answer that is not { updatedAt }', async () => {
    const f = await connected(ok({ updatedAt: 'yesterday' }));
    expect((await cloudErrorOf(publishMachinePaths(f.cloud.client, { lan: '192.168.1.57', port: 3333 }))).code)
      .toBe('invalid_response');
  });

  it('passes a 403 through as forbidden, still connected', async () => {
    const f = await connected(failure(403, 'forbidden'));
    const error = await cloudErrorOf(publishMachinePaths(f.cloud.client, { lan: '192.168.1.57', port: 3333 }));
    expect(error).toMatchObject({ code: 'forbidden', status: 403 });
    expect(f.cloud.status().state).toBe('connected');
  });
});

describe('withdrawMachinePaths', () => {
  it('sends DELETE with no body and answers whether a row went', async () => {
    const f = await connected(ok({ withdrawn: true }));
    await expect(withdrawMachinePaths(f.cloud.client)).resolves.toEqual({ withdrawn: true });
    expect(f.calls).toEqual([{ path: '/v1/machines/self', method: 'DELETE', body: undefined, auth: `Bearer ${token}` }]);
  });

  it('refuses an answer of another shape', async () => {
    const f = await connected(ok({ withdrawn: 'yes' }));
    expect((await cloudErrorOf(withdrawMachinePaths(f.cloud.client))).code).toBe('invalid_response');
  });
});

describe('requestMachineTicket', () => {
  const TICKET_ANSWER = { ticket: TICKET, sealSecret: SEAL_SECRET, expiresAt: AT };

  it('asks for a ticket naming the computer and this client\'s key', async () => {
    const f = await connected(ok({ ...TICKET_ANSWER, addedLater: true }));
    await expect(requestMachineTicket(f.cloud.client, { machineId: other, clientKey: CLIENT_KEY })).resolves.toEqual(TICKET_ANSWER);
    expect(f.calls).toEqual([
      { path: '/v1/machines/tickets', method: 'POST', body: { machineId: other, clientKey: CLIENT_KEY }, auth: `Bearer ${token}` },
    ]);
  });

  it.each([
    ['a machine id that is no uuid', { machineId: 'mac-1', clientKey: CLIENT_KEY }],
    ['a short key', { machineId: other, clientKey: 'p'.repeat(86) }],
    ['a padded key', { machineId: other, clientKey: `${'p'.repeat(86)}=` }],
  ])('refuses %s before any request', async (_label, input) => {
    const f = await connected(ok(TICKET_ANSWER));
    expect(await cloudErrorOf(requestMachineTicket(f.cloud.client, input))).toMatchObject({ code: 'invalid_input', status: 400 });
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['a short ticket', { ...TICKET_ANSWER, ticket: 'k'.repeat(42) }],
    ['a missing seal secret', { ...TICKET_ANSWER, sealSecret: undefined }],
    ['an expiry that is no time', { ...TICKET_ANSWER, expiresAt: 'soon' }],
  ])('refuses an answer with %s', async (_label, data) => {
    const f = await connected(ok(data));
    expect((await cloudErrorOf(requestMachineTicket(f.cloud.client, { machineId: other, clientKey: CLIENT_KEY }))).code)
      .toBe('invalid_response');
  });

  it('says machine_not_found for a computer that is not this account\'s (or is this one)', async () => {
    const f = await connected(failure(404, 'machine_not_found'));
    const error = await cloudErrorOf(requestMachineTicket(f.cloud.client, { machineId: other, clientKey: CLIENT_KEY }));
    expect(error).toMatchObject({ code: 'machine_not_found', status: 404 });
    expect(f.cloud.status().state).toBe('connected');
  });

  it('passes the backend\'s rate limit through with its wait', async () => {
    const f = await connected(failure(429, 'rate_limited', { 'retry-after': '42' }));
    const error = await cloudErrorOf(requestMachineTicket(f.cloud.client, { machineId: other, clientKey: CLIENT_KEY }));
    expect(error).toMatchObject({ code: 'rate_limited', status: 429, retryAfterMs: 42_000 });
  });

  it('answers needs_sign_in for a 403', async () => {
    const f = await connected(failure(403, 'forbidden'));
    expect(await cloudErrorOf(requestMachineTicket(f.cloud.client, { machineId: other, clientKey: CLIENT_KEY })))
      .toMatchObject({ code: 'needs_sign_in', status: 403 });
  });
});

describe('redeemMachineTicket', () => {
  const { clientPlatform: _clientPlatform, relation: _relation, ...KEPT } = REDEEMED;

  it('sends the ticket with this computer\'s token and returns who asked', async () => {
    const f = await connected(ok(REDEEMED));
    await expect(redeemMachineTicket(f.cloud.client, TICKET)).resolves.toEqual(KEPT);
    expect(f.calls).toEqual([
      { path: '/v1/machines/tickets/redeem', method: 'POST', body: { ticket: TICKET }, auth: `Bearer ${token}` },
    ]);
    expect(f.cloud.status().state).toBe('connected');
  });

  it('accepts an account with no email and a client of no known kind', async () => {
    const f = await connected(ok({ ...REDEEMED, email: null, clientKind: null }));
    await expect(redeemMachineTicket(f.cloud.client, TICKET)).resolves.toMatchObject({ email: null, clientKind: null });
  });

  it.each([
    ['a ticket of the wrong length', 'k'.repeat(42)],
    ['a ticket with padding', `${'k'.repeat(42)}=`],
    ['a ticket with a path character', `${'k'.repeat(42)}/`],
  ])('refuses %s before any request', async (_label, ticket) => {
    const f = await connected(ok(REDEEMED));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, ticket))).toBe('invalid');
    expect(f.calls).toEqual([]);
  });

  it.each([
    [404, 'ticket_invalid', 'invalid'],
    [410, 'ticket_expired', 'expired'],
    [409, 'ticket_used', 'used'],
    [401, 'client_revoked', 'client-revoked'],
    [429, 'rate_limited', 'cloud-failed'],
    [500, 'internal', 'cloud-failed'],
    [404, 'not_found', 'cloud-failed'],
    [403, 'forbidden', 'cloud-failed'],
    [410, 'ticket_used', 'cloud-failed'], // a known code at the wrong status is not believed
    [404, 'client_revoked', 'cloud-failed'],
  ])('maps %i %s to %s', async (status, code, reason) => {
    const f = await connected(failure(status, code));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, TICKET))).toBe(reason);
  });

  it('keeps this computer connected when the CLIENT was revoked', async () => {
    const f = await connected(failure(401, 'client_revoked'));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, TICKET))).toBe('client-revoked');
    expect(f.cloud.status().state).toBe('connected');
  });

  it('reads this computer\'s own 401 as a failed cloud call: its connection is revoked, as for any route', async () => {
    const f = await connected(failure(401, 'unauthorized'));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
    expect(f.cloud.status().state).toBe('revoked');
  });

  it('believes each redeem route\'s own code only: a phone\'s code here, or a client\'s there, is this computer\'s 401', async () => {
    const f = await connected(failure(401, 'phone_revoked'));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
    expect(f.cloud.status().state).toBe('revoked');
    const g = await connected(failure(401, 'client_revoked'));
    await expect(redeemEnrollTicket(g.cloud.client, TICKET)).rejects.toBeInstanceOf(EnrollRedeemError);
    expect(g.cloud.status().state).toBe('revoked');
  });

  it('drops a field the backend added later instead of refusing (the ticket is already used)', async () => {
    const f = await connected(ok({ ...REDEEMED, addedLater: { x: 1 } }));
    await expect(redeemMachineTicket(f.cloud.client, TICKET)).resolves.toEqual(KEPT);
  });

  it.each([
    ['a missing sealSecret', { ...REDEEMED, sealSecret: undefined }],
    ['a short sealSecret', { ...REDEEMED, sealSecret: 's'.repeat(42) }],
    ['a missing key hash', { ...REDEEMED, clientKeyHash: undefined }],
    ['an upper-case key hash', { ...REDEEMED, clientKeyHash: 'AB'.repeat(32) }],
    ['a client id that is no uuid', { ...REDEEMED, clientDeviceId: 'laptop-1' }],
    ['a client kind this build does not know', { ...REDEEMED, clientKind: 'watch' }],
    ['a relation other than self (a group member is never a paired computer)', { ...REDEEMED, relation: 'group' }],
    ['no relation at all', { ...REDEEMED, relation: undefined }],
  ])('answers cloud-failed for %s', async (_label, data) => {
    const f = await connected(ok(data));
    expect(await redeemReasonOf(redeemMachineTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
  });

  it('answers cloud-failed with no connection, without a request', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-machines-')));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fetcher = vi.fn();
    const cloud = await createCloudConnection({
      directory: join(dir, 'cloud'),
      secrets: createFileSecretStore(join(dir, 'secrets')),
      fetch: fetcher as unknown as typeof fetch,
    });
    cleanups.push(() => cloud.stop());
    expect(await redeemReasonOf(redeemMachineTicket(cloud.client, TICKET))).toBe('cloud-failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
