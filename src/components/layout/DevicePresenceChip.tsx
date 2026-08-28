/**
 * DevicePresenceChip — Header indicator for connected devices.
 *
 * Always visible (see Aug 2026 change below) — clicking it opens a panel
 * listing who is connected (this Mac plus any remote IP), how many sessions
 * each drives, and a "release all" action.
 *
 * **Always shown, not gated on a second device (changed Aug 2026).** It used
 * to `return null` at `devices.length <= 1`, so in the single-device case —
 * the overwhelmingly common one — there was no way to check what was
 * connected, or learn this device's own address to give to a phone, without
 * shelling out manually. The panel's per-device logic (`myControlled`, the
 * list map, the no-password warning's `.some()`) already worked correctly at
 * length 1 without any changes — it was only ever the render gate hiding it.
 *
 * ## Why this is portaled
 *
 * The panel is `position: fixed`, rendered into `document.body`, and placed
 * from the trigger's viewport rect. The NavBar is inside the app's scrolling
 * layout, so an `absolute`-positioned descendant would be clipped by the first
 * ancestor with `overflow: auto` — and the usual flip/clamp helpers measure
 * `window.innerWidth`, a boundary far outside the real clip edge, so they would
 * silently never fire while looking correct in review.
 *
 * Portaling re-parents the panel into the root stacking context, where its
 * z-index is measured against full-screen siblings rather than its own row —
 * hence the 10000+ band shared with Tooltip (10000) and SelectionPopup (10050),
 * not the small value it would "deserve" as a NavBar child.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresenceStore } from '@/stores/presenceStore';
import type { ControlHolderView } from '@/types';
import { getClientId } from '@/lib/deviceIdentity';
import { releaseAllControls } from '@/lib/presenceClient';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/DevicePresence.module.css';

/** Gap kept between the panel and the viewport edge. */
const VIEWPORT_PAD = 8;
const PANEL_WIDTH = 320;

/** How many sessions a device currently drives. Offline holders drive nothing. */
function drivingCount(controllers: Map<string, ControlHolderView>, clientId: string): number {
  let n = 0;
  for (const holder of controllers.values()) {
    if (holder.clientId === clientId && holder.online) n++;
  }
  return n;
}

function relativeTime(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * `d.address` is a raw `req.socket.remoteAddress` — on a dual-stack machine
 * that's frequently an IPv4-mapped IPv6 form (`::ffff:192.168.6.42`) or bare
 * `::1` for loopback, neither of which reads as an IP a person recognizes.
 * Mirrors the normalization `isLoopbackAddress` already does server-side
 * (`address.replace(/^::ffff:/, '')`), but for DISPLAY only — `d.isLocal`
 * itself is computed server-side and untouched here. An empty address (no
 * socket info available, e.g. behind a proxy) shows as '—' rather than blank.
 */
function formatAddress(address: string): string {
  if (!address) return '—';
  const stripped = address.replace(/^::ffff:/, '');
  return stripped === '::1' ? '127.0.0.1' : stripped;
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

export default function DevicePresenceChip() {
  const devices = usePresenceStore((s) => s.devices);
  // Subscribed so the per-device "driving N sessions" counts re-render when a
  // baton moves, and read directly (rather than via a getState() helper) so the
  // subscription is what actually feeds the render.
  const controllers = usePresenceStore((s) => s.controllers);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const myId = getClientId();

  // The LAN URL a phone should connect to — undefined until fetched, null once
  // fetched if this machine has no reachable LAN interface (e.g. no Wi-Fi/
  // ethernet). Fetched lazily on first open, not on mount: this chip is now
  // always rendered (see the "always shown" note above), and eagerly hitting
  // /api/config on every page load for a value most sessions never look at
  // would undo the "no chrome for the common case" restraint the rest of this
  // component already follows. Fetched once and cached — a mid-session LAN
  // change (e.g. Wi-Fi network switch) is rare enough that a page reload
  // covers it, same as any other startup-computed value in this app.
  const [networkUrl, setNetworkUrl] = useState<string | null | undefined>(undefined);
  // Defaults to TRUE so the "other devices are blocked" warning is never shown
  // on a guess — only once the server has actually said no password is set.
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

  const [copied, setCopied] = useState(false);
  const handleCopyNetworkUrl = useCallback(async () => {
    if (!networkUrl) return;
    try {
      await navigator.clipboard.writeText(networkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — the URL is still
      // selectable text, so this isn't the only way to copy it.
    }
  }, [networkUrl]);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Shrink before placing: on a 320px-wide phone the full-width panel cannot
    // fit alongside both pads, so clamping position alone still overruns the
    // right edge by the difference. Width first, then position.
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_PAD * 2);
    // Right-align to the trigger, then clamp inside the viewport. On a narrow
    // window the chip sits close enough to the edge that an unclamped panel
    // would render partly offscreen.
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rect.right - width),
      window.innerWidth - width - VIEWPORT_PAD,
    );
    setPos({ top: rect.bottom + 6, left: Math.max(VIEWPORT_PAD, left), width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => place();
    // `capture: true` is required: scroll does not bubble, so an inner
    // container's scroll is only observable during the capture phase.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place]);

  const handleReleaseAll = async () => {
    const { released } = await releaseAllControls();
    showToast(
      released.length > 0
        ? `Released ${released.length} session${released.length === 1 ? '' : 's'} — any device can take them now`
        : 'You were not driving any sessions',
      'info',
      3000,
    );
  };

  const myControlled = drivingCount(controllers, myId);

  return (
    <>
      <button
        ref={triggerRef}
        className={`${styles.chip} ${open ? styles.chipOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${devices.length} device${devices.length === 1 ? '' : 's'} connected`}
      >
        <span aria-hidden="true">🖥</span>
        <span className={styles.chipCount}>{devices.length}</span>
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            role="dialog"
            aria-label="Connected devices"
          >
            <div className={styles.panelHead}>Connected devices</div>

            <ul className={styles.deviceList}>
              {devices.map((d) => {
                const driving = drivingCount(controllers, d.clientId);
                const isMe = d.clientId === myId;
                return (
                  <li key={d.clientId} className={styles.device}>
                    <span className={styles.deviceIcon} aria-hidden="true">
                      {d.isLocal ? '🖥' : '📱'}
                    </span>
                    <span className={styles.deviceMain}>
                      <span className={styles.deviceLabel}>
                        <span className={styles.deviceName} title={d.label}>{d.label}</span>
                        {isMe && <span className={styles.youTag}>this device</span>}
                      </span>
                      <span className={styles.deviceMeta}>
                        {driving > 0
                          ? `driving ${driving} session${driving === 1 ? '' : 's'}`
                          : 'watching only'}
                        {' · '}
                        joined {relativeTime(d.connectedAt)}
                      </span>
                      <span className={styles.deviceAddress}>{formatAddress(d.address)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>

            <p className={styles.explainer}>
              Everyone sees every session live. Only the device driving a session
              can type into it — open a session to take over.
            </p>

            {networkUrl && (
              <div className={styles.networkInfo}>
                <span className={styles.networkLabel}>Connect a phone at</span>
                <span className={styles.networkRow}>
                  <span className={styles.networkUrl}>{networkUrl}</span>
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={handleCopyNetworkUrl}
                    title="Copy address"
                    aria-label="Copy address"
                  >
                    {copied ? '✓' : '⧉'}
                  </button>
                </span>
              </div>
            )}

            {myControlled > 0 && (
              <button className={styles.releaseBtn} onClick={handleReleaseAll}>
                Release my {myControlled} session{myControlled === 1 ? '' : 's'}
              </button>
            )}

            {/* Remote devices are refused outright when no password is set
                (403 / ws 4003), so this is now a "why can't my phone connect"
                explainer rather than the old "anyone can get in" alarm. Shown
                whenever a LAN URL is on offer above — i.e. exactly when the
                user might try to use it — not only once a remote device has
                somehow appeared. */}
            {/* `npm run set-password`, NOT `npm run setup`: the setup wizard
                hard-codes <repo>/data/server-config.json, but a packaged app
                reads $APP_USER_DATA/server-config.json — so the wizard writes a
                password this app never reads, and appears to do nothing. */}
            {networkUrl && !passwordEnabled && (
              <p className={styles.warn}>
                ⚠ Other devices are blocked until you set a password.
                Run <code>npm run set-password</code> on this machine to allow them.
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
