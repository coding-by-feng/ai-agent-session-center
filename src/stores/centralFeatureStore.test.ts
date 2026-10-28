import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  useCentralFeatureStore,
  useCentralSessionsShown,
  __resetCentralFeatureForTest,
} from './centralFeatureStore';

const answer = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body });

describe('centralFeatureStore', () => {
  beforeEach(() => __resetCentralFeatureForTest());
  afterEach(() => vi.unstubAllGlobals());

  it('reads centralSessions from GET /api/config', async () => {
    const fetchMock = answer({ port: 3333, centralSessions: false });
    vi.stubGlobal('fetch', fetchMock);
    await useCentralFeatureStore.getState().load();
    expect(fetchMock).toHaveBeenCalledWith('/api/config');
    expect(useCentralFeatureStore.getState().on).toBe(false);
  });

  it('reads the config once per page', async () => {
    const fetchMock = answer({ centralSessions: true });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([useCentralFeatureStore.getState().load(), useCentralFeatureStore.getState().load()]);
    await useCentralFeatureStore.getState().load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useCentralFeatureStore.getState().on).toBe(true);
  });

  it.each([
    ['a server without the field', answer({ port: 3333 })],
    ['a refusal', answer({}, false)],
    ['an unreachable server', vi.fn().mockRejectedValue(new Error('offline'))],
  ])('knows nothing after %s, and may ask again', async (_name, fetchMock) => {
    vi.stubGlobal('fetch', fetchMock);
    await useCentralFeatureStore.getState().load();
    expect(useCentralFeatureStore.getState().on).toBeNull();
    await useCentralFeatureStore.getState().load();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('useCentralSessionsShown', () => {
    it('hides central things only once the server says the feature is off', async () => {
      vi.stubGlobal('fetch', answer({ centralSessions: false }));
      const { result } = renderHook(() => useCentralSessionsShown());
      expect(result.current).toBe(true);
      await waitFor(() => expect(result.current).toBe(false));
    });

    it('keeps them while the answer is unknown or on', async () => {
      vi.stubGlobal('fetch', answer({ centralSessions: true }));
      const { result } = renderHook(() => useCentralSessionsShown());
      await waitFor(() => expect(useCentralFeatureStore.getState().on).toBe(true));
      expect(result.current).toBe(true);
    });
  });
});
