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
import { createExtras } from './extras.js';
import { resumeAway } from './lockGate.js';
import { manualLink } from './manualEntry.js';
import type { ShellDeps } from './native.js';
import { pairingLinkRefusal, readPairingLink, type PairingLink } from './pairingLink.js';
import { parseReauthRequest } from './reauth.js';
import { allowedOrigins, LAST_MAC_KEY, loadMacs, saveMacs, withMac, type SavedMac } from './savedMacs.js';
import { pairNewMac, signInAndOpen, unpairMac, type OpenOutcome } from './shellFlows.js';
import { cleanLabel } from './text.js';
import { renderMacs, renderSettings } from './ui/macScreens.js';
import { renderLocked, renderPhone, renderShare } from './ui/extraScreens.js';
import { renderConfirm, renderNeedsApp, renderPair } from './ui/pairScreens.js';
import { PATH_LABEL } from './ui/parts.js';
import type { Actions, Screen, ScreenContext, UnpairStep } from './ui/screen.js';
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

/**
 * The native resume path (AASC-21 lock): `?resume=1&away=…&back=/path` from a Mac's page. Its `back`
 * goes through the same rule as a re-auth's (a path on the paired Mac, nothing else).
 */
function resumeBack(search: string): { back: string } | null {
  const p = new URLSearchParams(search);
  if (p.get('resume') !== '1') return null;
  return parseReauthRequest(`?reauth=1&back=${encodeURIComponent(p.get('back') ?? '/')}`);
}

function pairScreen(notice: string | null = null, error: string | null = null): Screen {
  return { name: 'pair', notice, error, linkText: '', address: '', port: DEFAULT_PORT, code: '', manualOpen: false, manualError: null };
}

export interface ShellTiming {
  pollMs: number;
  pollMaxMs: number;
  /** How long opening a Mac waits for its backend device (shellFlows LINK_BUDGET_MS). */
  linkMs?: number;
  /** How long opening a Mac spends retiring older rows for it (shellFlows RETIRE_BUDGET_MS). */
  retireMs?: number;
}

export function createShellApp(
  root: HTMLElement, deps: ShellDeps | null, timing: ShellTiming = { pollMs: APPROVAL_POLL_MS, pollMaxMs: APPROVAL_POLL_MAX_MS },
): ShellApp {
  let screen: Screen = pairScreen();
  let macs: SavedMac[] = [];
  let gen = 0;
  /** The Mac being unpaired from the list or its settings; one at a time. */
  let unpairing: string | null = null;
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

  // AASC-19 / AASC-21: share, lock, push, this phone's settings.
  const extras = deps
    ? createExtras({
        deps,
        macs: () => macs,
        setMacs: (next) => {
          macs = next;
        },
        screen: () => screen,
        show,
        update,
        gen: () => gen,
        home: homeScreen,
        pair: (notice) => pairScreen(notice),
        serial,
        guard,
      })
    : null;
  const noop = () => undefined;
  const extrasActions = () => extras?.actions ?? {
    shareTo: noop, shareSession: noop, finishShare: noop, unlock: noop, showPhone: noop, setLockEnabled: noop, setRelockMinutes: noop,
  };

  function stopPoll(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function show(next: Screen): void {
    gen += 1;
    stopPoll();
    screen = withoutStaleUnpair(next);
    render(true);
  }

  /** The lock shows the screen from before it again: an unpair that finished meanwhile no longer says "Telling …". */
  function withoutStaleUnpair(next: Screen): Screen {
    if (next.name === 'macs' && next.unpair?.step === 'busy' && next.unpair.macId !== unpairing) return { ...next, unpair: null };
    if (next.name === 'settings' && next.step === 'busy' && next.macId !== unpairing) return { ...next, step: 'idle' };
    return next;
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
    const ctx: ScreenContext = {
      macs,
      scannerAvailable: deps?.scanner.available ?? false,
      actions,
      lock: extras?.lockView() ?? null,
      pushNote: extras?.pushNote() ?? '',
    };
    const s = screen;
    switch (s.name) {
      case 'needs-app': return renderNeedsApp();
      case 'share': return renderShare(s, ctx);
      case 'locked': return renderLocked(s, ctx);
      case 'phone': return renderPhone(s, ctx);
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

  /** The unpair question's step, on whichever screen asks it: the Mac's settings or its row in Your Macs. */
  function asksAbout(macId: string): boolean {
    return (screen.name === 'macs' && screen.unpair?.macId === macId)
      || (screen.name === 'settings' && screen.macId === macId && screen.step !== 'idle');
  }

  function setUnpairStep(macId: string, step: UnpairStep, clearNotice = false): void {
    const notice = clearNotice ? { notice: null } : {};
    if (screen.name === 'macs') update({ unpair: step === 'idle' ? null : { macId, step }, ...notice });
    else if (screen.name === 'settings' && screen.macId === macId) update({ step, ...notice });
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
      const out = await openMac(deps, current, '/', my);
      if (my !== gen) return;
      if (out.kind === 'revoked') {
        update({ state: 'refused' });
        return;
      }
      if (out.kind === 'navigate') {
        await extras?.approved(); // the one-time notification question, before the Mac's page loads
        if (my === gen) leaveFor(out);
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

  /**
   * signInAndOpen in its serial turn, leaving `macs` as the store has it whatever the screen does next: a sign-in
   * may retire other rows for this Mac or forget this one, and the next turn (a cancel's unpair) reads `macs`.
   * Once the user has moved on (`gen`), no other row is retired.
   */
  function openMac(
    d: ShellDeps, mac: SavedMac, back: string, my: number, onTry?: (c: Candidate) => void, onSearch?: () => void,
  ): Promise<OpenOutcome> {
    return serial(async () => {
      const out = await signInAndOpen(d, macs, mac, back, onTry, {
        linkMs: timing.linkMs, retireMs: timing.retireMs, proceed: () => my === gen, onSearch,
      });
      if (out.kind === 'navigate' && out.retired && my !== gen) void extras?.backendLinked(); // drop the retired rows' push credentials
      if (out.kind === 'navigate' || out.kind === 'revoked' || (out.kind === 'error' && out.macs)) {
        macs = out.macs ?? macs;
        // The user went back meanwhile: what they see must not keep a row this sign-in removed.
        if (my !== gen && screen.name === 'settings' && !find(screen.macId)) show(homeScreen(null));
        else if (my !== gen && screen.name === 'macs') {
          if (macs.length) render(false);
          else show(homeScreen(null));
        }
      }
      return out;
    });
  }

  function leaveFor(out: Extract<OpenOutcome, { kind: 'navigate' }>): void {
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
    const out = await openMac(deps, mac, back, my, (c) => {
      if (my === gen) update({ status: tryingText(mac, c) });
    }, () => {
      if (my === gen) update({ status: `Looking for ${mac.name}…` });
    });
    if (my !== gen) return; // the user cancelled
    switch (out.kind) {
      case 'navigate':
        // Push registers (or drops a retired row's credential) before the Mac's page loads.
        if (out.backendLinked || out.retired) await extras?.backendLinked();
        if (my === gen) leaveFor(out);
        return;
      case 'pending':
        showApprove(out.mac, false);
        return;
      case 'revoked':
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
      const read = readPairingLink(text);
      if (read.ok) showConfirm(read.link);
      else update({ error: pairingLinkRefusal(read, 'That QR isn’t an AASC pairing code. Scan the one on your Mac’s devices panel.') });
    }),
    submitLink() {
      if (screen.name !== 'pair') return;
      const read = readPairingLink(screen.linkText);
      if (read.ok) showConfirm(read.link);
      else update({ error: screen.linkText.trim() ? pairingLinkRefusal(read, BAD_LINK_MESSAGE) : 'Paste the pairing link first.' });
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
    askUnpair: (macId) => {
      // In the list, tapping the row's 🗑 again closes its question; one row asks at a time.
      if (unpairing !== null) return;
      const again = screen.name === 'macs' && screen.unpair?.macId === macId;
      setUnpairStep(macId, again ? 'idle' : 'confirm', true);
    },
    keepPaired: (macId) => {
      setUnpairStep(macId, 'idle');
      // Back on the row's 🗑, not the page title, so the list keeps its place.
      if (screen.name === 'macs') root.querySelector<HTMLElement>(`#unpair-${macId}`)?.focus();
    },
    unpair: (macId, force) => guard(async () => {
      const mac = find(macId);
      if (!deps || !mac || unpairing !== null || (screen.name !== 'settings' && screen.name !== 'macs')) return;
      unpairing = macId;
      setUnpairStep(macId, 'busy');
      let out: Awaited<ReturnType<typeof unpairMac>>;
      try {
        out = await serial(() => unpairMac(deps, macs, find(macId) ?? mac, { force }));
      } finally {
        unpairing = null;
      }
      // The phone has forgotten it, whatever shows now: a list drawn meanwhile must lose it too.
      if (out.done) macs = out.macs;
      // Answer the screen still asking about this Mac (the same one, or the one the lock brought back); any other
      // screen only needs a list without it.
      if (!asksAbout(macId)) {
        if (out.done && screen.name === 'macs') {
          if (macs.length) render(false);
          else show(homeScreen(null));
        }
        return;
      }
      if (!out.done) {
        setUnpairStep(macId, 'unreachable');
        return;
      }
      show(homeScreen(out.toldMac
        ? `Unpaired from ${mac.name}.`
        : `Removed ${mac.name} from this phone. Revoke it in the Mac’s devices panel too.`));
    })(),
    ...extrasActions(),
  };

  function openLink(url: string): void {
    const read = readPairingLink(url);
    if (read.ok) showConfirm(read.link);
    else show(pairScreen(null, pairingLinkRefusal(read, BAD_LINK_MESSAGE)));
  }

  /** The Mac this phone opened last (signInAndOpen stamps it), else the only one paired. */
  async function lastOrOnlyMac(d: ShellDeps): Promise<SavedMac | undefined> {
    return find((await d.store.get(LAST_MAC_KEY)) ?? '') ?? (macs.length === 1 ? macs[0] : undefined);
  }

  /** The rest of the start once the lock (if any) let it through. */
  async function boot(d: ShellDeps, search: string): Promise<void> {
    if (await extras?.takeShare()) return;
    const reauth = resumeBack(search) ?? parseReauthRequest(search);
    if (reauth) {
      // The Mac UI sent the WebView back: sign in again on the Mac it showed.
      const mac = await lastOrOnlyMac(d);
      if (mac) await connect(mac, reauth.back, true);
      else show(homeScreen(null));
      return;
    }
    const launch = await d.navigator.launchUrl().catch(() => null);
    if (launch) {
      const seen = await sha256(launch);
      if (seen !== (await d.store.get(HANDLED_LAUNCH_KEY))) {
        await d.store.set(HANDLED_LAUNCH_KEY, seen);
        openLink(launch);
        return;
      }
    }
    // The phone sent the app back for a notification tap (AASC-19, MainActivity): the tap, held
    // until push starts listening, picks the session. Opening a Mac here would race it. The Mac's
    // page sends it here too (More → Switch Mac, thisPhone.ts), to pick another Mac or pair one.
    if (new URLSearchParams(search).get('tap') === '1') {
      show(homeScreen(null));
      return;
    }
    // The Mac used last (or the only one) opens straight away, even with several paired (Oct 21
    // 2026: two saved rows stopped every launch at the list). Not while a pairing waits for approval:
    // signing in would retire it when it re-pairs that Mac (releasedTwins); the list shows it waiting.
    const mac = await lastOrOnlyMac(d);
    if (mac?.status === 'active' && !macs.some((m) => m.status === 'pending')) {
      await connect(mac, '/', false);
      return;
    }
    show(homeScreen(null));
  }

  return {
    async start() {
      if (!deps) {
        show({ name: 'needs-app' });
        return;
      }
      macs = await loadMacs(deps.store);
      offLink = deps.navigator.onLinkOpened(openLink);
      const search = deps.navigator.search();
      const away = resumeAway(search, Date.now());
      const startRest = () => boot(deps, search);
      if (extras) await extras.start(away !== null ? 'resume' : 'launch', away, startRest);
      else await startRest();
    },
    dispose() {
      extras?.dispose();
      offLink?.();
      stopPoll();
      gen += 1;
    },
    current: () => screen,
  };
}
