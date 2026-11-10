import { afterEach, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { authorizeHosted } from '../server/hostedAuthority.js';
import type { HostedConfig } from '../server/hostedConfig.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('never reuses a verification approval as fulfilled-use authority for the same owner', async () => {
  const hosted = config();
  vi.stubGlobal('fetch', async (_url: string, options: RequestInit) => {
    const { assertion } = JSON.parse(options.body as string);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    return new Response(JSON.stringify({ authorized: claims.accessMode === 'verify' }));
  });
  expect(
    await authorizeHosted(hosted, { sub: 'customer:opaque', ownerEpoch: 1, accessMode: 'verify' }),
  ).toBe(true);
  expect(
    await authorizeHosted(hosted, { sub: 'customer:opaque', ownerEpoch: 1, accessMode: 'use' }),
  ).toBe(false);
});
function config(): HostedConfig {
  return {
    orderId: '63d17688-d822-4387-b876-9d081278849d',
    websiteOrigin: 'https://xclaude.dev',
    runtimeOrigin: 'https://order.example.com',
    launchKey: 'a'.repeat(64),
    dataDir: `/tmp/${randomUUID()}`,
  };
}
it('signs an exact runtime-to-website assertion without forwarding customer cookies', async () => {
  const hosted = config();
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    expect(url).toBe('https://xclaude.dev/api/runtime/authorize');
    expect(options.redirect).toBe('error');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    const { assertion } = JSON.parse(options.body as string);
    const [head, body, sig] = assertion.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(sig).toBe(
      createHmac('sha256', 'a'.repeat(64)).update(`${head}.${body}`).digest('base64url'),
    );
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    expect(claims).toMatchObject({
      purpose: 'authorize',
      iss: 'https://order.example.com',
      aud: 'https://xclaude.dev',
      sub: 'customer:opaque',
      ownerEpoch: 1,
      accessMode: 'use',
      orderId: hosted.orderId,
    });
    expect(claims.exp - claims.iat).toBe(30);
    return new Response(JSON.stringify({ authorized: true }));
  });
  expect(
    await authorizeHosted(hosted, {
      sub: 'customer:opaque',
      ownerEpoch: 1,
      accessMode: 'use' as const,
    }),
  ).toBe(true);
});
it('bounds positive caching, forces fresh launch/refresh checks and denies revoked authority', async () => {
  vi.useFakeTimers();
  const hosted = config();
  const identity = { sub: 'guest:opaque', ownerEpoch: 0, accessMode: 'use' as const };
  let calls = 0;
  let allowed = true;
  vi.stubGlobal('fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ authorized: allowed }));
  });
  expect(await authorizeHosted(hosted, identity)).toBe(true);
  expect(await authorizeHosted(hosted, identity)).toBe(true);
  expect(calls).toBe(1);
  allowed = false;
  expect(await authorizeHosted(hosted, identity, true)).toBe(false);
  expect(await authorizeHosted(hosted, identity)).toBe(false);
  allowed = true;
  expect(await authorizeHosted(hosted, identity)).toBe(true);
  allowed = false;
  vi.advanceTimersByTime(20_001);
  expect(await authorizeHosted(hosted, identity)).toBe(false);
});
it('fails closed on network failure, malformed JSON, a non-success response and missing identity', async () => {
  const identity = { sub: 'guest:opaque', ownerEpoch: 0, accessMode: 'use' as const };
  for (const response of [
    () => {
      throw new Error('offline');
    },
    () => new Response('not JSON'),
    () => new Response(JSON.stringify({ authorized: true }), { status: 403 }),
  ]) {
    vi.stubGlobal('fetch', response);
    expect(await authorizeHosted(config(), identity)).toBe(false);
  }
  expect(await authorizeHosted(config(), null)).toBe(false);
});
