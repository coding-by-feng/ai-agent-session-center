// usePhoneReroute.test.tsx — the phone app's page hands the WebView back to the shell when its socket
// stays down and its own address no longer answers (network switch), and only then.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWsStore } from '@/stores/wsStore';
import {
  LAST_REROUTE_KEY,
  REROUTE_AFTER_DOWN_MS,
  REROUTE_CHECK_EVERY_MS,
  REROUTE_COOLDOWN_MS,
  REROUTE_PROBE_MS,
} from '@/lib/phoneReroute';
import { usePhoneReroute, type RerouteDeps } from './usePhoneReroute';

const IOS_APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 AASC-Mobile/1.0.1+3';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

let store: Map<string, string>;
let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchFn: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let online: boolean;
let visible: boolean;

function deps(over: Partial<RerouteDeps> = {}): RerouteDeps {
  return {
    userAgent: IOS_APP_UA,
    fetch: fetchFn,
    navigate,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    online: () => online,
    visible: () => visible,
    currentPath: () => '/?m=%2Fsessions',
    ...over,
  };
}

const dead = () => Promise.reject(new TypeError('Load failed'));
const alive = () => Promise.resolve(new Response('{}', { status: 200 }));

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

/** Past the grace plus one tick: the first probe has been sent. */
const PAST_GRACE = REROUTE_AFTER_DOWN_MS + REROUTE_CHECK_EVERY_MS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000_000);
  store = new Map();
  navigate = vi.fn();
  fetchFn = vi.fn(dead);
  online = true;
  visible = true;
  useWsStore.getState().setConnected(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePhoneReroute', () => {
  it('sends the WebView to the shell, back to the same screen, when the address no longer answers', async () => {
    const start = Date.now();
    renderHook(() => usePhoneReroute(deps()));
    await advance(REROUTE_AFTER_DOWN_MS - 1);
    expect(fetchFn).not.toHaveBeenCalled();
    await advance(PAST_GRACE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`capacitor://localhost/?reauth=1&back=${encodeURIComponent('/?m=%2Fsessions')}`);
    // The first tick at or past the grace (ticks every REROUTE_CHECK_EVERY_MS from mount).
    expect(store.get(LAST_REROUTE_KEY)).toBe(String(start + REROUTE_AFTER_DOWN_MS));
  });

  it('goes to the Android shell origin inside the Android app', async () => {
    renderHook(() => usePhoneReroute(deps({ userAgent: 'Mozilla/5.0 (Linux; Android 15) AASC-Mobile/1.0.1+3' })));
    await advance(PAST_GRACE);
    expect(navigate.mock.calls[0][0]).toMatch(/^https:\/\/localhost\/\?reauth=1&back=/);
  });

  it('stays when the address still answers (the Mac restarting): the socket keeps retrying', async () => {
    fetchFn.mockImplementation(alive);
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE);
    expect(fetchFn).toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing outside the phone app', async () => {
    renderHook(() => usePhoneReroute(deps({ userAgent: BROWSER_UA })));
    await advance(PAST_GRACE * 2);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing while the socket is up, or when it comes back within the grace', async () => {
    useWsStore.getState().setConnected(true);
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE);
    act(() => useWsStore.getState().setConnected(false));
    await advance(REROUTE_AFTER_DOWN_MS - REROUTE_CHECK_EVERY_MS);
    act(() => useWsStore.getState().setConnected(true));
    await advance(PAST_GRACE);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('waits while offline, then checks once the phone is online again', async () => {
    online = false;
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE * 2);
    expect(fetchFn).not.toHaveBeenCalled();
    online = true;
    await act(async () => { window.dispatchEvent(new Event('online')); });
    await advance(0);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('holds during the cooldown after a reroute from this origin', async () => {
    store.set(LAST_REROUTE_KEY, String(Date.now() - 1_000));
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE);
    expect(fetchFn).not.toHaveBeenCalled();
    await advance(REROUTE_COOLDOWN_MS);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('stays when the socket reconnects while the probe is out', async () => {
    let fail: (e: Error) => void = () => {};
    fetchFn.mockImplementation(() => new Promise<Response>((_res, rej) => { fail = rej; }));
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    act(() => useWsStore.getState().setConnected(true));
    await act(async () => { fail(new TypeError('Load failed')); });
    await advance(REROUTE_PROBE_MS);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('restarts the grace when the app comes back into view (a socket that died in the background)', async () => {
    visible = false;
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE * 3);
    visible = true;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await advance(REROUTE_AFTER_DOWN_MS - 1);
    expect(fetchFn).not.toHaveBeenCalled();
    await advance(REROUTE_CHECK_EVERY_MS);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('sends one probe at a time and reroutes once', async () => {
    renderHook(() => usePhoneReroute(deps()));
    await advance(PAST_GRACE * 4);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
