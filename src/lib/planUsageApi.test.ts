import { describe, it, expect, vi, afterEach } from 'vitest';
import { RequestError } from '@/lib/requestJson';
import { syncPlanUsage } from './planUsageApi';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const REPLY = { cli: 'claude', checkedAt: 1_000, asOf: 900, changed: true };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('syncPlanUsage', () => {
  it('posts the CLI and returns what the server says', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true, data: REPLY }));
    await expect(syncPlanUsage('claude')).resolves.toEqual(REPLY);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/plan-usage/sync');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ cli: 'claude' });
  });

  it('passes the abort signal on, so an unmounted chip stops waiting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true, data: REPLY }));
    const controller = new AbortController();
    await syncPlanUsage('claude', controller.signal);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('accepts a CLI that has never reported (no time)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true, data: { ...REPLY, asOf: null, changed: false } }));
    await expect(syncPlanUsage('claude')).resolves.toMatchObject({ asOf: null, changed: false });
  });

  it('fails with the server\'s own reason, and its status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(429, { success: false, error: 'Rate limit exceeded' }));
    const err = await syncPlanUsage('claude').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(429);
    expect((err as RequestError).message).toBe('Rate limit exceeded');
  });

  it('fails on a body that is not the reply it expects', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: true, data: { cli: 'claude' } }));
    await expect(syncPlanUsage('claude')).rejects.toThrow('Could not sync plan usage');
  });

  it('fails when the server says it did not work', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { success: false, error: 'nope' }));
    await expect(syncPlanUsage('claude')).rejects.toThrow('nope');
  });
});
