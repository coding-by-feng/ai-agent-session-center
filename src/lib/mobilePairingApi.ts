// mobilePairingApi.ts — the desktop's calls to /api/mobile (AASC-15).
//
// These routes answer only the AASC page on this machine (loopback, loopback
// Host, same-origin), so they are only ever called from the device panel when
// this device is local.
import { readJson } from '@/lib/requestJson';

/** `desktop`: another computer's AASC paired as a remote (Oct 28 2026), not a phone. */
export type PhonePlatform = 'ios' | 'android' | 'desktop';
export type PhoneStatus = 'pending' | 'active' | 'revoked';

export interface PairedPhone {
  id: string;
  label: string;
  platform: PhonePlatform;
  status: PhoneStatus;
  /** Only while pending: the code the phone shows too. */
  confirmCode: string | null;
  createdAt: number;
  approvedAt: number | null;
  lastSeenAt: number | null;
  /** What the phone may do on this Mac. `sessions-only` is the one set today (AASC-28). */
  access?: 'sessions-only';
  /** Has an open socket right now (Oct 22 2026); absent from older servers. */
  online?: boolean;
  /** How it was paired (plan 17): a code + Allow, or through this Mac's AASC Cloud account. Absent: code. */
  origin?: 'code' | 'account';
  /** The AASC Cloud account an `account` device enrolled through. */
  accountEmail?: string | null;
}

/** Why the account switch is greyed out: phone pairing off, no dashboard password, or no usable AASC Cloud. */
export type AccountEnrollBlock = 'pairing-off' | 'no-password' | 'no-cloud';
const ACCOUNT_ENROLL_BLOCKS: readonly AccountEnrollBlock[] = ['pairing-off', 'no-password', 'no-cloud'];

/**
 * "Let phones signed into my AASC Cloud account connect" (plan 17). `enabled`: in force (phone pairing on and
 * the setting on). `available`: this Mac is in an AASC Cloud account with a usable connection and has a
 * dashboard password. `blocked`: why the switch can't be used, or null.
 */
export interface AccountEnrollState {
  enabled: boolean;
  available: boolean;
  email: string | null;
  blocked: AccountEnrollBlock | null;
}

/** The server's answer as an AccountEnrollState, or null when it says nothing usable (an older server). */
export function readAccountEnroll(v: unknown): AccountEnrollState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean' || typeof o.available !== 'boolean') return null;
  const named = ACCOUNT_ENROLL_BLOCKS.find((b) => b === o.blocked) ?? null;
  return {
    enabled: o.enabled,
    available: o.available,
    email: typeof o.email === 'string' && o.email !== '' ? o.email : null,
    // A server from before `blocked` only knew one reason.
    blocked: named ?? (o.available ? null : 'no-cloud'),
  };
}

export interface PhonePairing {
  code: string;
  expiresAt: number;
  /** The QR: the Mac's code only. A phone gets its backend code once approved (AASC-52). */
  link: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The addresses a pairing link can carry (Oct 28 2026), in the order the link names them. */
export type PairingAddressKind = 'lan' | 'tailnet' | 'public';
export const PAIRING_ADDRESS_KINDS: readonly PairingAddressKind[] = ['lan', 'tailnet', 'public'];
export type PairingAddresses = Record<PairingAddressKind, string | null>;

/** This computer's addresses for the link choices, or null from a server that can't say (older, or failed). */
export async function loadPairingAddresses(signal?: AbortSignal): Promise<PairingAddresses | null> {
  try {
    const res = await fetch('/api/mobile/pairing/addresses', { signal });
    if (!res.ok) return null;
    const data = ((await res.json()) as { data?: Partial<Record<PairingAddressKind, unknown>> }).data;
    if (!data) return null;
    const read = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    return { lan: read(data.lan), tailnet: read(data.tailnet), public: read(data.public) };
  } catch {
    return null;
  }
}

/** Without `include` the server makes its usual link: home network and Tailscale. */
export async function startPhonePairing(include?: readonly PairingAddressKind[]): Promise<PhonePairing> {
  const request = JSON.stringify(include ? { include } : {});
  const res = await fetch('/api/mobile/pairing', { method: 'POST', headers: JSON_HEADERS, body: request });
  const body = await readJson<{ data: PhonePairing }>(res, 'Could not start pairing');
  return body.data;
}

export interface PhonePairingState {
  devices: PairedPhone[];
  /**
   * Does this Mac offer "Pair a phone" (AASC-30)? Off until the phone app
   * ships; a server that doesn't say counts as off.
   */
  pairingOffered: boolean;
  /** The account switch (plan 17); null from a server without it. */
  accountEnroll: AccountEnrollState | null;
}

/** The paired phones, whether new ones may be paired, and the account switch. */
export async function loadPhonePairing(signal?: AbortSignal): Promise<PhonePairingState> {
  const res = await fetch('/api/mobile/devices', { signal });
  const body = await readJson<{ data?: { devices?: unknown; pairingOffered?: unknown; accountEnroll?: unknown } }>(
    res, 'Could not load paired phones');
  const devices = Array.isArray(body.data?.devices) ? (body.data.devices as PairedPhone[]) : [];
  return { devices, pairingOffered: body.data?.pairingOffered === true, accountEnroll: readAccountEnroll(body.data?.accountEnroll) };
}

/** Turn the account switch on or off; answers the new state. */
export async function setAccountEnroll(enabled: boolean): Promise<AccountEnrollState> {
  const res = await fetch('/api/mobile/pairing/account-enroll', {
    method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ enabled }),
  });
  const body = await readJson<{ data?: { accountEnroll?: unknown } }>(res, 'Could not change the setting');
  const state = readAccountEnroll(body.data?.accountEnroll);
  if (!state) throw new Error('Could not change the setting');
  return state;
}

export async function listPairedPhones(signal?: AbortSignal): Promise<PairedPhone[]> {
  return (await loadPhonePairing(signal)).devices;
}

export interface ApproveResult {
  /** Older pairings of the same phone revoked with this Allow (Nov 6 2026). */
  replaced: string[];
  /** Named but kept: the server found them not the same phone (or gone already). */
  skipped: string[];
}

/** Allow a pending phone; `replaces` names older pairings of the same phone to revoke once it is in. */
export async function approvePhone(id: string, replaces: readonly string[] = []): Promise<ApproveResult> {
  const res = await fetch(`/api/mobile/devices/${encodeURIComponent(id)}/approve`, {
    method: 'POST', headers: JSON_HEADERS, ...(replaces.length ? { body: JSON.stringify({ replaces }) } : {}),
  });
  const body = await readJson<{ data?: { replaced?: unknown; skipped?: unknown } }>(res, 'Could not approve the phone');
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { replaced: ids(body.data?.replaced), skipped: ids(body.data?.skipped) };
}

/** Deny a pending phone or revoke an approved one. */
export async function removePhone(id: string): Promise<void> {
  const res = await fetch(`/api/mobile/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await readJson(res, 'Could not remove the phone');
}

/** Give a paired phone a new name (1–80 characters; the server cleans it). */
export async function renamePhone(id: string, label: string): Promise<void> {
  const res = await fetch(`/api/mobile/devices/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ label }),
  });
  await readJson(res, 'Could not rename the phone');
}

/** End an approved phone's sessions without unpairing it: it signs in again from the app. */
export async function signOutPhone(id: string): Promise<void> {
  const res = await fetch(`/api/mobile/devices/${encodeURIComponent(id)}/sign-out`, { method: 'POST', headers: JSON_HEADERS });
  await readJson(res, 'Could not sign the phone out');
}

/**
 * Backend phone devices this Mac made that no paired phone holds (AASC-52).
 * `cloud: false`: no cloud connection, nothing to say.
 */
export type CloudPhones = { cloud: false } | { cloud: true; unlinked: number };

export async function loadCloudPhones(signal?: AbortSignal): Promise<CloudPhones> {
  const res = await fetch('/api/mobile/cloud-phones', { signal });
  const body = await readJson<{ data?: { cloud?: unknown; unlinked?: unknown } }>(res, 'Could not check cloud phone devices');
  const unlinked = body.data?.unlinked;
  return body.data?.cloud === true && typeof unlinked === 'number' && Number.isInteger(unlinked) && unlinked >= 0
    ? { cloud: true, unlinked }
    : { cloud: false };
}

/** Revoke them on the backend. Never this Mac's own device or a phone paired here. */
export async function removeUnlinkedCloudPhones(): Promise<{ removed: number; failed: number }> {
  const res = await fetch('/api/mobile/cloud-phones/remove-unlinked', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  const body = await readJson<{ data?: { removed?: unknown; failed?: unknown } }>(res, 'Could not remove the cloud phone devices');
  const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
  return { removed: count(body.data?.removed), failed: count(body.data?.failed) };
}

/** "ABCDEFGHJK" → "ABCDE-FGHJK", easier to read aloud or type. */
export function formatPairingCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** "123456" → "123 456". */
export function formatConfirmCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
