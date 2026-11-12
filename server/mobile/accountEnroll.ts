// accountEnroll.ts — a phone signed into this Mac's AASC Cloud account connects without a QR (plan 17).
//
// The phone asked the backend for a 60 s single-use enroll ticket bound to (account, phone, THIS Mac, the
// phone's ephemeral P-256 public key) and sends it here with that key (POST /api/mobile/enroll). In order, each
// step stopping the rest:
//   1. no cloud connection, or it is not the ticket's Mac      → 'not-this-mac' (no backend call; the phone
//                                                                 tries its next address with the same ticket)
//   2. phone pairing or the setting `phoneAccountEnroll` off   → 'off'
//   3. MAX_PROVISIONAL_ACCOUNT_ROWS phones already wait for their first sign-in → 'busy' (review L2)
//   4. hooks.beforeRedeem (the route records a login strike here, cleared on success: review M4)
//   5. the backend redeems the ticket, authenticated as this Mac → its refusals pass through
//   6. a phone the owner removed on purpose (deny list, review H1) → 'phone-revoked'
//   7. the phone's key must hash to the ticket's key hash         → else 'invalid' (a relay swapped keys)
//   8. an ACTIVE record named by the backend's phone name, provisional until its first sign-in
//      (deviceAuth.enrollActive): the account vouched for the phone, no Allow click
//   9. the token is sealed to the phone's key, with the address this request reached in the AEAD's associated
//      data, so the phone accepts only an answer from the Mac it dialled itself (the cloud never vouches for
//      an address) and the token never crosses the network in clear.
//
// The seal (the phone mirrors it with WebCrypto; test/accountEnroll.test.ts decrypts it that way):
//   macKey, macPriv = ephemeral P-256;  shared = ECDH(macPriv, phoneKey) (32-byte x-coordinate)
//   key  = HKDF-SHA256(ikm  = shared ‖ sealSecret (32 bytes, from the redeem answer; review C1),
//                      salt = utf8(nonce),
//                      info = utf8('aasc-enroll-v1') ‖ phoneKeyRaw (65) ‖ macKeyRaw (65), 32 bytes)
//   iv   = 12 random bytes;  AES-256-GCM over utf8(JSON.stringify({ deviceId, deviceToken }))
//   aad  = utf8('aasc-enroll-v1:' + nonce + ':' + reachedAt)
//   answer { macKey: b64u(65-byte point), iv: b64u(12), sealed: b64u(ciphertext ‖ 16-byte tag) }
// Without the sealSecret, which reaches only the phone and the named Mac over TLS, a box on the LAN that saw the
// phone's public key could seal a token of its own to it.
//
// Nothing here logs a ticket, key, nonce, secret, token or email (review L3).

import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import { EnrollRedeemError, type EnrollRedeemReason, type RedeemedEnrollTicket } from '../cloud/enroll.js';
import {
  MAX_PROVISIONAL_ACCOUNT_ROWS, TooManyProvisionalPhonesError, toView, type DeviceAuth, type MobileDeviceView,
} from './deviceAuth.js';
import type { AccountDenyList } from './accountPhoneRevocation.js';

export const ENROLL_SEAL_INFO = 'aasc-enroll-v1';

export interface AccountEnrollInput {
  macDeviceId: string;
  ticket: string;
  /** The phone's ephemeral public key: a 65-byte uncompressed P-256 point, base64url. */
  phoneKey: string;
  /** 64 hex characters the phone chose. */
  nonce: string;
  /** Accepted from older shells and ignored: the record is named by the backend's phone name (review M3). */
  label?: string;
  platform: 'ios' | 'android';
  /** This Mac's own `address:port` on the request's socket (mobileRouter reachedAt), never the phone's say. */
  reachedAt: string;
}

export interface EnrollAnswer {
  macKey: string;
  iv: string;
  sealed: string;
}

export type AccountEnrollRefusal = 'off' | 'not-this-mac' | 'busy' | EnrollRedeemReason;

export type AccountEnrollOutcome =
  | { ok: true; answer: EnrollAnswer; device: MobileDeviceView }
  | { ok: false; reason: AccountEnrollRefusal };

/**
 * Why the desktop's switch can't be used, or null when it can. 'no-cloud' wins over the others: the desktop hides
 * all account UI then (sign-in stays optional); 'pairing-off' and 'no-password' grey the switch out with the reason.
 */
export type AccountEnrollBlock = 'pairing-off' | 'no-password' | 'no-cloud';

/** What the desktop's switch shows (GET /api/mobile/devices). */
export interface AccountEnrollStatus {
  /** In force: phone pairing offered AND the setting on (review M1). */
  enabled: boolean;
  /** Could a phone enroll now: in an AASC Cloud account with a usable connection, and a dashboard password set. */
  available: boolean;
  email: string | null;
  blocked: AccountEnrollBlock | null;
}

/** Just what this needs of the cloud connector's status (CloudStatus). */
export interface AccountEnrollCloudStatus {
  connection: { deviceId: string; accountEmail?: string } | null;
  state: 'disconnected' | 'connected' | 'offline' | 'revoked';
}

export interface AccountEnrollDeps {
  /** The `phoneAccountEnroll` setting (accountEnrollSetting.ts). */
  enabled: () => boolean;
  /** Is phone pairing offered at all (pairingOffer.ts)? Off turns account enroll off too. Omitted: offered. */
  pairingOffered?: () => boolean;
  /** Is a dashboard password set? Without one every phone route is refused. Omitted: set. */
  passwordEnabled?: () => boolean;
  /** This Mac's cloud connection; null when there is no connector at all. */
  cloudStatus: () => AccountEnrollCloudStatus | null;
  /** Redeem the ticket at the backend as this Mac (cloud/enroll.ts); throws EnrollRedeemError. */
  redeem: (ticket: string) => Promise<RedeemedEnrollTicket>;
  deviceAuth: Pick<DeviceAuth, 'enrollActive' | 'provisionalAccountCount'>;
  /** Phones the owner removed on purpose (accountPhoneRevocation.ts). Omitted: none. */
  denyList?: Pick<AccountDenyList, 'has'>;
  info?: (message: string) => void;
}

export interface AccountEnrollHooks {
  /** Called once the local checks pass, just before the backend is asked: the route's login strike. */
  beforeRedeem?: () => void;
}

const sha256hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Everything about the seal that can fail, done before any record exists: a fresh Mac key, ECDH with the phone's
 * key and the HKDF. Null for a phone key that is no P-256 point.
 */
function prepareSeal(phoneKey: Buffer, sealSecret: Buffer, nonce: string): { macKey: Buffer; key: Buffer } | null {
  const ecdh = createECDH('prime256v1');
  const macKey = ecdh.generateKeys(); // uncompressed, 65 bytes
  let shared: Buffer;
  try {
    shared = ecdh.computeSecret(phoneKey);
  } catch {
    return null;
  }
  const ikm = Buffer.concat([shared, sealSecret]);
  const info = Buffer.concat([Buffer.from(ENROLL_SEAL_INFO, 'utf8'), phoneKey, macKey]);
  const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(nonce, 'utf8'), info, 32));
  return { macKey, key };
}

function seal(prepared: { macKey: Buffer; key: Buffer }, nonce: string, reachedAt: string, plaintext: string): EnrollAnswer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', prepared.key, iv);
  cipher.setAAD(Buffer.from(`${ENROLL_SEAL_INFO}:${nonce}:${reachedAt}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    macKey: prepared.macKey.toString('base64url'),
    iv: iv.toString('base64url'),
    sealed: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64url'),
  };
}

export function createAccountEnroll(deps: AccountEnrollDeps) {
  const pairingOffered = (): boolean => deps.pairingOffered?.() ?? true;
  const passwordEnabled = (): boolean => deps.passwordEnabled?.() ?? true;
  const inForce = (): boolean => pairingOffered() && deps.enabled();

  return {
    async enroll(input: AccountEnrollInput, hooks: AccountEnrollHooks = {}): Promise<AccountEnrollOutcome> {
      // NOT_THIS_MAC first (review): the phone moves on to its next address, whatever this Mac's settings say.
      const connection = deps.cloudStatus()?.connection ?? null;
      if (!connection || connection.deviceId !== input.macDeviceId) return { ok: false, reason: 'not-this-mac' };
      if (!inForce()) return { ok: false, reason: 'off' };
      if (deps.deviceAuth.provisionalAccountCount() >= MAX_PROVISIONAL_ACCOUNT_ROWS) return { ok: false, reason: 'busy' };

      hooks.beforeRedeem?.();
      let redeemed: RedeemedEnrollTicket;
      try {
        redeemed = await deps.redeem(input.ticket);
      } catch (error) {
        return { ok: false, reason: error instanceof EnrollRedeemError ? error.reason : 'cloud-failed' };
      }
      if (deps.denyList?.has(redeemed.phoneDeviceId)) return { ok: false, reason: 'phone-revoked' };

      const phoneKey = Buffer.from(input.phoneKey, 'base64url');
      if (!sameHex(sha256hex(phoneKey), redeemed.phoneKeyHash)) return { ok: false, reason: 'invalid' };
      const prepared = prepareSeal(phoneKey, Buffer.from(redeemed.sealSecret, 'base64url'), input.nonce);
      if (!prepared) return { ok: false, reason: 'invalid' };

      let enrolled: ReturnType<DeviceAuth['enrollActive']>;
      try {
        enrolled = deps.deviceAuth.enrollActive({
          label: redeemed.phoneName,
          platform: input.platform,
          accountEmail: redeemed.email,
          accountPhoneId: redeemed.phoneDeviceId,
        });
      } catch (error) {
        if (error instanceof TooManyProvisionalPhonesError) return { ok: false, reason: 'busy' };
        throw error;
      }
      const { device, deviceToken } = enrolled;
      const answer = seal(prepared, input.nonce, input.reachedAt, JSON.stringify({ deviceId: device.id, deviceToken }));
      deps.info?.(`Phone paired via account: ${device.label} (${device.platform})`);
      return { ok: true, answer, device: toView(device) };
    },

    status(): AccountEnrollStatus {
      const cloud = deps.cloudStatus();
      const connection = cloud?.connection ?? null;
      const cloudUsable = connection !== null && cloud?.state !== 'revoked' && cloud?.state !== 'disconnected';
      // no-cloud first: AASC Cloud stays optional, and the desktop shows no account UI at all for a Mac that
      // isn't signed in, whatever else is off. The other reasons are for a signed-in owner.
      const blocked: AccountEnrollBlock | null = !cloudUsable
        ? 'no-cloud'
        : !pairingOffered() ? 'pairing-off' : !passwordEnabled() ? 'no-password' : null;
      return {
        enabled: inForce(),
        available: cloudUsable && passwordEnabled(),
        email: connection?.accountEmail ?? null,
        blocked,
      };
    },
  };
}

export type AccountEnroll = ReturnType<typeof createAccountEnroll>;
