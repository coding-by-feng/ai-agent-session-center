// POST /v1/push/notify and POST /v1/devices/pairing-codes through the
// server-owned cloud connection, against a fake backend (no network). Shapes
// follow the backend's contract v1 fixtures (v1-push.json, v1-phone-pairing.json).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { createPhonePairingCode, notifyPush, type PushNotifyInput } from '../server/cloud/devices.js';
import type { PushMessage } from '../server/push/pushNotifier.js';

const owner = '00000000-0000-4000-8000-000000000001';
const device = '00000000-0000-4000-8000-000000000002';
const token = 't'.repeat(43);
const origin = 'https://backend.example';
const message: PushNotifyInput = {
  mutationId: '00000000-0000-4000-8000-000000000011',
  kind: 'approval',
  sessionRef: 'term-1',
  title: 'Fixture session',
  toolName: 'Bash',
  collapseKey: 'approval:term-1',
  ttlSeconds: 600,
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

type Route = (body: unknown, headers: Headers) => Response;
async function connected(routes: Record<string, Route>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-cloud-devices-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const calls: { path: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body, auth: headers.get('authorization') });
    if (url.origin !== origin) throw new Error('unexpected origin');
    if (url.pathname === '/v1/devices/pair')
      return Response.json({ success: true, data: { token, ownerId: owner, deviceId: device } });
    const route = routes[url.pathname];
    if (!route) return new Response('{}', { status: 404 });
    return route(body, headers);
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'),
    secrets: createFileSecretStore(join(dir, 'secrets')),
    fetch: fetcher as unknown as typeof fetch,
  });
  cleanups.push(() => cloud.stop());
  await cloud.connectCloud({ backendUrl: origin, pairingCode: 'c'.repeat(22), deviceName: 'Mac' });
  calls.length = 0;
  return { cloud, calls, fetcher };
}
const failure = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({ success: false, error: { code, message: `SECRET backend text ${token}` } }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );

describe('notifyPush', () => {
  it('sends the typed message with the device token and validates the result', async () => {
    const f = await connected({
      '/v1/push/notify': () =>
        Response.json({ success: true, data: { sent: 1, failed: 0, disabled: 0, extra: 'dropped' } }),
    });
    await expect(notifyPush(f.cloud.client, message)).resolves.toEqual({ sent: 1, failed: 0, disabled: 0 });
    expect(f.calls).toEqual([
      { path: '/v1/push/notify', method: 'POST', body: message, auth: `Bearer ${token}` },
    ]);
  });
  it('accepts the Mac push notifier message shape', async () => {
    const f = await connected({
      '/v1/push/notify': () => Response.json({ success: true, data: { sent: 0, failed: 0, disabled: 1 } }),
    });
    const fromNotifier: PushMessage = { ...message, kind: 'finished', toolName: undefined };
    delete fromNotifier.toolName;
    await expect(notifyPush(f.cloud.client, fromNotifier)).resolves.toMatchObject({ disabled: 1 });
  });
  it.each([
    ['uppercase mutation id', { mutationId: 'AAAAAAAA-0000-4000-8000-000000000011' }],
    ['unknown kind', { kind: 'marketing' }],
    ['bidi override in title', { title: 'safe\u202Etxt.exe' }],
    ['control character in title', { title: 'line\nbreak' }],
    ['blank title', { title: '   ' }],
    ['title over 80 characters', { title: 'x'.repeat(81) }],
    ['bad session ref', { sessionRef: '../etc' }],
    ['ttl over an hour', { ttlSeconds: 3601 }],
    ['extra prompt text', { prompt: 'secret prompt' }],
  ])('refuses %s locally, before any request', async (_label, patch) => {
    const f = await connected({});
    await expect(
      notifyPush(f.cloud.client, { ...message, ...patch } as PushNotifyInput),
    ).rejects.toMatchObject({ code: 'invalid_input', status: 400 });
    expect(f.calls).toEqual([]);
  });
  it.each([
    [503, 'push_unconfigured', {}, undefined],
    [429, 'push_collapsed', { 'retry-after': '30' }, 30_000],
    [429, 'rate_limited', { 'retry-after': '5' }, 5_000],
  ] as const)('maps HTTP %s %s without backend text', async (status, code, headers, retryAfterMs) => {
    const f = await connected({ '/v1/push/notify': () => failure(status, code, headers) });
    const error = await notifyPush(f.cloud.client, message).catch((e: unknown) => e);
    expect(error).toMatchObject({ code, status, retryAfterMs });
    expect(String((error as Error).message)).not.toContain('SECRET');
    expect(f.cloud.status().state).toBe('connected');
  });
  it('a missing push:send scope is forbidden, not a crash', async () => {
    const f = await connected({ '/v1/push/notify': () => failure(403, 'forbidden') });
    await expect(notifyPush(f.cloud.client, message)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });
  it('a malformed success is rejected', async () => {
    const f = await connected({
      '/v1/push/notify': () => Response.json({ success: true, data: { sent: -1, failed: 0, disabled: 0 } }),
    });
    await expect(notifyPush(f.cloud.client, message)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('after disconnect nothing is sent', async () => {
    const f = await connected({
      '/v1/push/notify': () => Response.json({ success: true, data: { sent: 1, failed: 0, disabled: 0 } }),
    });
    await f.cloud.disconnectCloud();
    const before = f.fetcher.mock.calls.length;
    await expect(notifyPush(f.cloud.client, message)).rejects.toMatchObject({ code: 'disconnected' });
    expect(f.fetcher.mock.calls.length).toBe(before);
  });
});

describe('createPhonePairingCode', () => {
  const minted = {
    code: 'A'.repeat(22),
    codeRef: '00000000-0000-4000-8000-000000000003',
    expiresAt: '2026-10-15T00:10:00.000Z',
  };
  it('asks for a phone code with the given scopes and validates the answer', async () => {
    const f = await connected({
      '/v1/devices/pairing-codes': () => Response.json({ success: true, data: minted }),
    });
    await expect(
      createPhonePairingCode(f.cloud.client, { scopes: ['push:register', 'relay:connect'], ttlSeconds: 600 }),
    ).resolves.toEqual(minted);
    expect(f.calls).toEqual([
      {
        path: '/v1/devices/pairing-codes',
        method: 'POST',
        body: { kind: 'phone', scopes: ['push:register', 'relay:connect'], ttlSeconds: 600 },
        auth: `Bearer ${token}`,
      },
    ]);
  });
  it('passes scope names this build does not know yet; the backend decides', async () => {
    const f = await connected({
      '/v1/devices/pairing-codes': () => Response.json({ success: true, data: minted }),
    });
    await createPhonePairingCode(f.cloud.client, { scopes: ['future-area:connect'] });
    expect(f.calls[0].body).toEqual({ kind: 'phone', scopes: ['future-area:connect'] });
  });
  it.each([
    ['no scopes', { scopes: [] }],
    ['duplicate scopes', { scopes: ['push:register', 'push:register'] }],
    ['malformed scope', { scopes: ['push register'] }],
    ['ttl under a minute', { scopes: ['push:register'], ttlSeconds: 59 }],
    ['ttl over ten minutes', { scopes: ['push:register'], ttlSeconds: 601 }],
    ['a device kind override', { scopes: ['push:register'], kind: 'server' }],
  ])('refuses %s locally, before any request', async (_label, input) => {
    const f = await connected({});
    await expect(
      createPhonePairingCode(f.cloud.client, input as { scopes: string[] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(f.calls).toEqual([]);
  });
  it.each([
    [409, 'pairing_codes_outstanding', 'pairing_codes_outstanding'],
    [429, 'rate_limited', 'rate_limited'],
    [403, 'pairing_scope_forbidden', 'forbidden'],
  ] as const)('maps HTTP %s %s', async (status, remote, code) => {
    const f = await connected({ '/v1/devices/pairing-codes': () => failure(status, remote) });
    const error = await createPhonePairingCode(f.cloud.client, { scopes: ['push:register'] }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code, status });
    expect(String((error as Error).message)).not.toContain('SECRET');
  });
  it('a code that does not match the contract is rejected', async () => {
    const f = await connected({
      '/v1/devices/pairing-codes': () => Response.json({ success: true, data: { ...minted, code: 'short' } }),
    });
    await expect(
      createPhonePairingCode(f.cloud.client, { scopes: ['push:register'] }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
