// shellHarness.ts — the shell app on a fake phone and a fake Mac, for the screen tests (AASC-17).
// Plain TS (no vitest import) so it type-checks with the shell; never bundled.
import { createShellApp, type ShellApp, type ShellTiming } from '../app.js';
import type { FormFactor } from '../formFactor.js';
import { createFakeMac, type FakeDeviceStatus, type FakeMac, type FakeMacOptions } from '../dev/fakeMac.js';
import type { AuthSession, AuthSessionResult, BiometricGate, PushHost, RawShare, ShellDeps, ShellOs } from '../native.js';
import type { BrowseResult } from '../lanRescan.js';
import type { NotificationLike } from '../pushPayload.js';
import { loadMacs, saveMacs, withMac, writeMacCredentials, type SavedMac } from '../savedMacs.js';

export const TAILNET = 'http://100.101.102.103:3333';
export const LAN = 'http://192.168.1.20:3333';
export const LINK = 'https://aasc.work/pair#v=2&name=Kason-MBP&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=K7Q2M9XPZT';
/** A QR from before AASC-52: it also carried a backend code, which the shell now ignores. */
export const LEGACY_LINK = `${LINK}&be=api.aasc.work&bc=abcdefghijklmnopqrstuv&md=7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f`;
export const LAN_ONLY_LINK = 'https://aasc.work/pair#v=2&name=Home-Mac&lan=192.168.1.20&p=3333&mc=K7Q2M9XPZT';

export interface HarnessOptions {
  mac?: FakeMacOptions;
  /** The same fake Mac again (a later launch of the same phone); `mac` is ignored then. */
  fakeMac?: FakeMac;
  search?: string;
  launchUrl?: string | null;
  os?: ShellOs;
  formFactor?: FormFactor;
  scan?: () => Promise<string | null>;
  /** Pre-filled Preferences (the saved list) and vault. */
  store?: Record<string, string>;
  vault?: Record<string, string>;
  vaultFails?: boolean;
  timing?: ShellTiming;
  /** AASC-19/21 extras; each absent unless given. */
  push?: { configured: boolean; permission?: 'granted' | 'prompt' | 'denied' };
  share?: RawShare | null;
  biometric?: { available: boolean; pass: boolean; bootId?: string | null };
  widget?: boolean;
  /** Bonjour on this Wi-Fi: what the native browse finds (absent: the phone has no browser, sweep only). */
  discovery?: () => Promise<BrowseResult>;
  /**
   * Plan 17: the sign-in sheet. `true`: it goes through the fake backend's Google redirect as a user who signs in;
   * a function: the test decides what comes back (`redirect` is what the fake backend would send). Absent: none.
   */
  authSession?: true | ((startUrl: string, redirect: string | null) => Promise<AuthSessionResult>);
}

export function createHarness(opts: HarnessOptions = {}) {
  const mac = opts.fakeMac ?? createFakeMac({ reachable: [TAILNET], approveAfter: null, confirmCode: '482913', ...opts.mac });
  const vault = new Map<string, string>(Object.entries(opts.vault ?? {}));
  const store = new Map<string, string>(Object.entries(opts.store ?? {}));
  const cookies: Array<{ origin: string; token: string; maxAgeSeconds: number }> = [];
  const cleared: string[] = [];
  const navigations: string[] = [];
  const allowed: string[][] = [];
  let linkListener: ((url: string) => void) | null = null;
  const extras = {
    channels: [] as string[],
    registered: 0,
    permissionAsked: 0,
    tap: null as ((n: NotificationLike) => void) | null,
    /** The platform's token listener: a test calls it to hand the registrar a push token. */
    token: null as ((token: string) => void) | null,
    share: opts.share ?? null,
    authAsked: 0,
    biometricPass: opts.biometric?.pass ?? false,
    pause: null as (() => void) | null,
    resume: null as (() => void) | null,
    widget: [] as string[],
    /** Every sign-in sheet opened: the start URL and the callback it waits for. */
    authStarts: [] as Array<{ url: string; callback: { scheme?: string; prefix?: string } }>,
  };
  const authSession: AuthSession | undefined = opts.authSession && {
    start: async (url, callback) => {
      extras.authStarts.push({ url, callback });
      const redirect = mac.googleRedirect(url);
      if (opts.authSession === true) return redirect ? { url: redirect } : { cancelled: true };
      return (opts.authSession as (u: string, r: string | null) => Promise<AuthSessionResult>)(url, redirect);
    },
  };
  const push: PushHost | undefined = opts.push && {
    configured: async () => opts.push!.configured,
    createChannels: async (channels) => {
      extras.channels.push(...channels.map((c) => c.id));
    },
    platform: {
      os: 'android',
      checkPermission: async () => opts.push!.permission ?? 'prompt',
      requestPermission: async () => {
        extras.permissionAsked += 1;
        return 'denied';
      },
      register: async () => {
        extras.registered += 1;
      },
      unregister: async () => undefined,
      onToken: (cb) => {
        extras.token = cb;
        return () => {
          extras.token = null;
        };
      },
      onRegistrationError: () => () => undefined,
      environment: () => 'production',
    },
    onTap: (cb) => {
      extras.tap = cb;
      return () => {
        extras.tap = null;
      };
    },
  };
  const biometric: BiometricGate | undefined = opts.biometric && {
    available: async () => opts.biometric!.available,
    authenticate: async () => {
      extras.authAsked += 1;
      return extras.biometricPass;
    },
    bootId: async () => (opts.biometric!.bootId === undefined ? 'boot-1' : opts.biometric!.bootId),
  };

  const deps: ShellDeps = {
    os: opts.os ?? 'android',
    formFactor: opts.formFactor,
    vault: {
      get: async (k) => vault.get(k) ?? null,
      set: async (k, v) => {
        if (opts.vaultFails) throw new Error('keystore unavailable');
        vault.set(k, v);
      },
      delete: async (k) => {
        vault.delete(k);
      },
    },
    store: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        store.set(k, v);
      },
    },
    http: mac.http,
    requester: mac.requester,
    cookies: {
      set: async (origin, token, maxAgeSeconds) => {
        cookies.push({ origin, token, maxAgeSeconds });
      },
      clear: async (origin) => {
        cleared.push(origin);
      },
    },
    scanner: { available: Boolean(opts.scan), scan: opts.scan ?? (async () => null) },
    navigator: {
      allowOrigins: async (origins) => {
        allowed.push([...origins]);
      },
      go: (url) => {
        navigations.push(url);
      },
      search: () => opts.search ?? '',
      launchUrl: async () => opts.launchUrl ?? null,
      onLinkOpened: (cb) => {
        linkListener = cb;
        return () => {
          linkListener = null;
        };
      },
    },
    newId: () => crypto.randomUUID(),
    push,
    biometric,
    share: 'share' in opts ? {
      take: async () => {
        const taken = extras.share;
        extras.share = null;
        return taken;
      },
    } : undefined,
    lifecycle: opts.biometric ? {
      onPause: (cb) => {
        extras.pause = cb;
        return () => undefined;
      },
      onResume: (cb) => {
        extras.resume = cb;
        return () => undefined;
      },
    } : undefined,
    widget: opts.widget ? { write: async (json) => { extras.widget.push(json); } } : undefined,
    discovery: opts.discovery ? { browse: opts.discovery } : undefined,
    authSession,
  };

  const root = document.createElement('div');
  document.body.append(root);
  const app: ShellApp = createShellApp(root, deps, opts.timing ?? { pollMs: 5, pollMaxMs: 60_000 });

  return { app, root, mac, deps, vault, store, cookies, cleared, navigations, allowed, extras, openLink: (url: string) => linkListener?.(url) };
}

export type Harness = ReturnType<typeof createHarness>;

export const KASON_MBP: SavedMac = {
  id: '6f1c2a10-0000-4000-8000-000000000001', name: 'Kason-MBP', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103',
  lanAllowed: false, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Pixel', lastPath: 'tailnet',
};
export const STUDIO: SavedMac = {
  id: '6f1c2a10-0000-4000-8000-000000000002', name: 'Studio', port: 3333, lan: null, tailnet: '100.88.1.7',
  lanAllowed: false, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Pixel', lastPath: null,
};

/** A Mac this phone paired with earlier (before `app.start()`). */
export async function seedMac(t: Harness, mac: SavedMac, status: FakeDeviceStatus = 'active'): Promise<void> {
  await writeMacCredentials(t.deps.vault, mac.id, t.mac.seedDevice(status));
  await saveMacs(t.deps.store, withMac(await loadMacs(t.deps.store), mac));
}

/** Paste `link`, confirm, pair: ends on "Approve on your Mac". */
export async function pairUntilApproval(t: Harness, link = LINK): Promise<void> {
  await t.app.start();
  fill(t.root, 'Pairing link', link);
  submit(t.root, 'Paste the pairing link');
  await until(t.root, () => t.root.dataset.screen === 'confirm');
  click(t.root, 'Pair');
  await until(t.root, () => heading(t.root) === 'Approve on your Mac');
}

// ── DOM helpers ──────────────────────────────────────────────────────────

export function buttonNamed(root: ParentNode, name: string | RegExp): HTMLButtonElement | null {
  const all = Array.from(root.querySelectorAll('button'));
  return all.find((b) => {
    const label = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return typeof name === 'string' ? label === name : name.test(label);
  }) ?? null;
}

export function click(root: ParentNode, name: string | RegExp): void {
  const b = buttonNamed(root, name);
  if (!b) throw new Error(`No button "${String(name)}" in: ${(root as HTMLElement).textContent}`);
  if (b.disabled) throw new Error(`Button "${String(name)}" is disabled`);
  b.click();
}

export function fieldLabelled(root: ParentNode, label: string): HTMLInputElement | HTMLTextAreaElement {
  const l = Array.from(root.querySelectorAll('label')).find((x) => x.textContent?.trim() === label);
  const el = l ? (root as Element).querySelector<HTMLInputElement>(`#${l.htmlFor}`) : null;
  if (!el) throw new Error(`No field "${label}"`);
  return el;
}

export function fill(root: ParentNode, label: string, value: string): void {
  const el = fieldLabelled(root, label);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function submit(root: ParentNode, formLabel: string): void {
  const form = root.querySelector<HTMLFormElement>(`form[aria-label="${formLabel}"]`);
  if (!form) throw new Error(`No form "${formLabel}"`);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

export function heading(root: ParentNode): string {
  return root.querySelector('h1')?.textContent ?? '';
}

/** Wait (real time) until `check` holds; fails with what the screen shows. */
export async function until(root: HTMLElement, check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out; screen "${root.dataset.screen}": ${root.textContent}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
