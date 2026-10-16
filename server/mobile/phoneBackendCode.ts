// phoneBackendCode.ts — a backend code for an approved phone, over its own Mac session (AASC-52).
//
// The pairing QR used to carry a phone-scoped backend code next to the Mac's
// code. Anyone who photographed it could redeem that half alone for ten minutes
// and get a push device the Mac never listed and could never revoke. Now the
// QR has the Mac code only, and a phone asks for its backend code here once it
// is paired, approved and signed in:
//
//   1. only an approved phone whose token is from the current dashboard password
//   2. only while the Mac has a cloud connection (else "no cloud": the phone
//      stays paired with the Mac only and asks again at its next sign-in)
//   3. one request per phone at a time; at most MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR
//      requests, whatever their answer, and MAX_BACKEND_CODES_PER_HOUR codes
//   4. one outstanding code per phone: while its last code may still be redeemed
//      (its expiry plus a margin), no second one is minted. The backend is looked
//      at once per code in that time (did someone redeem it?); after that the
//      ledger answers, so a looping phone costs no round trips
//   5. a phone asking again first loses the backend device its last code made,
//      so one phone never holds two. A phone whose redemption failed asks again at
//      once: a device someone else made from its code (a sniffer on the LAN's
//      plain HTTP) is revoked by that look
//   6. the new code's ref is bound to THIS phone before the answer, so revoking
//      the phone revokes the backend device the code creates (AASC-51)
//
// Every code minted is also written to the ledger: which phone it went to, when,
// and when it expires (the later of the backend's expiry and a full life counted
// from the mint's answer). The outstanding check and the revoke recheck read it,
// across restarts too, and the desktop's "not linked to a paired phone" count
// (cloudPhoneAudit.ts) knows which backend phone devices this Mac made. Nothing
// here logs a code or a ref.

import type { DeviceAuth } from './deviceAuth.js';
import { BACKEND_CODE_EXPIRY_MARGIN_MS, type PhoneCloudBridge } from './phoneCloudBridge.js';

export const MAX_BACKEND_CODES_PER_HOUR = 3;
/** Requests per phone an hour, answered or not: outstanding and cloud failures count too. */
export const MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const MAC_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every backend code this Mac minted for a phone (SQLite: mobile_backend_codes). */
export interface BackendCodeLedger {
  record(entry: { codeRef: string; deviceId: string; mintedAt: number; expiresAt: number }): void;
  /** When the code stops being redeemable (before the margin), or null when this Mac has no record of it. */
  expiresAt(codeRef: string): number | null;
  has(codeRef: string): boolean;
}

/** What the phone gets: where to redeem the code, the code, and the Mac's own backend device id. */
export interface IssuedBackendCode {
  host: string;
  code: string;
  macDeviceId: string | null;
}

export type BackendCodeOutcome =
  | { ok: true; code: IssuedBackendCode }
  | { ok: false; reason: 'unknown' | 'pending' | 'revoked' | 'no-cloud' | 'busy' | 'cloud-failed' }
  | { ok: false; reason: 'outstanding' | 'rate-limited'; retryAfter: number };

export interface PhoneBackendCodeDeps {
  deviceAuth: Pick<DeviceAuth, 'backendCodeHolder' | 'bindBackendCode'>;
  cloud: Pick<PhoneCloudBridge, 'cloudAvailable' | 'mintBackendCode' | 'retireBackendCode'>;
  ledger: BackendCodeLedger;
  now?: () => number;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const reason = (err: unknown): string => {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'error';
};

const seconds = (ms: number): number => Math.max(1, Math.ceil(ms / 1000));

/** The times within the last hour, or a refusal once `max` of them are in it. */
function windowed(times: readonly number[] | undefined, at: number, max: number): {
  recent: readonly number[];
  refusal: BackendCodeOutcome | null;
} {
  const recent = (times ?? []).filter((t) => t > at - HOUR_MS);
  const refusal: BackendCodeOutcome | null = recent.length >= max
    ? { ok: false, reason: 'rate-limited', retryAfter: seconds(recent[0] + HOUR_MS - at) }
    : null;
  return { recent, refusal };
}

export function createPhoneBackendCodes(deps: PhoneBackendCodeDeps) {
  const now = deps.now ?? Date.now;
  /** Request and mint times per phone within the last hour. In memory: the backend caps the Mac too. */
  const attempts = new Map<string, readonly number[]>();
  const minted = new Map<string, readonly number[]>();
  /** The live code each phone's backend look was spent on: one look per code until it is gone. */
  const looked = new Map<string, string>();
  const inFlight = new Set<string>();

  /** Wait for the last code, or lose its backend device first. Null: go ahead and mint. */
  async function retirePrevious(deviceId: string, codeRef: string, at: number): Promise<BackendCodeOutcome | null> {
    // Surely gone at the backend only a margin after its expiry: the two clocks may differ.
    const goneAt = (deps.ledger.expiresAt(codeRef) ?? 0) + BACKEND_CODE_EXPIRY_MARGIN_MS;
    const live = goneAt > at;
    const outstanding: BackendCodeOutcome = { ok: false, reason: 'outstanding', retryAfter: seconds(goneAt - at) };
    if (live && looked.get(deviceId) === codeRef) return outstanding;
    if (live) looked.set(deviceId, codeRef);
    let retired;
    try {
      retired = await deps.cloud.retireBackendCode(codeRef);
    } catch (err) {
      deps.warn?.(`A phone's new backend code waits: its last one couldn't be checked (${reason(err)})`);
      return { ok: false, reason: 'cloud-failed' };
    }
    return retired === 'unredeemed' && live ? outstanding : null;
  }

  async function mintFor(deviceId: string, previous: string | null, at: number): Promise<BackendCodeOutcome> {
    if (previous) {
      const blocked = await retirePrevious(deviceId, previous, at);
      if (blocked) return blocked;
    }
    const code = await deps.cloud.mintBackendCode();
    if (!code) return { ok: false, reason: 'cloud-failed' };
    deps.ledger.record({ codeRef: code.codeRef, deviceId, mintedAt: now(), expiresAt: code.expiresAt });
    minted.set(deviceId, [...(minted.get(deviceId) ?? []), at]);
    // Revoked while the backend answered: the code stays unbound and unused, and expires.
    if (!deps.deviceAuth.bindBackendCode(deviceId, code.codeRef)) return { ok: false, reason: 'revoked' };
    const macDeviceId = code.macDeviceId && MAC_DEVICE_ID.test(code.macDeviceId) ? code.macDeviceId : null;
    return { ok: true, code: { host: code.host, code: code.code, macDeviceId } };
  }

  return {
    /** A backend code for this phone, or why not. Never throws. */
    async issue(deviceId: string): Promise<BackendCodeOutcome> {
      const holder = deps.deviceAuth.backendCodeHolder(deviceId);
      if (!holder.ok) return holder;
      if (!deps.cloud.cloudAvailable()) return { ok: false, reason: 'no-cloud' };
      if (inFlight.has(deviceId)) return { ok: false, reason: 'busy' };
      const at = now();
      // Every request that may reach the backend counts, whatever its answer; a refused one doesn't.
      const tries = windowed(attempts.get(deviceId), at, MAX_BACKEND_CODE_ATTEMPTS_PER_HOUR);
      attempts.set(deviceId, tries.refusal ? tries.recent : [...tries.recent, at]);
      if (tries.refusal) return tries.refusal;
      const codes = windowed(minted.get(deviceId), at, MAX_BACKEND_CODES_PER_HOUR);
      minted.set(deviceId, codes.recent);
      if (codes.refusal) return codes.refusal;
      const { device } = holder;
      inFlight.add(deviceId);
      try {
        const out = await mintFor(deviceId, device.beCodeRefMacBound ? device.beCodeRef : null, at);
        if (out.ok) deps.info?.(`Backend code issued to a paired phone: ${device.label} (${device.platform})`);
        return out;
      } catch (err) {
        deps.warn?.(`No backend code for a paired phone (${reason(err)})`);
        return { ok: false, reason: 'cloud-failed' };
      } finally {
        inFlight.delete(deviceId);
      }
    },
  };
}

export type PhoneBackendCodes = ReturnType<typeof createPhoneBackendCodes>;
