import { describe, it, expect } from 'vitest';
import { RequestError, canRetry, readJson, retryOnceUnlessRefused } from './requestJson';

const reply = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('readJson', () => {
  it('returns the body of an OK response', async () => {
    await expect(readJson<{ n: number }>(reply(200, { n: 1 }), 'Failed')).resolves.toEqual({ n: 1 });
  });

  it("throws the server's own reason with the status, else the fallback", async () => {
    await expect(readJson(reply(403, { error: 'host only' }), 'Failed')).rejects.toMatchObject({
      message: 'host only',
      status: 403,
    });
    await expect(readJson(reply(500, null), 'Failed to load')).rejects.toMatchObject({
      message: 'Failed to load (HTTP 500)',
      status: 500,
    });
  });
});

describe('retryOnceUnlessRefused (the app QueryClient retry)', () => {
  it('retries a failure worth repeating once', () => {
    const flaky = new RequestError('busy', 500);
    expect(retryOnceUnlessRefused(0, flaky)).toBe(true);
    expect(retryOnceUnlessRefused(1, flaky)).toBe(false);
    // A plain Error from any other fetcher keeps the old `retry: 1`.
    expect(retryOnceUnlessRefused(0, new Error('offline'))).toBe(true);
  });

  it('never retries a refusal or a missing thing', () => {
    expect(retryOnceUnlessRefused(0, new RequestError('host only', 403))).toBe(false);
    expect(retryOnceUnlessRefused(0, new RequestError('gone', 404))).toBe(false);
    expect(canRetry(new RequestError('gone', 404))).toBe(false);
    expect(canRetry(null)).toBe(true);
  });
});
