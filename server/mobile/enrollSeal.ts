// enrollSeal.ts — the seal of an account enroll answer: plan 17's (a phone, accountEnroll.ts) and plan 18's
// (a computer, computerEnroll.ts). One construction, told apart by the domain string each caller passes.
//
//   ownKey, ownPriv = ephemeral P-256;  shared = ECDH(ownPriv, peerKey) (32-byte x-coordinate)
//   key  = HKDF-SHA256(ikm  = shared ‖ sealSecret (32 bytes, from the redeem answer; plan 17 review C1),
//                      salt = utf8(nonce),
//                      info = utf8(domain) ‖ peerKeyRaw (65) ‖ ownKeyRaw (65), 32 bytes)
//   iv   = 12 random bytes;  AES-256-GCM over utf8(plaintext)
//   aad  = utf8(domain + ':' + nonce + ':' + boundAddress)
//   sealed = ciphertext ‖ 16-byte tag
//
// `sealSecret` reaches only the device (with its ticket, over TLS) and the machine the ticket names (at the
// redeem, over TLS): without it a box on the LAN that saw the device's public key could seal a token of its own
// to it. `boundAddress` is the address the request reached (boundAddress.ts), so the device opens the answer
// only with the address it dialled itself. Nothing here logs anything.

import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

export interface PreparedSeal {
  /** This machine's ephemeral public key: a 65-byte uncompressed P-256 point. */
  ownKey: Buffer;
  key: Buffer;
}

export interface SealedAnswer {
  /** base64url of `ownKey`. */
  ownKey: string;
  /** base64url of the 12-byte iv. */
  iv: string;
  /** base64url of ciphertext ‖ 16-byte tag. */
  sealed: string;
}

export const sha256hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Two lower-case hex strings of the same length are equal, in constant time. */
export function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Everything about the seal that can fail, done before any record exists: a fresh key of this machine's, ECDH
 * with the device's key and the HKDF. Null for a device key that is no P-256 point.
 */
export function prepareSeal(domain: string, peerKey: Buffer, sealSecret: Buffer, nonce: string): PreparedSeal | null {
  const ecdh = createECDH('prime256v1');
  const ownKey = ecdh.generateKeys(); // uncompressed, 65 bytes
  let shared: Buffer;
  try {
    shared = ecdh.computeSecret(peerKey);
  } catch {
    return null;
  }
  const ikm = Buffer.concat([shared, sealSecret]);
  const info = Buffer.concat([Buffer.from(domain, 'utf8'), peerKey, ownKey]);
  const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(nonce, 'utf8'), info, 32));
  return { ownKey, key };
}

export function sealAnswer(
  domain: string,
  prepared: PreparedSeal,
  nonce: string,
  boundAddress: string,
  plaintext: string,
): SealedAnswer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', prepared.key, iv);
  cipher.setAAD(Buffer.from(`${domain}:${nonce}:${boundAddress}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ownKey: prepared.ownKey.toString('base64url'),
    iv: iv.toString('base64url'),
    sealed: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64url'),
  };
}
