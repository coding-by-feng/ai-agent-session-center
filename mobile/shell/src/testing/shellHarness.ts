// shellHarness.ts — the shell app on a fake phone and a fake Mac, for the screen tests (AASC-17).
// Plain TS (no vitest import) so it type-checks with the shell; never bundled.
import { createShellApp, type ShellApp, type ShellTiming } from '../app.js';
import { createFakeMac, type FakeDeviceStatus, type FakeMacOptions } from '../dev/fakeMac.js';
import type { ShellDeps, ShellOs } from '../native.js';
import { loadMacs, saveMacs, withMac, writeMacCredentials, type SavedMac } from '../savedMacs.js';

export const TAILNET = 'http://100.101.102.103:3333';
export const LAN = 'http://192.168.1.20:3333';
export const LINK = 'https://aasc.work/pair#v=2&name=Kason-MBP&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=K7Q2M9XPZT'
  + '&be=api.aasc.work&bc=abcdefghijklmnopqrstuv&md=mac-dev-1';
export const LAN_ONLY_LINK = 'https://aasc.work/pair#v=2&name=Home-Mac&lan=192.168.1.20&p=3333&mc=K7Q2M9XPZT';

export interface HarnessOptions {
  mac?: FakeMacOptions;
  search?: string;
  launchUrl?: string | null;
  os?: ShellOs;
  scan?: () => Promise<string | null>;
  /** Pre-filled Preferences (the saved list) and vault. */
  store?: Record<string, string>;
  vault?: Record<string, string>;
  vaultFails?: boolean;
  timing?: ShellTiming;
}

export function createHarness(opts: HarnessOptions = {}) {
  const mac = createFakeMac({ reachable: [TAILNET], approveAfter: null, confirmCode: '482913', ...opts.mac });
  const vault = new Map<string, string>(Object.entries(opts.vault ?? {}));
  const store = new Map<string, string>(Object.entries(opts.store ?? {}));
  const cookies: Array<{ origin: string; token: string; maxAgeSeconds: number }> = [];
  const cleared: string[] = [];
  const navigations: string[] = [];
  const allowed: string[][] = [];
  let linkListener: ((url: string) => void) | null = null;

  const deps: ShellDeps = {
    os: opts.os ?? 'android',
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
  };

  const root = document.createElement('div');
  document.body.append(root);
  const app: ShellApp = createShellApp(root, deps, opts.timing ?? { pollMs: 5, pollMaxMs: 60_000 });

  return { app, root, mac, deps, vault, store, cookies, cleared, navigations, allowed, openLink: (url: string) => linkListener?.(url) };
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
