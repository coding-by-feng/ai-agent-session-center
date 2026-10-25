import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handsOffFailureText, putHandsOff } from './handsOff';

const reply = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

describe('putHandsOff', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs { on } as JSON to the session’s hands-off route', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: true }));

    await putHandsOff('sess-1', true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/mcp/sessions/sess-1/hands-off');
    expect(init?.method).toBe('PUT');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ on: true });
  });

  it('sends false to switch it off', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: false }));

    await putHandsOff('sess-1', false);

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ on: false });
  });

  it('encodes the session id in the path', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: true }));

    await putHandsOff('a b/c?d', true);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/mcp/sessions/a%20b%2Fc%3Fd/hands-off');
  });

  it('answers the state the server says it set', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: true }));

    expect(await putHandsOff('sess-1', true)).toEqual({ ok: true, handsOff: true });
  });

  it('answers what the server says it set, even when that is not what was asked', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, handsOff: false }));

    expect(await putHandsOff('sess-1', true)).toEqual({ ok: true, handsOff: false });
  });

  it('answers the state asked for when the answer does not say (an older server)', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));

    expect(await putHandsOff('sess-1', false)).toEqual({ ok: true, handsOff: false });
  });

  it('is unavailable for a 404: this is not the Mac, central sessions are off, or the session is gone', async () => {
    fetchMock.mockResolvedValue(reply(404, { ok: false, error: 'Not found' }));

    expect(await putHandsOff('sess-1', true)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is refused for a 401 or 403', async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(reply(status, {}));
      expect(await putHandsOff('sess-1', true)).toEqual({ ok: false, reason: 'refused' });
    }
  });

  it('is failed for any other status, and for a network error, and never throws', async () => {
    for (const status of [400, 500, 503]) {
      fetchMock.mockResolvedValue(reply(status, {}));
      expect(await putHandsOff('sess-1', true)).toEqual({ ok: false, reason: 'failed' });
    }
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await putHandsOff('sess-1', true)).toEqual({ ok: false, reason: 'failed' });
  });

  it('takes a 200 whose body is not JSON for what was asked', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    } as unknown as Response);

    expect(await putHandsOff('sess-1', true)).toEqual({ ok: true, handsOff: true });
  });
});

describe('handsOffFailureText', () => {
  it('says each reason in words that name the next step', () => {
    expect(handsOffFailureText('unavailable')).toMatch(/central sessions|this Mac|session/i);
    expect(handsOffFailureText('refused')).toMatch(/sign in|allowed|refused/i);
    expect(handsOffFailureText('failed')).toMatch(/try again/i);
  });

  it('never repeats anything it was not given', () => {
    for (const reason of ['unavailable', 'refused', 'failed'] as const) {
      expect(handsOffFailureText(reason)).not.toMatch(/undefined|null|\[object/);
    }
  });
});
