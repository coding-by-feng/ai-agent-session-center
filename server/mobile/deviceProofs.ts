// deviceProofs.ts — the keyed proofs a paired device and this Mac trade (split out of deviceAuth.ts, Nov 2026).
//
// After pairing a device's token never travels again: each side proves it holds the key with an HMAC-SHA256
// keyed with the SHA-256 of that token, over a message with its own prefix, so no proof for one question is
// ever an answer to another. Pure functions: deviceAuth.ts decides which record a proof is for, these compute
// it. deviceAuth.ts re-exports them, so its importers did not change.

import { createHash, createHmac, timingSafeEqual } from 'crypto';

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The phone's answer to a challenge: HMAC-SHA256 keyed with the SHA-256 of its
 * device token, over the nonce, hex. The server keys with the stored hash, so
 * it never needs the token. (The phone computes the same with WebCrypto.)
 */
export function challengeProof(tokenHashHex: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(tokenHashHex, 'hex')).update(nonce).digest('hex');
}

/** Convenience for callers that hold the token itself (the phone, tests). */
export function proofForToken(deviceToken: string, nonce: string): string {
  return challengeProof(hashSecret(deviceToken), nonce);
}

/**
 * The LAN rescan's two messages (macProof), each over a nonce the phone chose:
 * the phone names itself with its key over WHO_TAG_PREFIX + nonce (never its
 * id), and the Mac answers with the same key over MAC_PROOF_PREFIX + nonce +
 * ':' + the address the phone reached it at. Sign-in nonces are this Mac's
 * base64url (no ':'), so no proof can be traded for another.
 */
export const WHO_TAG_PREFIX = 'aasc-who:';
export const MAC_PROOF_PREFIX = 'aasc-mac:';

/**
 * Remote access (pathsProof): this Mac tells a signed-in phone its Tailscale
 * address, signed with the phone's key over PATHS_PROOF_PREFIX + a nonce the
 * phone chose (64 hex) + ':' + the address ('-' when there is none) + ':' + the
 * port, so the phone saves nothing that a box on the home network rewrote. A
 * third prefix: no proof for one of these messages is ever one for another.
 */
export const PATHS_PROOF_PREFIX = 'aasc-paths:';

export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * This Mac's answer to "are you the Mac that holds my key?" (POST /identify), asked in two steps so the caller
 * can decide what it may do for the device before it does it.
 */
export interface MachineProver {
  /** True only for a tag made with the key of a device this Mac vouches for. Never told to the device. */
  vouched: boolean;
  /**
   * The answer over `address`: the device's own key when vouched for, else a decoy of the same shape, the same
   * for the same question, so the answer does not say which devices exist.
   */
  over(address: string): string;
}

/**
 * `tokenHash`: the vouched-for device's, or null for any other tag. `decoyKey` is the server run's own, so a
 * decoy is no proof of anything and cannot be told from one without the device's key.
 */
export function machineProver(tokenHash: string | null, decoyKey: Buffer, tag: string, phoneNonce: string): MachineProver {
  return tokenHash === null
    ? { vouched: false, over: (address) => createHmac('sha256', decoyKey).update(`${tag}:${phoneNonce}:${address}`).digest('hex') }
    : { vouched: true, over: (address) => challengeProof(tokenHash, `${MAC_PROOF_PREFIX}${phoneNonce}:${address}`) };
}
