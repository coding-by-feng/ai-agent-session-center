// useSettingsInit — the terminal replay-buffer push (e2e run 5, F4).
//
// The size is the Mac's setting (POST /api/config/terminal-buffer answers this machine only). The paired
// phone app, whose every request is checked against an allow-list, was refused on each launch and logged
// a WARN; it no longer sends it. Every other client still does, and the server decides.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ db: { settings: { toArray: vi.fn(async () => []) } } }));
vi.mock('@/lib/soundEngine', () => ({ soundEngine: { setVolume: vi.fn(), isUnlocked: vi.fn(() => true), unlock: vi.fn() } }));

import { useSettingsInit } from './useSettingsInit';

const APP_UA = 'Mozilla/5.0 (Linux; Android 15; moto g06) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/155.0.8059.43 Mobile Safari/537.36 AASC-Mobile/1';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function bufferPushes(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/config/terminal-buffer'));
}

describe('useSettingsInit — terminal buffer push', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the phone app does not send it (the Mac refuses it from a phone)', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(APP_UA);
    renderHook(() => useSettingsInit());
    expect(bufferPushes(fetchMock)).toHaveLength(0);
  });

  it('a browser or the desktop app still sends it; the server decides who may', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(BROWSER_UA);
    renderHook(() => useSettingsInit());
    expect(bufferPushes(fetchMock)).toHaveLength(1);
  });
});
