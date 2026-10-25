// test/mcp/client.test.ts — the loopback client MCP tools use to call AASC's own /api routes
// (server/mcp/client.ts) and the /api token it carries when a dashboard password is set
// (server/mcp/internalAuth.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInternalClient, type InternalClient } from '../../server/mcp/client.js';

// Only `isPasswordEnabled` is faked (it reads the on-disk config). The token store, `createToken`
// and `getTokenTTL` stay real, so the token tests run against the real unit of `getTokenTTL`
// (milliseconds) and the real device binding of `createToken`.
const password = vi.hoisted(() => ({ enabled: false }));

vi.mock('../../server/authManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/authManager.js')>();
  return {
    ...actual,
    isPasswordEnabled: () => password.enabled,
    createToken: vi.fn(actual.createToken),
  };
});

type FetchSpy = ReturnType<typeof stubFetch>;
type ClientOptions = Parameters<typeof createInternalClient>[0];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that answers every call with a fresh `respond()` and remembers the calls. */
function stubFetch(respond: () => Response = () => jsonResponse({ success: true })) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
}

function clientWith(fetchImpl: FetchSpy, overrides: Partial<ClientOptions> = {}): InternalClient {
  return createInternalClient({
    port: () => 4321,
    clientId: 'mcp:c1',
    authToken: () => null,
    fetchImpl,
    ...overrides,
  });
}

/** What the nth fetch call received, with the headers as the plain object the client sent. */
function callOf(fetchImpl: FetchSpy, index = 0) {
  const [url, init] = fetchImpl.mock.calls[index];
  return {
    url: String(url),
    init: init ?? {},
    headers: (init?.headers ?? {}) as Record<string, string>,
  };
}

describe('createInternalClient', () => {
  it('the client passes signal to fetch', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);
    const stop = new AbortController();

    await client.post('/sessions/s1/summarize', { prompt: 'x' }, { signal: stop.signal });
    await client.get('/presence', undefined, { signal: stop.signal });
    await client.get('/presence');

    expect(callOf(fetchImpl, 0).init.signal).toBe(stop.signal);
    expect(callOf(fetchImpl, 1).init.signal).toBe(stop.signal);
    expect('signal' in callOf(fetchImpl, 2).init).toBe(false);

    // An aborted call is a failed call, like any other: the client never throws.
    const aborting = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      return jsonResponse({ ok: true });
    });
    stop.abort();
    const res = await clientWith(aborting).get('/presence', undefined, { signal: stop.signal });
    expect(res).toMatchObject({ ok: false, status: 0 });
  });

  it('get builds the loopback URL with query and client id', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    await client.get('/sessions/abc/chat', { before: 5, after: undefined });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, headers } = callOf(fetchImpl);
    expect(url).toBe('http://127.0.0.1:4321/api/sessions/abc/chat?before=5');
    expect(init.method).toBe('GET');
    expect(headers['x-aasc-client-id']).toBe('mcp:c1');
  });

  it('leaves the query string off when no parameter has a value', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    await client.get('/sessions');
    await client.get('/sessions', {});
    await client.get('/sessions', { after: undefined });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:4321/api/sessions',
      'http://127.0.0.1:4321/api/sessions',
      'http://127.0.0.1:4321/api/sessions',
    ]);
  });

  it('escapes query values so one value can never add another parameter', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    await client.get('/db/prompts', { q: 'a b&c=d', limit: 20, fresh: false });

    const params = new URL(callOf(fetchImpl).url).searchParams;
    expect([...params.keys()]).toEqual(['q', 'limit', 'fresh']);
    expect(params.get('q')).toBe('a b&c=d');
    expect(params.get('limit')).toBe('20');
    expect(params.get('fresh')).toBe('false');
  });

  it('adds Authorization when a token is available', async () => {
    const withToken = stubFetch();
    await clientWith(withToken, { authToken: () => 'tok' }).get('/config');
    expect(callOf(withToken).headers.authorization).toBe('Bearer tok');

    const withoutToken = stubFetch();
    await clientWith(withoutToken, { authToken: () => null }).get('/config');
    expect(callOf(withoutToken).headers).not.toHaveProperty('authorization');
  });

  it('reads the port and the token again on every call', async () => {
    let port = 4321;
    let token: string | null = 'first';
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl, { port: () => port, authToken: () => token });

    await client.get('/config');
    port = 4400;
    token = 'second';
    await client.get('/config');
    token = null;
    await client.get('/config');

    expect(callOf(fetchImpl, 0).url).toBe('http://127.0.0.1:4321/api/config');
    expect(callOf(fetchImpl, 0).headers.authorization).toBe('Bearer first');
    expect(callOf(fetchImpl, 1).url).toBe('http://127.0.0.1:4400/api/config');
    expect(callOf(fetchImpl, 1).headers.authorization).toBe('Bearer second');
    expect(callOf(fetchImpl, 2).headers).not.toHaveProperty('authorization');
  });

  it('returns the route error on 4xx', async () => {
    const fetchImpl = stubFetch(() => jsonResponse({ error: 'Session not found' }, 404));

    const res = await clientWith(fetchImpl).get('/sessions/nope');

    expect(res).toMatchObject({ ok: false, status: 404, error: 'Session not found' });
  });

  it('takes the error text from error, then message, then the HTTP status', async () => {
    const answer = async (response: Response) => clientWith(stubFetch(() => response)).get('/x');

    expect((await answer(jsonResponse({ error: 'e', message: 'm' }, 400))).error).toBe('e');
    expect((await answer(jsonResponse({ message: 'm' }, 400))).error).toBe('m');
    expect((await answer(jsonResponse({ success: false }, 409))).error).toBe('HTTP 409');
    expect((await answer(jsonResponse({ error: '' }, 422))).error).toBe('HTTP 422');
    expect((await answer(jsonResponse({ error: { nested: true } }, 400))).error).toBe('HTTP 400');
    expect((await answer(jsonResponse(['not', 'an', 'object'], 400))).error).toBe('HTTP 400');
    const html = new Response('<pre>Cannot GET /api/x</pre>', { status: 404 });
    expect(await answer(html)).toMatchObject({
      ok: false,
      status: 404,
      data: null,
      error: 'HTTP 404',
    });
  });

  it('keeps the parsed JSON body as data and does not unwrap envelopes', async () => {
    const envelope = { success: true, data: { sessions: [{ sessionId: 's1' }] } };
    const ok = await clientWith(stubFetch(() => jsonResponse(envelope))).get('/sessions');
    expect(ok).toEqual({ ok: true, status: 200, data: envelope, error: null });

    const bare = await clientWith(stubFetch(() => jsonResponse([1, 2, 3]))).get('/queues');
    expect(bare.data).toEqual([1, 2, 3]);

    // An error body stays readable too (codes, retry hints), next to the extracted text.
    const body = { error: 'Too many prompts', code: 'PHONE_TERMINAL_LIMIT', retryAfter: 7 };
    const refused = await clientWith(stubFetch(() => jsonResponse(body, 429))).post('/x');
    expect(refused).toEqual({ ok: false, status: 429, data: body, error: 'Too many prompts' });
  });

  it('answers an empty body with null data', async () => {
    const res = await clientWith(stubFetch(() => new Response(null, { status: 204 }))).del('/x');
    expect(res).toEqual({ ok: true, status: 204, data: null, error: null });
  });

  it('returns status 0 on a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4321'));

    const res = await clientWith(fetchImpl).get('/health-check');

    expect(res).toEqual({
      ok: false,
      status: 0,
      data: null,
      error: 'connect ECONNREFUSED 127.0.0.1:4321',
    });
  });

  it('names the cause of a failed fetch, which Node reports as a bare "fetch failed"', async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:4321');
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause }));
    expect((await clientWith(fetchImpl).get('/x')).error).toBe(
      'fetch failed: connect ECONNREFUSED 127.0.0.1:4321',
    );

    const causeless = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    expect((await clientWith(causeless).get('/x')).error).toBe('fetch failed');

    const notAnError = vi.fn().mockRejectedValue('boom');
    expect(await clientWith(notAnError).get('/x')).toMatchObject({ status: 0, error: 'boom' });
  });

  it('post/put/patch/del send JSON', async () => {
    const body = { text: 'hello', nested: { list: [1, 2] } };
    const verbs = [
      ['post', 'POST'],
      ['put', 'PUT'],
      ['patch', 'PATCH'],
      ['del', 'DELETE'],
    ] as const;

    for (const [verb, method] of verbs) {
      const fetchImpl = stubFetch();
      await clientWith(fetchImpl)[verb]('/sessions/abc/thing', body);

      const { url, init, headers } = callOf(fetchImpl);
      expect(url).toBe('http://127.0.0.1:4321/api/sessions/abc/thing');
      expect(init.method).toBe(method);
      expect(init.body).toBe(JSON.stringify(body));
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-aasc-client-id']).toBe('mcp:c1');
    }
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    await client.get('/sessions');
    await client.post('/sessions/abc/kill');
    await client.del('/sessions/abc', null);

    for (const index of [0, 1, 2]) {
      const { init, headers } = callOf(fetchImpl, index);
      expect(init.body).toBeUndefined();
      expect(headers).not.toHaveProperty('content-type');
    }
  });

  // Some write routes demand a JSON content-type, so `{}` is a body even though null is not.
  it('sends an empty object as JSON, which is not the same as sending nothing', async () => {
    const fetchImpl = stubFetch();

    await clientWith(fetchImpl).post('/resources/abc/restore', {});

    const { init, headers } = callOf(fetchImpl);
    expect(init.body).toBe('{}');
    expect(headers['content-type']).toBe('application/json');
  });

  it('answers a body that cannot be serialised as a failed call, not a throw', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fetchImpl = stubFetch();

    const res = await clientWith(fetchImpl).post('/x', circular);

    expect(res).toMatchObject({ ok: false, status: 0, data: null });
    expect(res.error).toMatch(/circular/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a path that leaves /api and never sends it', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    const escaped = await client.get('/sessions/../../mcp');
    const encodedDots = await client.del('/sessions/%2e%2e/%2E%2e/health');

    expect(escaped).toMatchObject({ ok: false, status: 0 });
    expect(escaped.error).toContain('/api');
    expect(encodedDots).toMatchObject({ ok: false, status: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a path without a leading slash and one that already carries a query', async () => {
    const fetchImpl = stubFetch();
    const client = clientWith(fetchImpl);

    await client.get('sessions');
    await client.get('/sessions?limit=2', { before: 1 });

    expect(callOf(fetchImpl, 0).url).toBe('http://127.0.0.1:4321/api/sessions');
    expect(callOf(fetchImpl, 1).url).toBe('http://127.0.0.1:4321/api/sessions?limit=2&before=1');
  });

  it('does not follow redirects: a route that redirects is a failed call, not a request elsewhere', async () => {
    const redirect = () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    const fetchImpl = stubFetch(redirect);

    const res = await clientWith(fetchImpl).get('/x');

    expect(callOf(fetchImpl).init.redirect).toBe('manual');
    expect(res).toMatchObject({ ok: false, status: 302, error: 'HTTP 302' });
  });
});

// Cloud routes want a binding (the account and connection a caller reviewed) in `x-aasc-cloud-*` headers, so a
// call may carry extra headers. Which ones is limited: a tool must never replace who the caller is.
describe('createInternalClient: extra headers for one call', () => {
  const ACCOUNT_ID = '0b1f6d5e-3c1a-4a52-8c8e-2f6a4f0f9a11';
  const binding = {
    'x-aasc-cloud-backend': 'https://api.example.test',
    'x-aasc-cloud-account': ACCOUNT_ID,
    'x-aasc-cloud-generation': '3',
  };

  it('sends them on a get, after the headers the client always sends', async () => {
    const fetchImpl = stubFetch();

    await clientWith(fetchImpl, { authToken: () => 'tok' }).get('/resources/cloud/projects', { limit: 5 }, { headers: binding });

    const { url, headers } = callOf(fetchImpl);
    expect(url).toBe('http://127.0.0.1:4321/api/resources/cloud/projects?limit=5');
    expect(headers).toMatchObject({ ...binding, 'x-aasc-client-id': 'mcp:c1', authorization: 'Bearer tok', accept: 'application/json' });
  });

  it('sends them on a post with its JSON body, and on put, patch and del', async () => {
    for (const verb of ['post', 'put', 'patch', 'del'] as const) {
      const fetchImpl = stubFetch();

      await clientWith(fetchImpl)[verb]('/resources/cloud/aliases/status', { keys: [] }, { headers: binding });

      const { init, headers } = callOf(fetchImpl);
      expect(init.body, verb).toBe('{"keys":[]}');
      expect(headers, verb).toMatchObject({ ...binding, 'content-type': 'application/json' });
    }
  });

  it('never lets them replace the client id, the token or the content type', async () => {
    const fetchImpl = stubFetch();
    const hostile = {
      'x-aasc-client-id': 'phone:someone-else',
      'X-AASC-Client-Id': 'phone:someone-else',
      Authorization: 'Bearer stolen',
      authorization: 'Bearer stolen',
      'content-type': 'text/plain',
      host: 'evil.example',
    };

    await clientWith(fetchImpl, { authToken: () => 'tok' }).post('/x', { a: 1 }, { headers: hostile });

    const { headers } = callOf(fetchImpl);
    expect(headers['x-aasc-client-id']).toBe('mcp:c1');
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['content-type']).toBe('application/json');
    expect(headers).not.toHaveProperty('host');
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'x-aasc-client-id')).toEqual(['x-aasc-client-id']);
  });

  it('sends the six binding headers with names lower-cased, and drops a value that carries a line break', async () => {
    const fetchImpl = stubFetch();

    await clientWith(fetchImpl).get('/x', undefined, {
      headers: {
        'X-AASC-Notes-Backend': 'https://api.example.test',
        'x-aasc-notes-account': 'line\r\nx-injected: yes',
        'x-aasc-notes-generation': '7',
        'x-aasc-cloud-backend': 'https://api.example.test',
        'X-Aasc-Cloud-Account': ACCOUNT_ID,
        'x-aasc-cloud-generation': '3',
        'x-forwarded-for': '10.0.0.1',
        cookie: 'a=b',
        'x-other': '1',
      },
    });

    const { headers } = callOf(fetchImpl);
    expect(headers['x-aasc-notes-backend']).toBe('https://api.example.test');
    expect(headers['x-aasc-notes-generation']).toBe('7');
    expect(headers['x-aasc-cloud-backend']).toBe('https://api.example.test');
    expect(headers['x-aasc-cloud-account']).toBe(ACCOUNT_ID);
    expect(headers['x-aasc-cloud-generation']).toBe('3');
    for (const dropped of ['x-aasc-notes-account', 'x-forwarded-for', 'cookie', 'x-other']) {
      expect(headers, dropped).not.toHaveProperty(dropped);
    }
  });

  it('refuses every other x-aasc- header: the presence label (which the server reads as a device’s name) and the rest', async () => {
    const fetchImpl = stubFetch();

    await clientWith(fetchImpl).post('/x', { a: 1 }, {
      headers: {
        'x-aasc-client-label': 'Someone else’s phone',
        'x-aasc-client-id': 'phone:someone-else',
        'x-aasc-cloud-token': 'secret',
        'x-aasc-notes-extra': '1',
        'x-aasc-cloud-backend-extra': 'https://elsewhere.example',
        'x-aasc-cloudbackend': 'https://elsewhere.example',
        'x-aasc-': 'empty',
        ...binding,
      },
    });

    const { headers } = callOf(fetchImpl);
    const aasc = Object.keys(headers).filter((name) => name.startsWith('x-aasc-')).sort();
    expect(aasc).toEqual(['x-aasc-client-id', 'x-aasc-cloud-account', 'x-aasc-cloud-backend', 'x-aasc-cloud-generation']);
    expect(headers['x-aasc-client-id']).toBe('mcp:c1');
  });

  it('sends nothing extra when none are given, as before', async () => {
    const fetchImpl = stubFetch();

    await clientWith(fetchImpl).get('/x', { a: 1 });
    await clientWith(fetchImpl).get('/x', undefined, {});

    expect(Object.keys(callOf(fetchImpl, 0).headers).sort()).toEqual(['accept', 'x-aasc-client-id']);
    expect(Object.keys(callOf(fetchImpl, 1).headers).sort()).toEqual(['accept', 'x-aasc-client-id']);
  });
});

describe('internalAuthToken', () => {
  // The faked authManager is one module for the whole file (vi.resetModules only re-evaluates
  // internalAuth), so its createToken spy keeps counting across tests unless it is cleared.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    password.enabled = false;
  });

  /** A fresh internalAuth and the authManager it talks to (one module graph, one token store). */
  async function load() {
    vi.resetModules();
    const authManager = await import('../../server/authManager.js');
    const { internalAuthToken } = await import('../../server/mcp/internalAuth.js');
    return { internalAuthToken, authManager };
  }

  it('internalAuthToken is null without a password', async () => {
    password.enabled = false;
    const { internalAuthToken, authManager } = await load();

    expect(internalAuthToken()).toBeNull();
    expect(authManager.createToken).not.toHaveBeenCalled();
  });

  it('mints a token once a password is set and reuses it while it has time left', async () => {
    password.enabled = true;
    const { internalAuthToken, authManager } = await load();

    const first = internalAuthToken();

    expect(first).toEqual(expect.any(String));
    expect(authManager.validateToken(first)).toBe(true);
    expect(internalAuthToken()).toBe(first);
    expect(authManager.createToken).toHaveBeenCalledTimes(1);
  });

  // getTokenTTL counts milliseconds. A `< 60` check would keep a token until 60 ms before it dies.
  it('replaces the token once it has under a minute left', async () => {
    password.enabled = true;
    const { internalAuthToken, authManager } = await load();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
    const first = internalAuthToken();

    vi.advanceTimersByTime(58 * 60_000 + 30_000); // 90 s of the hour left
    expect(internalAuthToken()).toBe(first);

    vi.advanceTimersByTime(60_000); // 30 s left
    const second = internalAuthToken();
    expect(second).not.toBe(first);
    expect(authManager.validateToken(second)).toBe(true);
    expect(authManager.createToken).toHaveBeenCalledTimes(2);
  });

  it('mints a new token when the cached one has expired or been removed', async () => {
    password.enabled = true;
    const { internalAuthToken, authManager } = await load();
    const first = internalAuthToken() as string;

    authManager.removeToken(first);
    const second = internalAuthToken();

    expect(second).not.toBe(first);
    expect(authManager.validateToken(second)).toBe(true);
  });

  // A token created with a device id is a paired phone to the phone profile (`phoneOf` in
  // server/index.ts), which then refuses every /api route outside PHONE_ROUTES.
  it('is a plain sign-in, never a paired-phone token', async () => {
    password.enabled = true;
    const { internalAuthToken, authManager } = await load();

    const token = internalAuthToken();

    expect(authManager.getTokenDeviceId(token)).toBeNull();
  });
});
