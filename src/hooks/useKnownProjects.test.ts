// useKnownProjects.test.ts — desktop dropdowns put this browser's picks first; the phone's New
// session sheet keeps the Mac's ranking (most used first), only appends folders the Mac lacks, and
// shows nothing until that ranking arrives, so rows never move under a tap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useKnownProjects, useRankedProjects } from './useKnownProjects';

const SERVER = ['/busy', '/quiet'];

beforeEach(() => {
  localStorage.setItem('workdir-history', JSON.stringify(['/quiet', '/local-only']));
  vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ paths: SERVER }) }) as Response));
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('useKnownProjects', () => {
  it('starts on the local history and puts it first', async () => {
    const { result } = renderHook(() => useKnownProjects());
    expect(result.current).toEqual(['/quiet', '/local-only']);
    await waitFor(() => expect(result.current).toEqual(['/quiet', '/local-only', '/busy']));
  });
});

describe('useRankedProjects', () => {
  it('is null until the Mac answers, then its ranking first and history-only folders after', async () => {
    const { result } = renderHook(() => useRankedProjects());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual(['/busy', '/quiet', '/local-only']));
  });

  it('falls back to the local history when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { result } = renderHook(() => useRankedProjects());
    await waitFor(() => expect(result.current).toEqual(['/quiet', '/local-only']));
  });
});
