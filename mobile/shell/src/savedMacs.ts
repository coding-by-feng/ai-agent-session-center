// savedMacs.ts — the Macs this phone is paired with (AASC-17).
//
// Two halves, kept apart on purpose:
//   - Preferences (KeyValueStore): names, addresses, port, path choice, status.
//     Nothing secret. Built-in plugins have no origin check, so a page with the
//     bridge could rewrite this list: every entry is validated on load, and
//     connectionPlan only ever builds private or tailnet addresses from it.
//   - DeviceVault: the Mac device token and the backend token, per Mac.
import { candidates, type PairedServer, type PathKind } from './connectionPlan.js';
import type { MacCredentials } from './pairingClient.js';
import { isPrivateLanAddress, isTailnetAddress } from './pairingLink.js';
import type { BackendCredential, KeyValueStore } from './pushRegistration.js';
import type { DeviceVault } from './native.js';
import { cleanLabel } from './text.js';

export const MACS_KEY = 'aasc.macs.v1';
export const LAST_MAC_KEY = 'aasc.lastMac';
/** More than anyone pairs; bounds the work on a tampered list. */
const MAX_MACS = 20;
const NAME_MAX = 80;

export type MacStatus = 'pending' | 'active';

export interface SavedMac extends PairedServer {
  status: MacStatus;
  /** Only while pending: the 6-digit code to compare with the Mac's. Not secret on its own. */
  confirmCode: string | null;
  /** How this phone is named on that Mac. */
  phoneName: string;
  /** The path that answered last, for the list. */
  lastPath: PathKind | null;
}

const ID = /^[A-Za-z0-9-]{8,64}$/;
const MAC_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CONFIRM_CODE = /^\d{6}$/;

function address(raw: unknown, valid: (a: string) => boolean): string | null {
  return typeof raw === 'string' && valid(raw) ? raw : null;
}

/** One stored entry, or null when anything about it is off. */
export function parseSavedMac(raw: unknown): SavedMac | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const name = cleanLabel(m.name, NAME_MAX);
  const port = m.port;
  const lan = address(m.lan, isPrivateLanAddress);
  const tailnet = address(m.tailnet, isTailnetAddress);
  if (typeof m.id !== 'string' || !ID.test(m.id) || !name) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if ((m.lan != null && !lan) || (m.tailnet != null && !tailnet) || (!lan && !tailnet)) return null;
  if (m.status !== 'pending' && m.status !== 'active') return null;
  return {
    id: m.id,
    name,
    port,
    lan,
    tailnet,
    lanAllowed: m.lanAllowed === true,
    backendDeviceId: typeof m.backendDeviceId === 'string' && MAC_DEVICE_ID.test(m.backendDeviceId) ? m.backendDeviceId : null,
    status: m.status,
    confirmCode: m.status === 'pending' && typeof m.confirmCode === 'string' && CONFIRM_CODE.test(m.confirmCode) ? m.confirmCode : null,
    phoneName: cleanLabel(m.phoneName, NAME_MAX),
    lastPath: m.lastPath === 'lan' || m.lastPath === 'tailnet' ? m.lastPath : null,
  };
}

export async function loadMacs(store: KeyValueStore): Promise<SavedMac[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await store.get(MACS_KEY)) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SavedMac[] = [];
  for (const raw of parsed.slice(0, MAX_MACS)) {
    const mac = parseSavedMac(raw);
    if (mac && !out.some((m) => m.id === mac.id)) out.push(mac);
  }
  return out;
}

export async function saveMacs(store: KeyValueStore, macs: readonly SavedMac[]): Promise<void> {
  await store.set(MACS_KEY, JSON.stringify(macs.slice(0, MAX_MACS)));
}

/** The list with `mac` added or replaced (by id). */
export function withMac(macs: readonly SavedMac[], mac: SavedMac): SavedMac[] {
  return macs.some((m) => m.id === mac.id) ? macs.map((m) => (m.id === mac.id ? mac : m)) : [...macs, mac];
}

export function withoutMac(macs: readonly SavedMac[], id: string): SavedMac[] {
  return macs.filter((m) => m.id !== id);
}

/** Every plain-HTTP origin the WebView may load: the paths of every paired Mac. */
export function allowedOrigins(macs: readonly SavedMac[]): string[] {
  return [...new Set(macs.flatMap((m) => candidates(m).map((c) => c.origin)))];
}

// ── Vault ────────────────────────────────────────────────────────────────

const macKey = (id: string) => `mac.${id}`;
const backendKey = (id: string) => `backend.${id}`;

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function readMacCredentials(vault: DeviceVault, id: string): Promise<MacCredentials | null> {
  const v = parseJson(await vault.get(macKey(id)));
  return v && typeof v.deviceId === 'string' && typeof v.deviceToken === 'string'
    ? { deviceId: v.deviceId, deviceToken: v.deviceToken }
    : null;
}

export async function writeMacCredentials(vault: DeviceVault, id: string, creds: MacCredentials): Promise<void> {
  await vault.set(macKey(id), JSON.stringify({ deviceId: creds.deviceId, deviceToken: creds.deviceToken }));
}

export async function readBackendCredential(vault: DeviceVault, id: string): Promise<BackendCredential | null> {
  const v = parseJson(await vault.get(backendKey(id)));
  return v && typeof v.host === 'string' && typeof v.deviceId === 'string' && typeof v.token === 'string'
    ? { host: v.host, deviceId: v.deviceId, token: v.token }
    : null;
}

export async function writeBackendCredential(vault: DeviceVault, id: string, cred: BackendCredential): Promise<void> {
  await vault.set(backendKey(id), JSON.stringify({ host: cred.host, deviceId: cred.deviceId, token: cred.token }));
}

/** Forget both tokens of a Mac. Each removal is tried even when the other fails. */
export async function forgetCredentials(vault: DeviceVault, id: string): Promise<void> {
  await Promise.allSettled([vault.delete(macKey(id)), vault.delete(backendKey(id))]);
}
