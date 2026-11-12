// test/cloudEnroll.test.ts — plan 17: this Mac redeems a phone's enroll ticket at the backend.
//
// POST /v1/enroll/tickets/redeem through the server-owned cloud connection, against a fake backend (no network).
// Only that one route under /v1/enroll is this Mac's to call: the Mac list and the ticket mint are the phone's own.
// Each backend refusal becomes one typed reason; a revoked PHONE (401 phone_revoked) must never read as this Mac's
// own connection being revoked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { allowedCloudRoute } from '../server/cloud/client.js';
import { EnrollRedeemError, redeemEnrollTicket } from '../server/cloud/enroll.js';

const owner = '00000000-0000-4000-8000-000000000001';
const mac = '00000000-0000-4000-8000-000000000002';
const phone = '00000000-0000-4000-8000-000000000003';
const token = 't'.repeat(43);
const origin = 'https://backend.example';
const TICKET = 'k'.repeat(43);
const KEY_HASH = 'ab'.repeat(32);
const SEAL_SECRET = 's'.repeat(43);
const REDEEMED = {
  phoneDeviceId: phone, phoneName: 'Kason iPhone', email: 'me@example.com', phoneKeyHash: KEY_HASH, sealSecret: SEAL_SECRET,
};

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

type Route = (body: unknown) => Response;
async function connected(route: Route) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-enroll-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body, auth: headers.get('authorization') });
    if (url.pathname === '/v1/devices/pair')
      return Response.json({ success: true, data: { token, ownerId: owner, deviceId: mac } });
    if (url.pathname === '/v1/enroll/tickets/redeem') return route(body);
    return new Response('{}', { status: 404 });
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

const failure = (status: number, code: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${token}` } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnrollRedeemError);
    expect(String((error as Error).message)).not.toContain('SECRET');
    return (error as EnrollRedeemError).reason;
  }
  throw new Error('expected a refusal');
}

describe('the cloud allow-list (plan 17)', () => {
  it('lets this Mac POST the redeem route and nothing else under /v1/enroll', () => {
    expect(allowedCloudRoute('POST', '/v1/enroll/tickets/redeem')).toBe(true);
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      expect(allowedCloudRoute(method, '/v1/enroll/tickets/redeem')).toBe(false);
    }
    expect(allowedCloudRoute('GET', '/v1/enroll/macs')).toBe(false);
    expect(allowedCloudRoute('POST', '/v1/enroll/tickets')).toBe(false);
    expect(allowedCloudRoute('POST', '/v1/enroll/tickets/redeem/extra')).toBe(false);
    expect(allowedCloudRoute('POST', '/v1/enroll/tickets/../tickets/redeem')).toBe(false);
  });
});

describe('redeemEnrollTicket', () => {
  it('sends the ticket with this Mac\'s token and returns the redeemed phone', async () => {
    const f = await connected(() => Response.json({ success: true, data: REDEEMED }));
    await expect(redeemEnrollTicket(f.cloud.client, TICKET)).resolves.toEqual(REDEEMED);
    expect(f.calls).toEqual([
      { path: '/v1/enroll/tickets/redeem', method: 'POST', body: { ticket: TICKET }, auth: `Bearer ${token}` },
    ]);
    expect(f.cloud.status().state).toBe('connected');
  });

  it('accepts an account with no email', async () => {
    const f = await connected(() => Response.json({ success: true, data: { ...REDEEMED, email: null } }));
    await expect(redeemEnrollTicket(f.cloud.client, TICKET)).resolves.toMatchObject({ email: null });
  });

  it.each([
    ['a ticket of the wrong length', 'k'.repeat(42)],
    ['a ticket with padding', `${'k'.repeat(42)}=`],
    ['a ticket with a path character', `${'k'.repeat(42)}/`],
  ])('refuses %s before any request', async (_label, ticket) => {
    const f = await connected(() => Response.json({ success: true, data: REDEEMED }));
    expect(await reasonOf(redeemEnrollTicket(f.cloud.client, ticket))).toBe('invalid');
    expect(f.calls).toEqual([]);
  });

  it.each([
    [404, 'ticket_invalid', 'invalid'],
    [410, 'ticket_expired', 'expired'],
    [409, 'ticket_used', 'used'],
    [401, 'phone_revoked', 'phone-revoked'],
    [429, 'rate_limited', 'cloud-failed'],
    [500, 'internal', 'cloud-failed'],
    [404, 'not_found', 'cloud-failed'],
    [410, 'ticket_used', 'cloud-failed'], // a known code at the wrong status is not believed
  ])('maps %i %s to %s', async (status, code, reason) => {
    const f = await connected(() => failure(status, code));
    expect(await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET))).toBe(reason);
  });

  it('keeps this Mac connected when the PHONE was revoked', async () => {
    const f = await connected(() => failure(401, 'phone_revoked'));
    await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET));
    expect(f.cloud.status().state).toBe('connected');
  });

  it('keeps this Mac connected through a ticket refusal', async () => {
    const f = await connected(() => failure(404, 'ticket_invalid'));
    await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET));
    expect(f.cloud.status().state).toBe('connected');
  });

  it.each([
    [403, 'forbidden'],
    [400, 'invalid_request'],
  ])('answers cloud-failed for %i %s and keeps this Mac connected', async (status, code) => {
    const f = await connected(() => failure(status, code));
    expect(await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
    expect(f.cloud.status().state).toBe('connected');
  });

  it('reads this Mac\'s own 401 as a failed cloud call (its connection is revoked, as for any route)', async () => {
    const f = await connected(() => failure(401, 'unauthorized'));
    expect(await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
    expect(f.cloud.status().state).toBe('revoked');
  });

  it('drops a field the backend added later instead of refusing (the ticket is already used)', async () => {
    const f = await connected(() => Response.json({ success: true, data: { ...REDEEMED, addedLater: { x: 1 } } }));
    await expect(redeemEnrollTicket(f.cloud.client, TICKET)).resolves.toEqual(REDEEMED);
  });

  it.each([
    ['a missing sealSecret', { ...REDEEMED, sealSecret: undefined }],
    ['a short sealSecret', { ...REDEEMED, sealSecret: 's'.repeat(42) }],
    ['a padded sealSecret', { ...REDEEMED, sealSecret: `${'s'.repeat(42)}=` }],
    ['a missing key hash', { ...REDEEMED, phoneKeyHash: undefined }],
    ['an upper-case key hash', { ...REDEEMED, phoneKeyHash: 'AB'.repeat(32) }],
    ['a phone id that is no uuid', { ...REDEEMED, phoneDeviceId: 'phone-1' }],
  ])('answers cloud-failed for %s', async (_label, data) => {
    const f = await connected(() => Response.json({ success: true, data }));
    expect(await reasonOf(redeemEnrollTicket(f.cloud.client, TICKET))).toBe('cloud-failed');
  });

  it('answers cloud-failed with no connection', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-enroll-')));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const fetcher = vi.fn();
    const cloud = await createCloudConnection({
      directory: join(dir, 'cloud'),
      secrets: createFileSecretStore(join(dir, 'secrets')),
      fetch: fetcher as unknown as typeof fetch,
    });
    cleanups.push(() => cloud.stop());
    expect(await reasonOf(redeemEnrollTicket(cloud.client, TICKET))).toBe('cloud-failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
