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
 *
 * ## Two parts (plan 18 stage 2, Nov 20 2026)
 *
 * Where the account channels exist (`electronAPI.remotes.accountMachines`: the
 * desktop app on this computer, Full and Lite), the panel has two parts:
 * **Switch** (`DevicesSwitcher`, shown each time it opens) and **This computer**,
 * which holds what the panel held before with `MachineAccountSettings` in the
 * place of the remote computers, since Switch lists those. Only the part in view
 * is mounted, so only its polls run. Everywhere else (a browser, another device,
 * an app without the channels) the panel is what it was, pinned by
 * DevicePresenceChip.unchanged.test.tsx.
 *
 * ## From the keyboard (plan 18 §5.4)
 *
 * - **Opening on Switch puts focus in it** (`focusOnOpen`, `useSwitcherKeys`): the
 *   panel is portaled to the end of <body>, so Tab from the chip never reached it.
 *   A press on a part's tab is not an opening and moves no focus.
 * - **Escape closes the panel and returns focus** to the chip, or to what had focus
 *   when the `switchDevice` key opened it. The Escape is the panel's alone: before,
 *   the same press also reached the session panel's window listener, which brought
 *   a minimized session back and so took the header, and this chip, off the screen.
 * - **`switchDevice`** (⇧⌘S / Ctrl+Shift+S, `DEVICES_SWITCH_EVENT`) opens the panel
 *   on Switch, brings an open panel to Switch, and closes one already there. Focus
 *   moves onto the panel at once, before any row is read, so the next key is never
 *   typed into the terminal it came from. Only with the Switch part.
 * - **`chipless`**: a session panel in view hides the Header, and this chip with it,
 *   which is when the key is pressed from a terminal. App mounts a chip-less copy
 *   there: no button, no polling, nothing drawn until the key opens the same panel
 *   under the window's top right corner.
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import { releaseAllControls } from '@/lib/presenceClient';
import { deviceChipTitle, drivingCount, summarizePhones } from '@/lib/devicePresenceSummary';
import { DEVICES_SWITCH_EVENT, hasAccountChannels } from '@/lib/devicesSwitcher';
import { usePairedPhones, usePanelNetwork } from '@/hooks/useDevicePanelData';
import ConnectedDeviceList from '@/components/layout/ConnectedDeviceList';
import PanelNetworkAddress from '@/components/layout/PanelNetworkAddress';
import DeviceKindIcon from '@/components/layout/DeviceKindIcon';
import Tabs from '@/components/ui/Tabs';
import { showToast } from '@/components/ui/ToastContainer';
import { useIsDesktopApp } from '@/lib/platform';
import styles from '@/styles/modules/DevicePresence.module.css';

// Lazy: the pairing section carries a QR encoder, and this chip sits in the
// eager header chunk. It only loads when a local user opens the panel.
const PhonePairing = lazy(() => import('@/components/layout/PhonePairing'));
const SharingDefault = lazy(() => import('@/components/layout/SharingDefault'));
const RemoteComputers = lazy(() => import('@/components/layout/RemoteComputers'));
const DevicesSwitcher = lazy(() => import('@/components/layout/DevicesSwitcher'));
const MachineAccountSettings = lazy(() => import('@/components/layout/MachineAccountSettings'));

/** The panel's two parts, where the account channels exist. */
type PanelPart = 'switch' | 'this-computer';

/** Gap kept between the panel and the viewport edge. */
const VIEWPORT_PAD = 8;
const PANEL_WIDTH = 320;
/** The panel with Switch and This computer (plan 18). */
const SWITCHER_PANEL_WIDTH = 360;

export interface DevicePresenceChipProps {
  /** The panel without its chip, for where the Header is hidden: see "From the keyboard" above. */
  chipless?: boolean;
}

export default function DevicePresenceChip({ chipless = false }: DevicePresenceChipProps = {}) {
  const devices = usePresenceStore((s) => s.devices);
  // Subscribed so the per-device "driving N sessions" counts re-render when a
  // baton moves, and read directly (rather than via a getState() helper) so the
  // subscription is what actually feeds the render.
  const controllers = usePresenceStore((s) => s.controllers);
  const [open, setOpen] = useState(false);
  /** Which part shows; every opening starts on Switch. */
  const [part, setPart] = useState<PanelPart>('switch');
  /** The panel has just opened on Switch, or the key brought it there: focus goes into the part. A tab press ends it. */
  const [arrival, setArrival] = useState(false);
  /** Where a close from the keyboard puts focus: what had it when the key opened the panel; null means the chip. */
  const returnTo = useRef<HTMLElement | null>(null);
  /** The key opened the panel: focus moves onto it as soon as it is drawn. */
  const takeFocus = useRef(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const myId = getClientId();

  const isMac = isLocalDevice(devices, myId);
  // Which devices are connected, not every presence update (a baton move is one too).
  const deviceKey = devices.map((d) => d.clientId).join(',');
  // A chip-less copy draws no counts, so it reads none.
  const pairedPhones = usePairedPhones(isMac && !chipless, deviceKey);
  const { networkUrl, passwordEnabled } = usePanelNetwork(open);

  // Pairing answers the AASC page on this machine only; a remote device would
  // get 404s, so the section isn't offered there.
  const canPairPhones = isLocalDevice(devices, myId);
  // Remote computers live in Electron's main process: the desktop app on this machine only.
  const isDesktopApp = useIsDesktopApp();
  const canPairRemotes = canPairPhones && isDesktopApp && !!window.electronAPI?.remotes;
  // The account's computers (plan 18): the app's main process must offer them. A Client edition's doesn't.
  const hasSwitcher = canPairRemotes && hasAccountChannels();
  // The two-part panel is a little wider: its footer holds two actions that need 327px to share a row.
  const panelWidth = hasSwitcher ? SWITCHER_PANEL_WIDTH : PANEL_WIDTH;

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    // Shrink before placing: on a 320px-wide phone the full-width panel cannot
    // fit alongside both pads, so clamping position alone still overruns the
    // right edge by the difference. Width first, then position.
    const width = Math.min(panelWidth, window.innerWidth - VIEWPORT_PAD * 2);
    // Right-align to the trigger, then clamp inside the viewport. On a narrow
    // window the chip sits close enough to the edge that an unclamped panel
    // would render partly offscreen.
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rect.right - width),
      window.innerWidth - width - VIEWPORT_PAD,
    );
    setPos({ top: rect.bottom + 6, left: Math.max(VIEWPORT_PAD, left), width });
  }, [panelWidth]);

  /**
   * Chip-less, there is no chip to hang from: the window's top right corner, under whatever sits above the page
   * (the macOS title bar). Called from the key's and the window's listeners, never from an effect's own body.
   */
  const placeInCorner = useCallback(() => {
    const width = Math.min(panelWidth, window.innerWidth - VIEWPORT_PAD * 2);
    const top = document.querySelector('main')?.getBoundingClientRect().top ?? 0;
    setPos({ top: top + VIEWPORT_PAD, left: Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD), width });
  }, [panelWidth]);

  const closeFromKeyboard = useCallback(() => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    (back?.isConnected ? back : triggerRef.current)?.focus();
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const reposition = chipless ? placeInCorner : place;
    // `capture: true` is required: scroll does not bubble, so an inner
    // container's scroll is only observable during the capture phase.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // A row's ⋯ menu (Remote computers) is portaled to <body>: a pick in it is still inside the panel.
      if (target instanceof Element && target.closest('[data-menu-popover]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The panel's alone: it must not also reach the session panel's window listener behind it.
      e.stopPropagation();
      closeFromKeyboard();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, place, placeInCorner, chipless, closeFromKeyboard]);

  // The `switchDevice` key. setState from a listener's callback, never from the effect's own body.
  useEffect(() => {
    if (!hasSwitcher) return undefined;
    const onSwitchKey = () => {
      if (open && part === 'switch') {
        closeFromKeyboard();
        return;
      }
      if (!open) {
        const active = document.activeElement;
        returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
        takeFocus.current = true;
        if (chipless) placeInCorner();
        setOpen(true);
      }
      setPart('switch');
      setArrival(true);
    };
    document.addEventListener(DEVICES_SWITCH_EVENT, onSwitchKey);
    return () => document.removeEventListener(DEVICES_SWITCH_EVENT, onSwitchKey);
  }, [hasSwitcher, chipless, open, part, placeInCorner, closeFromKeyboard]);

  useEffect(() => {
    if (!open || !pos || !takeFocus.current) return;
    takeFocus.current = false;
    panelRef.current?.focus();
  }, [open, pos]);

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
  const phoneSummary = summarizePhones(canPairPhones ? pairedPhones : null);

  /** What the panel held before the switcher: all of it without the account channels, the This computer part with them. */
  const thisComputer = (
    <>
      {/* The actions lead, so Pair is in view without scrolling; the devices list follows them. */}
      {canPairPhones && (
        <Suspense fallback={null}>
          <SharingDefault />
          <PhonePairing />
          {/* With the switcher, the remote computers are its rows; their place here goes to the account settings. */}
          {hasSwitcher ? <MachineAccountSettings /> : canPairRemotes && <RemoteComputers />}
        </Suspense>
      )}

      <div className={styles.panelHead}>Connected devices</div>

      <ConnectedDeviceList devices={devices} controllers={controllers} myId={myId} />

      <p className={styles.explainer}>
        Everyone sees every session live. Only the device driving a session
        can type into it — open a session to take over.
      </p>

      {networkUrl && <PanelNetworkAddress url={networkUrl} />}

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
    </>
  );

  return (
    <>
      {!chipless && <button
        ref={triggerRef}
        className={`${styles.chip} ${open ? styles.chipOpen : ''}`}
        onClick={() => {
          returnTo.current = null;
          setPart('switch');
          setArrival(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={deviceChipTitle(devices.length, phoneSummary)}
        aria-label={deviceChipTitle(devices.length, phoneSummary)}
      >
        <DeviceKindIcon kind="computer" className={styles.chipIcon} />
        <span className={styles.chipCount}>{devices.length}</span>
        {phoneSummary && phoneSummary.paired + phoneSummary.tablets > 0 && (
          <>
            <span className={styles.chipSep} aria-hidden="true">·</span>
            {phoneSummary.paired > 0 && (
              <>
                <DeviceKindIcon kind="phone" className={styles.chipIcon} />
                <span className={styles.chipCount}>{phoneSummary.paired}</span>
              </>
            )}
            {phoneSummary.tablets > 0 && (
              <>
                <DeviceKindIcon kind="tablet" className={styles.chipIcon} />
                <span className={styles.chipCount}>{phoneSummary.tablets}</span>
              </>
            )}
            {phoneSummary.online > 0 && <span className={styles.chipOnlineDot} aria-hidden="true" />}
          </>
        )}
      </button>}

      {open && pos &&
        createPortal(
          <div
            ref={panelRef}
            className={styles.panel}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            role="dialog"
            aria-label="Connected devices"
            // With the Switch part the key lands focus here first. Never a tab stop.
            tabIndex={hasSwitcher ? -1 : undefined}
          >
            {hasSwitcher ? (
              <Tabs
                tabs={[
                  {
                    id: 'switch',
                    label: 'Switch',
                    content: (
                      // Keyed: This computer also starts with a <Suspense>, and React would reuse this one for
                      // it, keeping the switcher mounted (hidden, still polling) while those sections load.
                      <Suspense key="switch" fallback={null}>
                        <DevicesSwitcher onLeave={() => setOpen(false)} focusOnOpen={arrival} />
                      </Suspense>
                    ),
                  },
                  { id: 'this-computer', label: 'This computer', content: thisComputer },
                ]}
                activeTab={part}
                onTabChange={(id) => {
                  setPart(id === 'this-computer' ? 'this-computer' : 'switch');
                  setArrival(false);
                }}
                tabListClassName={styles.parts}
                tabClassName={styles.part}
                activeTabClassName={styles.partActive}
                panelClassName={styles.partPanel}
              />
            ) : thisComputer}
          </div>,
          document.body,
        )}
    </>
  );
}
