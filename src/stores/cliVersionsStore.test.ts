import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CliVersionInfo } from '@/types/cliVersions';
import { useCliVersionsStore, selectBusyCli } from './cliVersionsStore';

const info = (cli: 'claude' | 'codex', over: Partial<CliVersionInfo> = {}): CliVersionInfo => ({
  cli, installed: '1.0.0', latest: '1.0.1', updateAvailable: true, checkedAt: 1, update: { state: 'idle' }, ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('cliVersionsStore', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    useCliVersionsStore.setState({ items: null, loading: false, error: null });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads both CLIs, dropping a malformed one, and asks npm again on refresh', async () => {
    fetchMock.mockResolvedValue(json(200, { success: true, data: [info('claude'), info('codex'), { cli: 'x' }] }));
    await useCliVersionsStore.getState().load();
    expect(useCliVersionsStore.getState().items?.map((i) => i.cli)).toEqual(['claude', 'codex']);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/cli-versions', expect.anything());
    await useCliVersionsStore.getState().load(true);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/cli-versions?refresh=1', expect.anything());
  });

  it('keeps the server’s reason when the read fails', async () => {
    fetchMock.mockResolvedValue(json(500, { success: false, error: 'Could not read the CLI versions' }));
    await useCliVersionsStore.getState().load();
    expect(useCliVersionsStore.getState()).toMatchObject({ loading: false, error: 'Could not read the CLI versions' });
  });

  it('marks a started update as running at once', async () => {
    useCliVersionsStore.setState({ items: [info('claude'), info('codex')] });
    fetchMock.mockResolvedValue(json(202, { success: true, data: { cli: 'codex', state: 'updating' } }));
    expect(await useCliVersionsStore.getState().update('codex')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/cli-versions/codex/update', { method: 'POST' });
    expect(selectBusyCli(useCliVersionsStore.getState())).toBe('codex');
    expect(useCliVersionsStore.getState().items![1].update).toMatchObject({ state: 'updating', from: '1.0.0' });
  });

  it('never paints updating over a result that arrived before the HTTP answer', async () => {
    useCliVersionsStore.setState({ items: [info('claude'), info('codex')] });
    fetchMock.mockImplementation(async () => {
      // The broadcasts land first: the update failed at once.
      useCliVersionsStore.getState().receive(info('codex', { update: { state: 'failed', error: 'spawn ENOENT' } }));
      return json(202, { success: true, data: { cli: 'codex', state: 'updating' } });
    });
    await useCliVersionsStore.getState().update('codex');
    expect(useCliVersionsStore.getState().items![1].update.state).toBe('failed');
    expect(selectBusyCli(useCliVersionsStore.getState())).toBeNull();
  });

  it('answers the refusal reason and changes nothing', async () => {
    const before = [info('claude'), info('codex')];
    useCliVersionsStore.setState({ items: before });
    fetchMock.mockResolvedValue(json(429, { success: false, error: 'This device updated it recently. Try again in 10 minutes.' }));
    expect(await useCliVersionsStore.getState().update('codex')).toMatch(/10 minutes/);
    expect(useCliVersionsStore.getState().items).toBe(before);
  });

  it('replaces one CLI from a broadcast without touching the other', () => {
    const claude = info('claude');
    useCliVersionsStore.setState({ items: [claude, info('codex')] });
    useCliVersionsStore.getState().receive(info('codex', { installed: '1.0.1', updateAvailable: false, update: { state: 'updated', from: '1.0.0', to: '1.0.1' } }));
    const items = useCliVersionsStore.getState().items!;
    expect(items[0]).toBe(claude);
    expect(items[1].update.state).toBe('updated');
  });
});
