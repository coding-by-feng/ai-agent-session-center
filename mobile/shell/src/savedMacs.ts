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
/** `<macId> <origin>`: rows whose key the Mac at that origin doesn't know (shellFlows releasedTwins); not proved there again. */
export const UNKNOWN_TWINS_KEY = 'aasc.unknownTwins.v1';
const MAX_UNKNOWN_TWINS = 32;
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

/** Only ever used to skip a probe, so a rewritten value can do no more than leave a duplicate row. */
export async function loadUnknownTwins(store: KeyValueStore): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse((await store.get(UNKNOWN_TWINS_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(-MAX_UNKNOWN_TWINS) : [];
  } catch {
    return [];
  }
}

export async function saveUnknownTwins(store: KeyValueStore, pairs: readonly string[]): Promise<void> {
  await store.set(UNKNOWN_TWINS_KEY, JSON.stringify(pairs.slice(-MAX_UNKNOWN_TWINS)));
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

/** Forget a Mac's backend token only: the backend revoked it, and the next sign-in asks that Mac for a new one. */
export async function forgetBackendCredential(vault: DeviceVault, id: string): Promise<void> {
  await vault.delete(backendKey(id));
}

/** Forget both tokens of a Mac. Each removal is tried even when the other fails. */
export async function forgetCredentials(vault: DeviceVault, id: string): Promise<void> {
  await Promise.allSettled([vault.delete(macKey(id)), vault.delete(backendKey(id))]);
}

// ── Backend relink (AASC-60) ─────────────────────────────────────────────

/**
 * Preferences, per Mac: must the next sign-in replace its backend token, and when did a relink last finish? A 403 from
 * GET /v1/mac-paths means the token was made without `mac-paths:read` (the backend refused that scope when the Mac
 * issued the code, so the code was push-only); the Mac is marked, and its next sign-in asks for a new code
 * (backendLink `relink`). Nothing here is secret, and a rewritten value can do no more than cause or skip one relink.
 */
export const BACKEND_RELINK_KEY = 'aasc.backendRelink.v1';
/**
 * A Mac relinked within this long is not marked again. One whose backend keeps refusing the scope gets a push-only
 * code at every relink, which the cloud refuses again; each relink revokes and re-creates a backend device, so
 * without this it would happen at every sign-in. The price: a phone that lacks the scope waits up to this long for the
 * next automatic relink.
 */
export const RELINK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** More than anyone pairs (MAX_MACS); bounds a tampered list. */
const MAX_RELINKS = 32;

interface RelinkEntry {
  id: string;
  /** The next sign-in replaces this Mac's backend token. */
  marked: boolean;
  /** When a relink last finished for it, if one has. */
  relinkedAt: number | null;
}

/** Inside the cooldown? A time after `now` is a clock set back: it holds nothing off. */
function coolingDown(entry: RelinkEntry | undefined, now: number): boolean {
  return entry?.relinkedAt != null && entry.relinkedAt <= now && now - entry.relinkedAt < RELINK_COOLDOWN_MS;
}

/** The stored entries that make sense; a missing, unreadable or tampered value is no entries. */
async function loadRelinks(store: KeyValueStore): Promise<RelinkEntry[]> {
  try {
    const parsed: unknown = JSON.parse((await store.get(BACKEND_RELINK_KEY)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_RELINKS).flatMap((raw): RelinkEntry[] => {
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e.id !== 'string' || !ID.test(e.id) || typeof e.marked !== 'boolean') return [];
      const at = e.relinkedAt;
      return [{ id: e.id, marked: e.marked, relinkedAt: typeof at === 'number' && Number.isFinite(at) ? at : null }];
    });
  } catch {
    return [];
  }
}

/** `entry` stored last (the newest survives the cap), without the cooldowns that have ended. */
async function saveRelink(store: KeyValueStore, entries: readonly RelinkEntry[], entry: RelinkEntry, now: number): Promise<void> {
  const kept = [...entries.filter((e) => e.id !== entry.id && (e.marked || coolingDown(e, now))), entry];
  await store.set(BACKEND_RELINK_KEY, JSON.stringify(kept.slice(-MAX_RELINKS)));
}

/** A 403 for this Mac's backend token: replace it at the next sign-in, unless a relink only just finished (RELINK_COOLDOWN_MS). */
export async function markBackendRelink(store: KeyValueStore, macId: string, now: number = Date.now()): Promise<void> {
  const entries = await loadRelinks(store);
  const entry = entries.find((e) => e.id === macId);
  if (entry?.marked || coolingDown(entry, now)) return;
  await saveRelink(store, entries, { id: macId, marked: true, relinkedAt: null }, now);
}

export async function needsBackendRelink(store: KeyValueStore, macId: string): Promise<boolean> {
  return (await loadRelinks(store)).some((e) => e.id === macId && e.marked);
}

/**
 * A new backend token is in the vault: the Mac is no longer marked, and starts its cooldown. Only a Mac that was
 * marked does: a link nobody asked to redo (the first one, or one after a 401) starts none, so a phone linked push-only
 * before the backend was upgraded can still relink as soon as the cloud says so.
 */
export async function clearBackendRelink(store: KeyValueStore, macId: string, now: number = Date.now()): Promise<void> {
  const entries = await loadRelinks(store);
  if (!entries.some((e) => e.id === macId && e.marked)) return;
  await saveRelink(store, entries, { id: macId, marked: false, relinkedAt: now }, now);
}

/** The Mac was removed from this phone: its mark and its cooldown go with it, so a record never outlives the Mac it is about. */
export async function forgetBackendRelink(store: KeyValueStore, macId: string): Promise<void> {
  const entries = await loadRelinks(store);
  if (!entries.some((e) => e.id === macId)) return;
  await store.set(BACKEND_RELINK_KEY, JSON.stringify(entries.filter((e) => e.id !== macId)));
}
