// mobilePairingApi.ts — the desktop's calls to /api/mobile (AASC-15).
//
// These routes answer only the AASC page on this machine (loopback, loopback
// Host, same-origin), so they are only ever called from the device panel when
// this device is local.
import { readJson } from '@/lib/requestJson';

export type PhonePlatform = 'ios' | 'android';
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
}

export interface PhonePairing {
  code: string;
  expiresAt: number;
  /** The QR: the Mac's code only. A phone gets its backend code once approved (AASC-52). */
  link: string;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function startPhonePairing(): Promise<PhonePairing> {
  const res = await fetch('/api/mobile/pairing', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
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
}

/** The paired phones, and whether new ones may be paired. */
export async function loadPhonePairing(signal?: AbortSignal): Promise<PhonePairingState> {
  const res = await fetch('/api/mobile/devices', { signal });
  const body = await readJson<{ data?: { devices?: unknown; pairingOffered?: unknown } }>(res, 'Could not load paired phones');
  const devices = Array.isArray(body.data?.devices) ? (body.data.devices as PairedPhone[]) : [];
  return { devices, pairingOffered: body.data?.pairingOffered === true };
}

export async function listPairedPhones(signal?: AbortSignal): Promise<PairedPhone[]> {
  return (await loadPhonePairing(signal)).devices;
}

export async function approvePhone(id: string): Promise<void> {
  const res = await fetch(`/api/mobile/devices/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: JSON_HEADERS });
  await readJson(res, 'Could not approve the phone');
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
