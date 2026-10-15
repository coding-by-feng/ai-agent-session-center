// app.ts — the shell's screens wired to its flows (AASC-17).
//
// One screen at a time, drawn from a `Screen` value. Every change of screen
// bumps `gen`, so an answer that arrives for a screen the user already left is
// dropped. Work that writes the saved list runs one at a time (`serial`), so an
// approval check and an unpair can't overwrite each other's list.
//
// Never acts on a link without a tap: a scanned, pasted, typed or opened link
// only ever leads to "Pair with <Mac>?".
import type { Candidate } from './connectionPlan.js';
import { manualLink } from './manualEntry.js';
import type { ShellDeps } from './native.js';
import { parsePairingLink, type PairingLink } from './pairingLink.js';
import { parseReauthRequest } from './reauth.js';
import { allowedOrigins, LAST_MAC_KEY, loadMacs, saveMacs, withMac, type SavedMac } from './savedMacs.js';
import { pairNewMac, signInAndOpen, unpairMac, type OpenOutcome } from './shellFlows.js';
import { cleanLabel } from './text.js';
import { renderMacs, renderSettings } from './ui/macScreens.js';
import { renderConfirm, renderNeedsApp, renderPair } from './ui/pairScreens.js';
import { PATH_LABEL } from './ui/parts.js';
import type { Actions, Screen, ScreenContext } from './ui/screen.js';
import { renderApprove, renderConnecting, renderOffline } from './ui/statusScreens.js';

/** How often the approval screen asks the Mac. */
export const APPROVAL_POLL_MS = 3_000;
/** Past the Mac's 10-minute pending expiry (deviceAuth PENDING_TTL_MS): it has answered by then. */
export const APPROVAL_POLL_MAX_MS = 11 * 60_000;
/** AASC's default port, prefilled in the typed-code form (the Mac's code screen doesn't show it). */
const DEFAULT_PORT = '3333';

/**
 * Preferences key: a hash of the launch link already handled. The app keeps
 * its launch link for the activity's lifetime, so without this every return to
 * the shell would ask "Pair with …?" again for a code that's spent. A hash: the
 * link carries one-time codes, which don't belong in Preferences.
 */
export const HANDLED_LAUNCH_KEY = 'aasc.handledLaunch';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const BAD_LINK_MESSAGE = 'That isn’t an AASC pairing link. It starts with https://aasc.work/pair#';

export interface ShellApp {
  start(): Promise<void>;
  dispose(): void;
  /** The screen on show (tests, and the native layer's back button later). */
  current(): Screen;
}

function pairScreen(notice: string | null = null, error: string | null = null): Screen {
  return { name: 'pair', notice, error, linkText: '', address: '', port: DEFAULT_PORT, code: '', manualOpen: false, manualError: null };
}

export interface ShellTiming {
  pollMs: number;
  pollMaxMs: number;
}

export function createShellApp(
  root: HTMLElement, deps: ShellDeps | null, timing: ShellTiming = { pollMs: APPROVAL_POLL_MS, pollMaxMs: APPROVAL_POLL_MAX_MS },
): ShellApp {
  let screen: Screen = pairScreen();
  let macs: SavedMac[] = [];
  let gen = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let offLink: (() => void) | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const find = (id: string) => macs.find((m) => m.id === id);
  const homeScreen = (notice: string | null = null): Screen => (macs.length ? { name: 'macs', notice } : pairScreen(notice));
  const defaultPhoneName = () => (deps?.os === 'ios' ? 'iPhone' : deps?.os === 'android' ? 'Android phone' : 'Phone');

  function stopPoll(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function show(next: Screen): void {
    gen += 1;
    stopPoll();
    screen = next;
    render(true);
  }

  function update(patch: Partial<Record<string, unknown>>): void {
    screen = { ...screen, ...patch } as Screen;
    render(false);
  }

  function render(moved: boolean): void {
    const focusedId = root.contains(document.activeElement) ? document.activeElement?.id : '';
    root.replaceChildren(draw());
    root.dataset.screen = screen.name;
    const again = !moved && focusedId ? root.querySelector<HTMLElement>(`#${focusedId}`) : null;
    (again ?? root.querySelector<HTMLElement>('#screen-title'))?.focus({ preventScroll: !moved });
  }

  function draw(): HTMLElement {
    const ctx: ScreenContext = { macs, scannerAvailable: deps?.scanner.available ?? false, actions };
    const s = screen;
    switch (s.name) {
      case 'needs-app': return renderNeedsApp();
      case 'pair': return renderPair(s, ctx);
      case 'confirm': return renderConfirm(s, ctx);
      case 'macs': return renderMacs(s, ctx);
      case 'approve': return renderApprove(s, ctx);
      default: {
        const mac = find(s.macId);
        if (!mac) return renderMacs({ name: 'macs', notice: null }, ctx);
        if (s.name === 'settings') return renderSettings(s, mac, ctx);
        if (s.name === 'connecting') return renderConnecting(s, mac, ctx);
        return renderOffline(s, mac, ctx);
      }
    }
  }

  /** Any unexpected failure lands on a calm screen instead of a frozen one. */
  function guard(fn: () => Promise<void>): () => void {
    return () => {
      fn().catch(() => show(homeScreen('Something went wrong. Try again.')));
    };
  }

  function showConfirm(link: PairingLink): void {
    show({ name: 'confirm', link, allowLan: false, phoneName: defaultPhoneName(), busy: null, error: null });
  }

  function tryingText(mac: { name: string; port: number }, c: Candidate): string {
    return `Trying ${PATH_LABEL[c.kind]} (${new URL(c.origin).hostname}:${mac.port})…`;
  }

  // ── Approval ─────────────────────────────────────────────────────────

  function showApprove(mac: SavedMac, checkNow: boolean): void {
    show({ name: 'approve', mac, state: 'waiting', message: null });
    const my = gen;
    const started = Date.now();
    const tick = async (): Promise<void> => {
      pollTimer = null;
      const current = find(mac.id);
      if (my !== gen || !deps || !current) return;
      const out = await serial(() => signInAndOpen(deps, macs, current, '/'));
      if (my !== gen) return;
      if (out.kind === 'revoked') {
        macs = out.macs;
        update({ state: 'refused' });
        return;
      }
      if (out.kind === 'navigate') {
        leaveFor(out);
        return;
      }
      if (Date.now() - started >= timing.pollMaxMs) {
        update({ state: 'stalled', message: null });
        return;
      }
      if (out.kind === 'offline') update({ state: 'unreachable', message: null });
      else if (out.kind === 'error') update({ state: 'error', message: out.message });
      else if (screen.name === 'approve' && screen.state !== 'waiting') update({ state: 'waiting', message: null });
      pollTimer = setTimeout(() => void tick().catch(() => undefined), timing.pollMs);
    };
    pollTimer = setTimeout(() => void tick().catch(() => undefined), checkNow ? 0 : timing.pollMs);
  }

  // ── Opening a Mac ────────────────────────────────────────────────────

  function leaveFor(out: Extract<OpenOutcome, { kind: 'navigate' }>): void {
    macs = out.macs;
    show({ name: 'connecting', macId: out.mac.id, back: '/', reauth: false, status: `Loading ${out.mac.name}…` });
    deps?.navigator.go(out.url);
  }

  async function connect(mac: SavedMac, back: string, reauth: boolean): Promise<void> {
    if (!deps) return;
    if (mac.status === 'pending') {
      showApprove(mac, true);
      return;
    }
    show({ name: 'connecting', macId: mac.id, back, reauth, status: `Looking for ${mac.name}…` });
    const my = gen;
    const out = await serial(() => signInAndOpen(deps, macs, mac, back, (c) => {
      if (my === gen) update({ status: tryingText(mac, c) });
    }));
    if (my !== gen) return; // the user cancelled
    switch (out.kind) {
      case 'navigate':
        leaveFor(out);
        return;
      case 'pending':
        showApprove(out.mac, false);
        return;
      case 'revoked':
        macs = out.macs;
        show(homeScreen(out.why === 'revoked'
          ? `${mac.name} removed this phone. Pair again to use it.`
          : `This phone lost its key for ${mac.name}. Pair again to use it.`));
        return;
      case 'offline':
        show({ name: 'offline', macId: mac.id, back, reauth, tried: out.tried, message: null });
        return;
      case 'error':
        show({ name: 'offline', macId: mac.id, back, reauth, tried: [], message: out.message });
    }
  }

  // ── What the screens can ask for ─────────────────────────────────────

  const actions: Actions = {
    remember(patch) {
      screen = { ...screen, ...patch } as Screen;
    },
    update,
    scan: guard(async () => {
      if (!deps || screen.name !== 'pair') return;
      const my = gen;
      let text: string | null;
      try {
        text = await deps.scanner.scan();
      } catch {
        if (my === gen) update({ error: 'The scanner couldn’t start. Paste the link instead.' });
        return;
      }
      if (my !== gen || text === null) return;
      const link = parsePairingLink(text);
      if (link) showConfirm(link);
      else update({ error: 'That QR isn’t an AASC pairing code. Scan the one on your Mac’s devices panel.' });
    }),
    submitLink() {
      if (screen.name !== 'pair') return;
      const link = parsePairingLink(screen.linkText);
      if (link) showConfirm(link);
      else update({ error: screen.linkText.trim() ? BAD_LINK_MESSAGE : 'Paste the pairing link first.' });
    },
    submitManual() {
      if (screen.name !== 'pair') return;
      const result = manualLink({ address: screen.address, port: screen.port, code: screen.code });
      if (result.ok) showConfirm(result.link);
      else update({ manualError: { field: result.field, message: result.message }, manualOpen: true });
    },
    pair: guard(async () => {
      if (!deps || screen.name !== 'confirm' || screen.busy !== null) return;
      const { link, allowLan } = screen;
      const phoneName = cleanLabel(screen.phoneName, 60) || defaultPhoneName();
      const my = gen;
      update({ busy: `Reaching ${link.name}…`, error: null, phoneName });
      const out = await serial(() => pairNewMac(deps, macs, link, { phoneName, allowLan }, (c) => {
        if (my === gen) update({ busy: tryingText(link, c) });
      }));
      if (my !== gen) return;
      if (!out.ok) {
        update({ busy: null, error: out.message });
        return;
      }
      macs = out.macs;
      showApprove(out.mac, false);
    }),
    cancelPair() {
      if (screen.name === 'confirm' && screen.busy !== null) return;
      show(pairScreen());
    },
    cancelApproval: guard(async () => {
      if (!deps || screen.name !== 'approve') return;
      const { mac } = screen;
      stopPoll();
      gen += 1; // drop any check still under way
      const my = gen;
      update({ state: 'cancelling', message: null });
      const out = await serial(() => unpairMac(deps, macs, find(mac.id) ?? mac, { force: true }));
      if (my !== gen) return;
      if (out.done) macs = out.macs;
      show(homeScreen('Pairing cancelled.'));
    }),
    checkAgain(macId) {
      const mac = find(macId);
      if (mac) showApprove(mac, true);
      else show(homeScreen(null));
    },
    open: (macId) => guard(async () => {
      const mac = find(macId);
      if (mac) await connect(mac, '/', false);
    })(),
    retry: guard(async () => {
      if (screen.name !== 'offline') return;
      const mac = find(screen.macId);
      if (mac) await connect(mac, screen.back, screen.reauth);
      else show(homeScreen(null));
    }),
    showMacs: () => show(homeScreen(null)),
    showPair: () => show(pairScreen()),
    showSettings: (macId) => show({ name: 'settings', macId, step: 'idle', notice: null }),
    setLanAllowed: (macId, allowed) => guard(async () => {
      const mac = find(macId);
      if (!deps || !mac) return;
      const next: SavedMac = { ...mac, lanAllowed: allowed, lastPath: !allowed && mac.lastPath === 'lan' ? null : mac.lastPath };
      await serial(async () => {
        macs = withMac(macs, next);
        await saveMacs(deps.store, macs);
        await deps.navigator.allowOrigins(allowedOrigins(macs));
      });
      const notice = allowed
        ? 'The home network is tried first now, then Tailscale.'
        : next.tailnet ? 'Only Tailscale is used now.' : 'This Mac has no Tailscale address, so it can’t be reached until the home network is allowed again.';
      if (screen.name === 'settings' && screen.macId === macId) update({ notice });
    })(),
    askUnpair: () => update({ step: 'confirm', notice: null }),
    keepPaired: () => update({ step: 'idle' }),
    unpair: (macId, force) => guard(async () => {
      const mac = find(macId);
      if (!deps || !mac || screen.name !== 'settings') return;
      const my = gen;
      update({ step: 'busy' });
      const out = await serial(() => unpairMac(deps, macs, find(macId) ?? mac, { force }));
      if (my !== gen) return;
      if (!out.done) {
        update({ step: 'unreachable' });
        return;
      }
      macs = out.macs;
      show(homeScreen(out.toldMac
        ? `Unpaired from ${mac.name}.`
        : `Removed ${mac.name} from this phone. Revoke it in the Mac’s devices panel too.`));
    })(),
  };

  function openLink(url: string): void {
    const link = parsePairingLink(url);
    if (link) showConfirm(link);
    else show(pairScreen(null, BAD_LINK_MESSAGE));
  }

  return {
    async start() {
      if (!deps) {
        show({ name: 'needs-app' });
        return;
      }
      macs = await loadMacs(deps.store);
      offLink = deps.navigator.onLinkOpened(openLink);
      const reauth = parseReauthRequest(deps.navigator.search());
      if (reauth) {
        // The Mac UI sent the WebView back: sign in again on the Mac it showed.
        const lastId = await deps.store.get(LAST_MAC_KEY);
        const mac = find(lastId ?? '') ?? (macs.length === 1 ? macs[0] : undefined);
        if (mac) await connect(mac, reauth.back, true);
        else show(homeScreen(null));
        return;
      }
      const launch = await deps.navigator.launchUrl().catch(() => null);
      if (launch) {
        const seen = await sha256(launch);
        if (seen !== (await deps.store.get(HANDLED_LAUNCH_KEY))) {
          await deps.store.set(HANDLED_LAUNCH_KEY, seen);
          openLink(launch);
          return;
        }
      }
      // One paired Mac: open it straight away. Several: the list, so the user picks.
      if (macs.length === 1 && macs[0].status === 'active') {
        await connect(macs[0], '/', false);
        return;
      }
      show(homeScreen(null));
    },
    dispose() {
      offLink?.();
      stopPoll();
      gen += 1;
    },
    current: () => screen,
  };
}
