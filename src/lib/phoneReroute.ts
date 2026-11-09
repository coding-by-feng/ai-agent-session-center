/**
 * phoneReroute.ts — when the phone app's page stops redialling a dead address and
 * asks the shell to find its Mac again.
 *
 * The phone app opens the Mac at one address (home network, or Tailscale) and the
 * page's socket only ever redials that origin (wsClient.ts). After a network
 * switch (home Wi‑Fi → 5G) the home address is gone, so the page sat on
 * "Reconnecting to your Mac…" forever while a working Tailscale path went unused:
 * the shell's path choice (`reachOrRescan`: home network, Tailscale, rescan,
 * AASC Cloud) only runs when the app opens.
 *
 * Rule: while the socket is down, the phone is online and the page in view, wait
 * REROUTE_AFTER_DOWN_MS, then ask the page's own origin `/api/auth/status`. Any
 * HTTP answer means the address is still there (the Mac restarting, say) and the
 * socket keeps retrying; no answer within REROUTE_PROBE_MS sends the WebView to
 * the shell's reauth route, which reopens the Mac on whichever path answers now.
 * One reroute per REROUTE_COOLDOWN_MS, stamped in localStorage (per origin), so a
 * flaky network can't bounce the page between the shell and the Mac.
 */

/** How long the socket must have been down (in view) before the address is checked. */
export const REROUTE_AFTER_DOWN_MS = 6_000;
/** The probe's budget: a reachable Mac on the same network answers in milliseconds. */
export const REROUTE_PROBE_MS = 2_500;
/** At most one reroute per this window from one origin. */
export const REROUTE_COOLDOWN_MS = 60_000;
/** How often the hook re-evaluates while the socket is down. */
export const REROUTE_CHECK_EVERY_MS = 2_000;
/** localStorage key holding the last reroute's epoch ms. */
export const LAST_REROUTE_KEY = 'aasc.phoneReroute.lastAt';

export interface RerouteCheck {
  online: boolean;
  visible: boolean;
  /** When the socket went down (or the page came back into view while down); null while up. */
  downSince: number | null;
  lastRerouteAt: number | null;
  now: number;
}

/** True when the page should check whether its own address still answers. */
export function shouldProbe(c: RerouteCheck): boolean {
  if (c.downSince === null || !c.online || !c.visible) return false;
  if (c.now - c.downSince < REROUTE_AFTER_DOWN_MS) return false;
  if (c.lastRerouteAt !== null && c.lastRerouteAt <= c.now && c.now - c.lastRerouteAt < REROUTE_COOLDOWN_MS) {
    return false;
  }
  return true;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Does this page's own origin still answer? Any HTTP status counts; a network error or timeout does not. */
export async function originAnswers(fetchFn: FetchLike, ms: number = REROUTE_PROBE_MS): Promise<boolean> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve(false);
    }, ms);
  });
  const request = fetchFn('/api/auth/status', { cache: 'no-store', signal: ctrl.signal }).then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface StampStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readLastReroute(storage: StampStorage): number | null {
  try {
    const n = Number(storage.getItem(LAST_REROUTE_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastReroute(storage: StampStorage, at: number): void {
  try {
    storage.setItem(LAST_REROUTE_KEY, String(at));
  } catch {
    // Storage blocked or full: the reroute still happens; only the cooldown is lost.
  }
}
