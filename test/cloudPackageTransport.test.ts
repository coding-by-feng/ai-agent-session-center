import { expect, it } from 'vitest';
import { createCloudTransport } from '../server/cloud/client.js';
// The bearer allow-list takes only canonical upload ids and sha256 file names.
const filePath = `/v1/resources/uploads/0b6e7a3c-1f2d-4e5a-9b8c-7d6e5f4a3b2c/files/${'a'.repeat(64)}`;
it('preserves only validated resource conflict details and bounded numeric Retry-After', async () => {
  const t = createCloudTransport({
    fetch: async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'version_conflict', message: 'secret', details: { headVersion: 8 } },
        }),
        { status: 409 },
      ),
  });
  await expect(
    t.send('https://cloud.example', 'POST', '/v1/resources/uploads', {}),
  ).rejects.toMatchObject({ code: 'version_conflict', details: { headVersion: 8 } });
  const rate = createCloudTransport({
    fetch: async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: 'rate_limited', message: 'private' } }),
        { status: 429, headers: { 'Retry-After': '3' } },
      ),
  });
  await expect(
    rate.send(
      'https://cloud.example',
      'PUT',
      filePath,
      Buffer.from('hi'),
    ),
  ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 3000 });
});
it('streams binary responses and uploads unencoded binary', async () => {
  let raw: unknown;
  let content: unknown;
  const t = createCloudTransport({
    fetch: async (_url, opts) => {
      raw = opts?.body;
      content = (opts?.headers as Record<string, string>)['Content-Type'];
      return new Response(JSON.stringify({ success: true, data: { ok: true } }));
    },
  });
  await t.send(
    'https://cloud.example',
    'PUT',
    filePath,
    Buffer.from('hi'),
  );
  expect(raw).toEqual(Buffer.from('hi'));
  expect(content).toBe('application/octet-stream');
});
