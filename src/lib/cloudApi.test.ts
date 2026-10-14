import { afterEach, expect, it, vi } from 'vitest';
import { cloudApi } from './cloudApi';
afterEach(() => vi.unstubAllGlobals());
it('keeps browser-observed identity and reports connection_changed without automatic retry', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'connection_changed', message: 'Review again' },
        }),
        { status: 409 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const binding = {
    backendOrigin: 'https://old.example',
    accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
    generation: 1,
  };
  await expect(cloudApi.recheck(binding)).rejects.toMatchObject({
    code: 'connection_changed',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toMatchObject([
    '/api/resources/cloud/recheck',
    {
      headers: {
        'x-aasc-cloud-backend': binding.backendOrigin,
        'x-aasc-cloud-account': binding.accountId,
        'x-aasc-cloud-generation': '1',
      },
    },
  ]);
});
it('disconnect and revoke carry the reviewed connection instead of selecting credentials', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { connection: null, state: 'disconnected', lastError: null },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const binding = {
    backendOrigin: 'https://reviewed.invalid',
    accountId: '00000000-0000-4000-8000-000000000001',
    generation: 7,
  };
  await cloudApi.disconnect(binding);
  await cloudApi.revoke(binding);
  for (const call of fetcher.mock.calls)
    expect(call).toMatchObject([
      expect.any(String),
      { headers: { 'x-aasc-cloud-account': binding.accountId, 'x-aasc-cloud-generation': '7' } },
    ]);
});
it('connect sends the pairing input and never a token; the result carries no token', async () => {
  const connection = {
    backendOrigin: 'https://reviewed.invalid',
    accountId: '00000000-0000-4000-8000-000000000001',
    deviceId: '00000000-0000-4000-8000-000000000002',
    deviceName: 'Fixture',
    generation: 1,
  };
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ success: true, data: connection })),
  );
  vi.stubGlobal('fetch', fetcher);
  const input = {
    backendUrl: connection.backendOrigin,
    pairingCode: 'c'.repeat(22),
    deviceName: 'Fixture',
  };
  await expect(cloudApi.connect(input)).resolves.toEqual(connection);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/resources/cloud/connect');
  expect(JSON.parse(String(init?.body))).toEqual(input);
  expect(init?.headers).not.toHaveProperty('authorization');
});
it('a token-bearing status is rejected by the strict schema', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: { connection: null, state: 'disconnected', lastError: null, token: 'x' },
          }),
        ),
    ),
  );
  await expect(cloudApi.status()).rejects.toThrow();
});
it('a remote device gets the RESOURCES 404 as a clear unavailable error', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Not found', { status: 404 })));
  await expect(cloudApi.status()).rejects.toMatchObject({ code: 'unavailable' });
});
