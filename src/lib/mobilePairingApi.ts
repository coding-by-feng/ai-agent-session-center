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
}

export interface PhonePairing {
  code: string;
  expiresAt: number;
  link: string;
  backendIncluded: boolean;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function startPhonePairing(): Promise<PhonePairing> {
  const res = await fetch('/api/mobile/pairing', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
  const body = await readJson<{ data: PhonePairing }>(res, 'Could not start pairing');
  return body.data;
}

export async function listPairedPhones(signal?: AbortSignal): Promise<PairedPhone[]> {
  const res = await fetch('/api/mobile/devices', { signal });
  const body = await readJson<{ data: { devices: PairedPhone[] } }>(res, 'Could not load paired phones');
  return body.data.devices;
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

/** "ABCDEFGHJK" → "ABCDE-FGHJK", easier to read aloud or type. */
export function formatPairingCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

/** "123456" → "123 456". */
export function formatConfirmCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
