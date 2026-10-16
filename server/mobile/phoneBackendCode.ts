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
//   3. one request per phone at a time, at most MAX_BACKEND_CODES_PER_HOUR codes
//   4. one outstanding code per phone: while its last code is unused and still
//      valid (its life plus a margin), no second one is minted
//   5. a phone asking again first loses the backend device its last code made,
//      so one phone never holds two
//   6. the new code's ref is bound to THIS phone before the answer, so revoking
//      the phone revokes the backend device the code creates (AASC-51)
//
// Every code minted is also written to the ledger: which phone it went to and
// when. The outstanding check reads it after a restart, and the desktop's
// "not linked to a paired phone" count (cloudPhoneAudit.ts) knows which backend
// phone devices this Mac made. Nothing here logs a code or a ref.

import type { DeviceAuth } from './deviceAuth.js';
import { BACKEND_CODE_EXPIRY_MARGIN_MS, BACKEND_CODE_TTL_SECONDS, type PhoneCloudBridge } from './phoneCloudBridge.js';

export const MAX_BACKEND_CODES_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
const MAC_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Every backend code this Mac minted for a phone (SQLite: mobile_backend_codes). */
export interface BackendCodeLedger {
  record(entry: { codeRef: string; deviceId: string; mintedAt: number }): void;
  /** When this Mac minted the code, or null when it has no record of it. */
  mintedAt(codeRef: string): number | null;
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

export function createPhoneBackendCodes(deps: PhoneBackendCodeDeps) {
  const now = deps.now ?? Date.now;
  /** Mint times per phone within the last hour. In memory: the backend caps the Mac too. */
  const minted = new Map<string, readonly number[]>();
  const inFlight = new Set<string>();

  /** Wait for the last code, or lose its backend device first. Null: go ahead and mint. */
  async function retirePrevious(codeRef: string, at: number): Promise<BackendCodeOutcome | null> {
    let retired;
    try {
      retired = await deps.cloud.retireBackendCode(codeRef);
    } catch (err) {
      deps.warn?.(`A phone's new backend code waits: its last one couldn't be checked (${reason(err)})`);
      return { ok: false, reason: 'cloud-failed' };
    }
    if (retired !== 'unredeemed') return null;
    // Surely gone at the backend only a margin after its life: the two clocks may differ.
    const goneAt = (deps.ledger.mintedAt(codeRef) ?? 0) + BACKEND_CODE_TTL_SECONDS * 1000 + BACKEND_CODE_EXPIRY_MARGIN_MS;
    return goneAt > at ? { ok: false, reason: 'outstanding', retryAfter: seconds(goneAt - at) } : null;
  }

  async function mintFor(deviceId: string, previous: string | null, at: number): Promise<BackendCodeOutcome> {
    if (previous) {
      const blocked = await retirePrevious(previous, at);
      if (blocked) return blocked;
    }
    const code = await deps.cloud.mintBackendCode();
    if (!code) return { ok: false, reason: 'cloud-failed' };
    deps.ledger.record({ codeRef: code.codeRef, deviceId, mintedAt: at });
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
      const recent = (minted.get(deviceId) ?? []).filter((t) => t > at - HOUR_MS);
      minted.set(deviceId, recent);
      if (recent.length >= MAX_BACKEND_CODES_PER_HOUR) {
        return { ok: false, reason: 'rate-limited', retryAfter: seconds(recent[0] + HOUR_MS - at) };
      }
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
