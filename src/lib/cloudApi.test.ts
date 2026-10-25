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
  await cloudApi.syncStatus(binding).catch(() => {});
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
// ---- Remote access (AASC-60): GET/POST /api/resources/cloud/remote-access ----
const remoteView = () => ({
  tailscale: {
    state: 'connected',
    address: '100.101.102.103',
    account: 'kason@example.com',
    tailnet: 'example.com',
    dnsName: 'kason-mbp.tail1234.ts.net',
    canOpenApp: true,
  },
  publish: { state: 'published', tailnet: '100.101.102.103', port: 3334, at: 1_760_000_000_000 },
  phones: [
    {
      id: 'phone-1',
      label: "Kason's iPhone",
      platform: 'ios',
      status: 'active',
      hasTailnet: true,
      tailnetSentAt: 1_760_000_000_000,
      lastPath: 'tailnet',
      lastPathAt: 1_760_000_100_000,
    },
  ],
  port: 3334,
});
const answerWith = (data: unknown, init?: ResponseInit) =>
  vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ success: true, data }), { status: 200, ...init }),
  );

it('remoteAccess reads the view from /api/resources/cloud/remote-access with a GET', async () => {
  const fetcher = answerWith(remoteView());
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  await expect(cloudApi.remoteAccess(signal)).resolves.toEqual(remoteView());
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('/api/resources/cloud/remote-access');
  expect(init).toMatchObject({ method: 'GET' });
  // toMatchObject cannot tell an AbortSignal from undefined, so compare it directly.
  expect(init?.signal).toBe(signal);
  // It is this Mac's own state, not an account's: no cloud identity travels with it.
  expect(init?.headers).not.toHaveProperty('x-aasc-cloud-account');
});
it('remoteAccess accepts a Mac with no Tailscale facts at all (every nullable field null)', async () => {
  const bare = remoteView();
  vi.stubGlobal(
    'fetch',
    answerWith({
      ...bare,
      tailscale: {
        state: 'not-installed',
        address: null,
        account: null,
        tailnet: null,
        dnsName: null,
        canOpenApp: false,
      },
      publish: { state: 'unavailable', tailnet: null, port: 3334, at: null },
      phones: [],
    }),
  );
  await expect(cloudApi.remoteAccess()).resolves.toMatchObject({
    tailscale: { state: 'not-installed', address: null },
    phones: [],
  });
});
it('remoteAccess accepts every state the server can send', async () => {
  const view = remoteView();
  const states = {
    tailscale: ['not-installed', 'not-running', 'signed-out', 'stopped', 'connected'],
    publish: [
      'unavailable',
      'no-cloud',
      'not-needed',
      'no-tailscale',
      'pending',
      'published',
      'forbidden',
      'unsupported',
      'failed',
    ],
  };
  for (const state of states.tailscale) {
    vi.stubGlobal('fetch', answerWith({ ...view, tailscale: { ...view.tailscale, state } }));
    await expect(cloudApi.remoteAccess()).resolves.toMatchObject({ tailscale: { state } });
  }
  for (const state of states.publish) {
    vi.stubGlobal('fetch', answerWith({ ...view, publish: { ...view.publish, state } }));
    await expect(cloudApi.remoteAccess()).resolves.toMatchObject({ publish: { state } });
  }
  const phone = view.phones[0]!;
  for (const patch of [
    { platform: 'android', status: 'pending', lastPath: 'lan' },
    { platform: 'ios', status: 'active', lastPath: null, lastPathAt: null, tailnetSentAt: null },
  ]) {
    vi.stubGlobal('fetch', answerWith({ ...view, phones: [{ ...phone, ...patch }] }));
    await expect(cloudApi.remoteAccess()).resolves.toMatchObject({ phones: [patch] });
  }
});
it.each([
  ['the view', (v: ReturnType<typeof remoteView>) => ({ ...v, token: 'x' })],
  [
    'tailscale',
    (v: ReturnType<typeof remoteView>) => ({
      ...v,
      tailscale: { ...v.tailscale, authUrl: 'https://x' },
    }),
  ],
  [
    'publish',
    (v: ReturnType<typeof remoteView>) => ({ ...v, publish: { ...v.publish, secret: 'x' } }),
  ],
  [
    'a phone',
    (v: ReturnType<typeof remoteView>) => ({
      ...v,
      phones: [{ ...v.phones[0]!, confirmCode: '123456' }],
    }),
  ],
])('remoteAccess rejects a view with extra fields (in %s)', async (_where, widen) => {
  vi.stubGlobal('fetch', answerWith(widen(remoteView())));
  await expect(cloudApi.remoteAccess()).rejects.toThrow();
});
it('remoteAccess rejects a state the page has no words for', async () => {
  const view = remoteView();
  vi.stubGlobal(
    'fetch',
    answerWith({ ...view, tailscale: { ...view.tailscale, state: 'starting' } }),
  );
  await expect(cloudApi.remoteAccess()).rejects.toThrow();
  vi.stubGlobal('fetch', answerWith({ ...view, publish: { ...view.publish, state: 'paused' } }));
  await expect(cloudApi.remoteAccess()).rejects.toThrow();
});
it('refreshRemoteAccess and openTailscale POST a JSON {} body, or the server answers 415', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/open-tailscale')
      ? new Response(JSON.stringify({ success: true }), { status: 200 })
      : new Response(JSON.stringify({ success: true, data: remoteView() }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const signal = new AbortController().signal;
  await expect(cloudApi.refreshRemoteAccess(signal)).resolves.toEqual(remoteView());
  await expect(cloudApi.openTailscale(signal)).resolves.toBeUndefined();
  const [refresh, open] = fetcher.mock.calls;
  // Both can be aborted, so the page can drop them when it goes away.
  expect(refresh![1]?.signal).toBe(signal);
  expect(open![1]?.signal).toBe(signal);
  expect(refresh![0]).toBe('/api/resources/cloud/remote-access/refresh');
  expect(open![0]).toBe('/api/resources/cloud/remote-access/open-tailscale');
  for (const [, init] of [refresh!, open!]) {
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  }
});
it('openTailscale succeeds on any success answer, and reads nothing from it', async () => {
  vi.stubGlobal('fetch', answerWith({ opened: true, pid: 1234 }));
  await expect(cloudApi.openTailscale()).resolves.toBeUndefined();
});
it('openTailscale reports the server refusal with its code and its own words', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'unsupported', message: 'Open Tailscale from your menu bar.' },
          }),
          { status: 409 },
        ),
    ),
  );
  await expect(cloudApi.openTailscale()).rejects.toMatchObject({
    code: 'unsupported',
    message: 'Open Tailscale from your menu bar.',
  });
});
it('a remote device gets the RESOURCES 404 on Remote access as the unavailable error', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('Not found', { status: 404 })),
  );
  await expect(cloudApi.remoteAccess()).rejects.toMatchObject({ code: 'unavailable' });
});
