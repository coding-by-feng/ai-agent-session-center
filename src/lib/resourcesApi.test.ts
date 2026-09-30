// resourcesApi.test.ts — the fetch layer under the RESOURCES tab.
//
// The one behaviour the view depends on most: a 404 means "this device may not
// see resources" (the router answers every non-loopback request with 404, not
// 403, so it does not reveal the feature exists). That must surface as a
// distinct error type — a generic Error would render as a retryable failure,
// and retrying from a phone can never succeed.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ResourceCatalog, ResourceDetail } from '@/types/resources';
import {
  ResourcesUnavailableError,
  isAbortError,
  errorMessage,
  fetchCatalog,
  startScan,
  fetchResourceDetail,
  fetchResourceFile,
  fetchResourceCompare,
  readExtraRoots,
  writeExtraRoots,
  EXTRA_ROOTS_STORAGE_KEY,
} from './resourcesApi';

const CATALOG: ResourceCatalog = {
  state: 'ready',
  scannedAt: 1,
  roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: null },
  projects: [],
  resources: [],
  findings: [],
  coverage: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('envelope handling', () => {
  it('GETs /api/resources and unwraps { success, data }', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { success: true, data: CATALOG }));
    await expect(fetchCatalog()).resolves.toEqual(CATALOG);
    expect(fetchMock).toHaveBeenCalledWith('/api/resources', expect.objectContaining({ method: 'GET' }));
  });

  it('turns a 404 into ResourcesUnavailableError, JSON body or not', async () => {
    stubFetch(async () => jsonResponse(404, { success: false, error: 'Not found' }));
    const err = await fetchCatalog().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourcesUnavailableError);
    expect((err as Error).name).toBe('ResourcesUnavailableError');

    stubFetch(async () => new Response('<!doctype html>', { status: 404 }));
    await expect(fetchCatalog()).rejects.toBeInstanceOf(ResourcesUnavailableError);
  });

  it('throws the server message for other failures — not the unavailable type', async () => {
    stubFetch(async () => jsonResponse(500, { success: false, error: 'Scan exploded' }));
    const err = await fetchCatalog().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ResourcesUnavailableError);
    expect((err as Error).message).toBe('Scan exploded');
  });

  it('reads a bare { error } body (the auth gate does not use the envelope)', async () => {
    stubFetch(async () => jsonResponse(401, { error: 'Unauthorized' }));
    await expect(fetchCatalog()).rejects.toThrow('Unauthorized');
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    stubFetch(async () => new Response('Bad gateway', { status: 502 }));
    await expect(fetchCatalog()).rejects.toThrow(/HTTP 502/);
  });

  it('rejects a 200 that is not the envelope (e.g. the SPA fallback page)', async () => {
    stubFetch(async () => new Response('<!doctype html><html></html>', { status: 200 }));
    await expect(fetchCatalog()).rejects.toThrow(/unexpected response/i);
  });

  it('rejects { success: false } even on a 200', async () => {
    stubFetch(async () => jsonResponse(200, { success: false, error: 'Nope' }));
    await expect(fetchCatalog()).rejects.toThrow('Nope');
  });

  it('reports a network failure in words, not as a TypeError', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    await expect(fetchCatalog()).rejects.toThrow(/could not reach/i);
  });

  it('lets an abort pass through untouched so callers can ignore it', async () => {
    stubFetch(async () => { throw new DOMException('The operation was aborted.', 'AbortError'); });
    const err = await fetchCatalog(new AbortController().signal).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
  });

  it('errorMessage turns anything thrown into display text', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(undefined)).toBe('Something went wrong.');
  });

  it('forwards the abort signal to fetch', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { success: true, data: CATALOG }));
    const controller = new AbortController();
    await fetchCatalog(controller.signal);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

describe('routes', () => {
  it('POSTs /scan with the extra roots as JSON', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {
      success: true,
      data: { state: 'scanning', progress: { phase: 'roots', done: 0, total: 0 } },
    }));
    await expect(startScan(['/Users/me/code/app'])).resolves.toEqual({
      state: 'scanning',
      progress: { phase: 'roots', done: 0, total: 0 },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/resources/scan');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ extraRoots: ['/Users/me/code/app'] });
  });

  it('encodes the resource id into the item path', async () => {
    const detail = { summary: { id: 'a/b c' }, findings: [] } as unknown as ResourceDetail;
    const fetchMock = stubFetch(async () => jsonResponse(200, { success: true, data: detail }));
    await fetchResourceDetail('a/b c');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/resources/item/a%2Fb%20c');
  });

  it('passes the file path as a query parameter', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {
      success: true,
      data: { path: 'refs/a b.md', bytes: 3, content: 'abc' },
    }));
    await expect(fetchResourceFile('id1', 'refs/a b.md')).resolves.toMatchObject({ content: 'abc' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/resources/item/id1/file?path=refs%2Fa+b.md');
  });

  it('passes the compare target as a query parameter', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {
      success: true,
      data: { left: { label: 'live', path: '~/x' }, right: { label: 'repo', path: '~/y' }, files: [] },
    }));
    await fetchResourceCompare('id1', 'repo');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/resources/item/id1/compare?against=repo');
  });

  it('only ever talks to /api/resources — never the editable /api/files routes', async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { success: true, data: {} }));
    await fetchCatalog();
    await startScan([]);
    await fetchResourceDetail('x');
    await fetchResourceFile('x', 'y');
    await fetchResourceCompare('x', 'repo');
    for (const [url] of fetchMock.mock.calls) expect(String(url)).toMatch(/^\/api\/resources(\/|$)/);
  });
});

describe('extra roots storage', () => {
  it('round-trips through localStorage under the documented key', () => {
    expect(readExtraRoots()).toEqual([]);
    expect(writeExtraRoots(['/Users/me/code/app', '/Users/me/other'])).toBe(true);
    expect(localStorage.getItem(EXTRA_ROOTS_STORAGE_KEY)).toBe('["/Users/me/code/app","/Users/me/other"]');
    expect(EXTRA_ROOTS_STORAGE_KEY).toBe('aasc.resources.extraRoots');
    expect(readExtraRoots()).toEqual(['/Users/me/code/app', '/Users/me/other']);
  });

  it('ignores a malformed stored value', () => {
    localStorage.setItem(EXTRA_ROOTS_STORAGE_KEY, '{oops');
    expect(readExtraRoots()).toEqual([]);
  });

  it('survives a storage that throws on every access', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
    });
    expect(readExtraRoots()).toEqual([]);
    expect(writeExtraRoots(['/a/b'])).toBe(false);
  });
});
