// useSettingsInit — the terminal replay-buffer push (e2e run 5, F4).
//
// The size is the Mac's setting (POST /api/config/terminal-buffer answers this machine only). The paired
// phone app, whose every request is checked against an allow-list, was refused on each launch and logged
// a WARN; it no longer sends it. Every other client still does, and the server decides.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/db', () => ({ db: { settings: { toArray: vi.fn(async () => []) } } }));
vi.mock('@/lib/soundEngine', () => ({ soundEngine: { setVolume: vi.fn(), isUnlocked: vi.fn(() => true), unlock: vi.fn() } }));

import { useSettingsInit } from './useSettingsInit';
import { useSettingsStore } from '@/stores/settingsStore';

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

  it('a changed size is sent again, so the next new terminal uses it', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(BROWSER_UA);
    useSettingsStore.setState({ terminalReplayBufferBytes: 1024 * 1024, persistSetting: vi.fn(async () => {}) } as never);
    renderHook(() => useSettingsInit());
    act(() => useSettingsStore.getState().setTerminalReplayBufferBytes(5 * 1024 * 1024));
    const bodies = bufferPushes(fetchMock).map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(bodies).toEqual([{ bytes: 1024 * 1024 }, { bytes: 5 * 1024 * 1024 }]);
  });
});

describe('useSettingsInit — keep-awake push (AASC-16)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const keepAwakePushes = () => fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/config/keep-awake'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    useSettingsStore.setState({ keepAwakeWhileWorking: false, persistSetting: vi.fn(async () => {}) } as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('the desktop app tells its server each time the toggle flips', () => {
    (window as unknown as { electronAPI?: unknown }).electronAPI = {};
    renderHook(() => useSettingsInit());
    act(() => useSettingsStore.getState().setKeepAwakeWhileWorking(true));
    act(() => useSettingsStore.getState().setKeepAwakeWhileWorking(false));
    expect(keepAwakePushes()).toEqual([{ enabled: false }, { enabled: true }, { enabled: false }]);
  });

  it('a browser never sends it', () => {
    renderHook(() => useSettingsInit());
    act(() => useSettingsStore.getState().setKeepAwakeWhileWorking(true));
    expect(keepAwakePushes()).toEqual([]);
  });
});
