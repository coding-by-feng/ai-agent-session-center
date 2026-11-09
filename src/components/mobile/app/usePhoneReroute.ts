/**
 * usePhoneReroute — the phone app's page finds its Mac again after a network switch.
 *
 * While the socket is down, every REROUTE_CHECK_EVERY_MS this asks `shouldProbe`
 * (online, in view, down for the grace, outside the cooldown); when it says yes, it
 * probes the page's own origin once, and a dead address sends the WebView to the
 * shell's reauth route with the current screen as `back`. The shell then reopens
 * the Mac on whichever path answers now (home network, Tailscale, rescan, AASC
 * Cloud) or shows its own "Can't reach" screen with Retry. Rule and constants:
 * `src/lib/phoneReroute.ts`. A no-op outside the phone app (no shell to go to).
 *
 * Coming back into view restarts the grace: the socket usually died in the
 * background and wsClient redials on wake, which needs a moment.
 */
import { useEffect, useState } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { nativeShellReauthUrl } from '@/lib/platform';
import {
  REROUTE_CHECK_EVERY_MS,
  originAnswers,
  readLastReroute,
  shouldProbe,
  writeLastReroute,
} from '@/lib/phoneReroute';

export interface RerouteDeps {
  userAgent: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  navigate: (url: string) => void;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  online: () => boolean;
  visible: () => boolean;
  /** The screen to come back to: path + query (the phone UI keeps its route in `?m=`). */
  currentPath: () => string;
}

function defaultDeps(): RerouteDeps {
  return {
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    fetch: (url, init) => window.fetch(url, init),
    navigate: (url) => window.location.replace(url),
    // window.localStorage itself can throw (blocked storage); phoneReroute.ts catches both calls.
    storage: {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    online: () => navigator.onLine,
    visible: () => document.visibilityState === 'visible',
    currentPath: () => `${window.location.pathname}${window.location.search}`,
  };
}

export function usePhoneReroute(overrides?: Partial<RerouteDeps>): void {
  const connected = useWsStore((s) => s.connected);
  // Fixed for the page's lifetime: the effect below must not restart on every render.
  const [deps] = useState<RerouteDeps>(() => ({ ...defaultDeps(), ...overrides }));

  useEffect(() => {
    if (connected || !nativeShellReauthUrl('/', deps.userAgent)) return;
    let downSince = Date.now();
    let probing = false;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (probing || stopped) return;
      const due = shouldProbe({
        online: deps.online(),
        visible: deps.visible(),
        downSince,
        lastRerouteAt: readLastReroute(deps.storage),
        now: Date.now(),
      });
      if (!due) return;
      probing = true;
      const answers = await originAnswers(deps.fetch);
      probing = false;
      if (stopped || answers || useWsStore.getState().connected) return;
      const url = nativeShellReauthUrl(deps.currentPath(), deps.userAgent);
      if (!url) return;
      stop();
      writeLastReroute(deps.storage, Date.now());
      deps.navigate(url);
    };

    const onTick = (): void => void tick();
    const onVisibility = (): void => {
      if (!deps.visible()) return;
      downSince = Date.now();
      void tick();
    };
    const timer = setInterval(onTick, REROUTE_CHECK_EVERY_MS);
    window.addEventListener('online', onTick);
    document.addEventListener('visibilitychange', onVisibility);

    function stop(): void {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('online', onTick);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    return stop;
  }, [connected, deps]);
}
