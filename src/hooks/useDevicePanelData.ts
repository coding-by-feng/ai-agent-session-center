/**
 * useDevicePanelData — the two things the devices chip reads from this computer's own server. They were inside
 * DevicePresenceChip until the panel learned its keyboard (Nov 20 2026) and behave as they did there.
 */
import { useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { accountPhoneNotice, newAccountPhones } from '@/lib/accountPhoneNotice';
import { listPairedPhones, type PairedPhone } from '@/lib/mobilePairingApi';

/** How often the Mac re-reads its paired phones for the chip's phone and tablet counts. */
const PHONES_POLL_MS = 30_000;

/**
 * The paired phones behind the chip's 📱 count (Oct 22 2026): live sockets alone missed every paired phone with its
 * app closed. Mac only (the list is a local route). Re-read when presence changes, since a phone opening its app is
 * a presence change, and on a slow poll for renames and revokes. Null until read, and while `enabled` is false.
 *
 * It also says when a phone joined through the AASC Cloud account (plan 17): an account phone connects with no
 * Allow click, so the owner is told here.
 */
export function usePairedPhones(enabled: boolean, deviceKey: string): PairedPhone[] | null {
  const [pairedPhones, setPairedPhones] = useState<PairedPhone[] | null>(null);
  // The last list read, for the toast. Kept across the effect's restarts.
  const lastPhonesRef = useRef<PairedPhone[] | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const load = () => {
      listPairedPhones(controller.signal)
        .then((list) => {
          if (controller.signal.aborted) return;
          for (const p of newAccountPhones(lastPhonesRef.current, list)) showToast(accountPhoneNotice(p), 'info', 8000);
          lastPhonesRef.current = list;
          setPairedPhones(list);
        })
        .catch(() => { /* a background count: keep the last one */ });
    };
    load();
    const timer = setInterval(load, PHONES_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled, deviceKey]);
  return pairedPhones;
}

/** Shape actually read from `GET /api/config` — that endpoint returns more
 *  fields (hookDensity, debug, enabledClis) that nothing here needs. */
interface ConfigResponse {
  localIP: string | null;
  /** Whether a password is configured (never the password itself). Remote
   *  devices are refused outright without one, so this decides whether the
   *  panel explains that or stays quiet. */
  passwordEnabled?: boolean;
}

export interface PanelNetwork {
  /**
   * The LAN URL a phone should connect to — undefined until fetched, null once
   * fetched if this machine has no reachable LAN interface (e.g. no Wi-Fi/ethernet).
   */
  networkUrl: string | null | undefined;
  /** Defaults to TRUE so the "other devices are blocked" warning is never shown
   *  on a guess — only once the server has actually said no password is set. */
  passwordEnabled: boolean;
}

/**
 * Fetched lazily on first open, not on mount: the chip is always rendered, and
 * eagerly hitting /api/config on every page load for a value most sessions
 * never look at would undo the "no chrome for the common case" restraint the
 * chip follows. Fetched once and cached — a mid-session LAN change (e.g. Wi-Fi
 * network switch) is rare enough that a page reload covers it, same as any
 * other startup-computed value in this app.
 */
export function usePanelNetwork(open: boolean): PanelNetwork {
  const [networkUrl, setNetworkUrl] = useState<string | null | undefined>(undefined);
  const [passwordEnabled, setPasswordEnabled] = useState(true);
  useEffect(() => {
    if (!open || networkUrl !== undefined) return;
    const controller = new AbortController();
    void fetch('/api/config', { signal: controller.signal })
      .then((r) => r.json() as Promise<ConfigResponse>)
      .then((data) => {
        if (controller.signal.aborted) return;
        // window.location.port (not the config file's nominal `port` field)
        // is what actually loaded THIS page — the two can diverge if the
        // configured port was in use and portManager.ts fell back to
        // another one (see server/index.ts's EADDRINUSE retry).
        setNetworkUrl(data.localIP ? `http://${data.localIP}:${window.location.port}` : null);
        setPasswordEnabled(!!data.passwordEnabled);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNetworkUrl(null);
      });
    return () => controller.abort();
  }, [open, networkUrl]);
  return { networkUrl, passwordEnabled };
}
