import { afterEach, expect, it, vi } from 'vitest';
import { cloudApi } from './cloudApi';
afterEach(() => vi.unstubAllGlobals());
it('keeps browser-observed identity and reports connection_changed without automatic retry', async () => {
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
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
  const fetcher = vi.fn(
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
