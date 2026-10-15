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
it('a publication plan keeps the reviewed binding and never retries a changed connection', async () => {
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
  await expect(cloudApi.buildPublicationPlan([], binding)).rejects.toMatchObject({
    code: 'connection_changed',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    headers: {
      'x-aasc-cloud-backend': binding.backendOrigin,
      'x-aasc-cloud-account': binding.accountId,
      'x-aasc-cloud-generation': '1',
    },
  });
});
it('project actions keep the reviewed binding and preserve safe revision conflicts', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'version_conflict',
            message: 'Cloud version changed. Review the latest version.',
            details: { headVersion: 7 },
          },
        }),
        { status: 409 },
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const binding = {
    backendOrigin: 'https://reviewed.example',
    accountId: 'd23c54de-1b99-4802-87bf-d84ddba2fdf1',
    generation: 3,
  };
  await expect(cloudApi.pullProject(binding.accountId, binding)).rejects.toMatchObject({
    code: 'version_conflict',
    details: { headVersion: 7 },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toMatchObject([
    `/api/resources/cloud/projects/${binding.accountId}/pull`,
    {
      headers: {
        'x-aasc-cloud-backend': binding.backendOrigin,
        'x-aasc-cloud-account': binding.accountId,
        'x-aasc-cloud-generation': '3',
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not found', { status: 404 })),
  );
  await expect(cloudApi.status()).rejects.toMatchObject({ code: 'unavailable' });
});
it('a download that the RESOURCES gate refuses with a plain 404 is a clear error, not a JSON crash', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not found', { status: 404 })),
  );
  const binding = {
    backendOrigin: 'https://reviewed.invalid',
    accountId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
  };
  await expect(
    cloudApi.downloadFile('00000000-0000-4000-8000-000000000009', binding),
  ).rejects.toMatchObject({ code: 'download_failed' });
});
it('every cloud call stays under /api/resources/cloud, never /api/cloud', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { connection: null, state: 'disconnected', lastError: null },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  await cloudApi.status();
  const binding = {
    backendOrigin: 'https://reviewed.invalid',
    accountId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
  };
  await cloudApi.listResources(binding).catch(() => {});
  await cloudApi.listProjects(binding).catch(() => {});
  for (const [url] of fetcher.mock.calls) expect(String(url)).toMatch(/^\/api\/resources\/cloud\//);
});
it('job status and cancel carry the reviewed binding so the server can refuse another account', async () => {
  const id = '00000000-0000-4000-8000-000000000009';
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { id, kind: 'install', state: 'cancelled', steps: [] },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  const binding = {
    backendOrigin: 'https://reviewed.invalid',
    accountId: '00000000-0000-4000-8000-000000000001',
    generation: 4,
  };
  await cloudApi.job(id, binding);
  await cloudApi.cancel(id, binding);
  const headers = {
    'x-aasc-cloud-backend': binding.backendOrigin,
    'x-aasc-cloud-account': binding.accountId,
    'x-aasc-cloud-generation': '4',
  };
  expect(fetcher.mock.calls[0]).toMatchObject([
    `/api/resources/cloud/jobs/${id}`,
    { method: 'GET', headers },
  ]);
  expect(fetcher.mock.calls[1]).toMatchObject([
    `/api/resources/cloud/jobs/${id}/cancel`,
    { method: 'POST', headers },
  ]);
});
it('a job another account owns surfaces the server 404 as an error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'not_found', message: 'Job not found.' },
          }),
          { status: 404 },
        ),
    ),
  );
  await expect(
    cloudApi.job('00000000-0000-4000-8000-000000000009', {
      backendOrigin: 'https://reviewed.invalid',
      accountId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
});
