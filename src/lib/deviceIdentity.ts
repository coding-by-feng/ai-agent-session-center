/**
 * deviceIdentity — a stable identity for THIS browser/app install, used to
 * coordinate multiple devices pointed at the same server.
 *
 * Two facts shape the design:
 *
 *  1. The identity is per-BROWSER-PROFILE, not per-tab. Two tabs of the same
 *     browser are deliberately the same device: you should never have to fight
 *     your own second tab for control of a session. (The workspace-restore
 *     claim is separately one-shot per SERVER lifetime, so a second tab still
 *     cannot trigger a second restore — see `presenceManager.claimWorkspaceRestore`.)
 *
 *  2. `deriveDeviceLabel` is a PURE function of the three inputs a browser can
 *     report, so it is unit-testable without a DOM. The impure lookups
 *     (localStorage, `navigator`, `crypto`) are confined to `getClientId()` /
 *     `getClientLabel()` and each degrade to an in-memory value rather than
 *     throwing — Safari's private mode denies localStorage, and a device that
 *     cannot persist an id must still be able to connect.
 *
 * Keep this module import-free (no React, no stores): it is read from the WS
 * bootstrap, from Zustand stores, and from plain components alike.
 */

const CLIENT_ID_KEY = 'aasc:client-id';
const CLIENT_LABEL_KEY = 'aasc:client-label';

/** Max label length accepted by the server (`sanitizeDeviceLabel`). Keep in sync. */
export const MAX_LABEL_LENGTH = 60;

export interface DeviceProbe {
  userAgent: string;
  /** `navigator.platform`, or '' where unavailable. */
  platform: string;
  /** True when running inside the Electron shell rather than a browser tab. */
  isElectron: boolean;
}

/**
 * Human-readable device name, e.g. "iPhone · Safari", "Mac · Desktop App".
 * Pure — no globals — so the platform matrix can be tested exhaustively.
 */
export function deriveDeviceLabel(probe: DeviceProbe): string {
  const ua = probe.userAgent || '';
  const platform = probe.platform || '';
  const os = detectOs(ua, platform);
  const app = probe.isElectron ? 'Desktop App' : detectBrowser(ua);
  return `${os} · ${app}`;
}

function detectOs(ua: string, platform: string): string {
  // iPadOS 13+ reports a desktop UA; `platform` is 'MacIntel' but it exposes
  // touch points. We cannot read maxTouchPoints here (pure fn), so match the
  // explicit iPad token first and accept that a masquerading iPad reads as Mac.
  if (/\biPad\b/.test(ua)) return 'iPad';
  if (/\biPhone\b/.test(ua)) return 'iPhone';
  if (/\biPod\b/.test(ua)) return 'iPod';
  if (/\bAndroid\b/.test(ua)) return /\bMobile\b/.test(ua) ? 'Android' : 'Android Tablet';
  if (/\bCrOS\b/.test(ua)) return 'Chromebook';
  if (/\bWindows\b/.test(ua) || /^Win/.test(platform)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua) || /^Mac/.test(platform)) return 'Mac';
  if (/\bLinux\b/.test(ua) || /^Linux/.test(platform)) return 'Linux';
  return 'Device';
}

function detectBrowser(ua: string): string {
  // Order matters: every Chromium browser also claims "Chrome", and every
  // WebKit browser also claims "Safari", so the specific brands must be
  // tested before the generic ones they impersonate.
  if (/\bEdgA?\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bCriOS\//.test(ua)) return 'Chrome';
  if (/\bChrome\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua)) return 'Safari';
  return 'Browser';
}

/** In-memory fallbacks for environments where localStorage throws or is absent. */
let memoryClientId: string | null = null;
let memoryLabel: string | null = null;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota — the in-memory value still carries this session */
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  // Non-cryptographic fallback. This id is a coordination handle, never a
  // credential — it grants nothing on its own, so entropy quality is not a
  // security property here.
  return `dev-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Stable id for this browser profile / app install. Generated once, then persisted. */
export function getClientId(): string {
  if (memoryClientId) return memoryClientId;
  const stored = readStorage(CLIENT_ID_KEY);
  if (stored && stored.trim()) {
    memoryClientId = stored.trim();
    return memoryClientId;
  }
  memoryClientId = randomId();
  writeStorage(CLIENT_ID_KEY, memoryClientId);
  return memoryClientId;
}

/**
 * Display name for this device. A user-set name (via `setClientLabel`) wins;
 * otherwise it is derived from the current environment on every call so a
 * browser upgrade is reflected without clearing storage.
 */
export function getClientLabel(): string {
  const stored = readStorage(CLIENT_LABEL_KEY);
  if (stored && stored.trim()) return stored.trim().slice(0, MAX_LABEL_LENGTH);
  if (memoryLabel) return memoryLabel;

  const nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator;
  memoryLabel = deriveDeviceLabel({
    userAgent: nav?.userAgent ?? '',
    // `navigator.platform` is deprecated but still the most reliable OS hint on
    // the browsers that predate userAgentData; absent → the UA regexes carry it.
    platform: (nav as { platform?: string } | undefined)?.platform ?? '',
    isElectron: isElectronRuntime(),
  });
  return memoryLabel;
}

/** Rename this device. Empty string clears back to the derived label. */
export function setClientLabel(label: string): void {
  const trimmed = label.trim().slice(0, MAX_LABEL_LENGTH);
  memoryLabel = null;
  if (!trimmed) {
    try {
      localStorage.removeItem(CLIENT_LABEL_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  writeStorage(CLIENT_LABEL_KEY, trimmed);
}

/** True when running inside the Electron shell (preload bridge present). */
export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && !!(window as { electronAPI?: unknown }).electronAPI;
}

/** Test-only: forget the cached in-memory identity. */
export function _resetForTests(): void {
  memoryClientId = null;
  memoryLabel = null;
}
