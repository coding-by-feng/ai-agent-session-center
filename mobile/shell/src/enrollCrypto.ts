// enrollCrypto.ts — the phone's half of the account enroll seal (plan 17), with WebCrypto.
//
// The phone makes an ephemeral P-256 key pair per enrollment and sends only the public point (raw,
// 65 bytes, base64url). The backend answers the ticket with a 32-byte `sealSecret` that only it, this
// phone (over TLS) and the Mac that redeems the ticket learn. The Mac answers with its own ephemeral
// point and the device token sealed:
//   shared = ECDH(phonePriv, macKey)                       (32 bytes, the x-coordinate)
//   ikm    = shared ‖ sealSecret
//   key    = HKDF-SHA256(ikm, salt = utf8(nonce), info = utf8('aasc-enroll-v1') ‖ phoneKeyRaw ‖ macKeyRaw, 32 bytes)
//   plain  = AES-256-GCM-open(key, iv, sealed, aad = utf8('aasc-enroll-v1:' + nonce + ':' + host + ':' + port))
// The secret is what makes the seal the real Mac's (C1): any box on the LAN sees the phone key and the
// nonce and could seal its own token to them, but not without the secret. `host:port` is the address
// THIS phone dialled, never one an answer names: a box that relays the request to the Mac gets a seal
// for the Mac's address, which doesn't open here (plan 17 rule 1). The private key and the secret never
// leave the caller's memory; nothing here logs.

export const ENROLL_INFO = 'aasc-enroll-v1';
/** The ticket's seal secret: 32 bytes, base64url. */
export const SEAL_SECRET = /^[A-Za-z0-9_-]{43}$/;

const B64U = /^[A-Za-z0-9_-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const utf8 = (text: string) => new TextEncoder().encode(text);

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of an unpadded base64url string, or null when it isn't one. */
export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64U.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function randomB64url(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 32 random bytes as hex: the Mac's `nonce` (HEX64). */
export function newEnrollNonce(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface PhoneKey {
  /** The raw public point, base64url (PHONE_KEY: 87 characters). */
  phoneKey: string;
  privateKey: CryptoKey;
}

const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** A fresh key pair for one enrollment; the private half can't be exported. */
export async function newPhoneKey(): Promise<PhoneKey> {
  const pair = await crypto.subtle.generateKey(P256, false, ['deriveBits']) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { phoneKey: b64urlEncode(raw), privateKey: pair.privateKey };
}

/** Hex SHA-256 of the raw public point: what the backend binds into the ticket. */
export async function phoneKeyHash(phoneKey: string): Promise<string | null> {
  const raw = b64urlDecode(phoneKey);
  return raw ? hex(await crypto.subtle.digest('SHA-256', raw)) : null;
}

export function enrollAad(nonce: string, host: string, port: number): string {
  return `${ENROLL_INFO}:${nonce}:${host}:${port}`;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface SealBinding {
  /** The ticket's 32-byte seal secret. */
  sealSecret: Uint8Array<ArrayBuffer>;
  /** The phone's and the Mac's raw public points (65 bytes each), bound into the key. */
  phoneKeyRaw: Uint8Array<ArrayBuffer>;
  macKeyRaw: Uint8Array<ArrayBuffer>;
}

/**
 * The AES-GCM key both sides derive (exported for the fake Mac's seal, which runs the same steps). `peerRaw` is the
 * other side's public point.
 */
export async function enrollKey(
  privateKey: CryptoKey, peerRaw: Uint8Array<ArrayBuffer>, nonce: string, bind: SealBinding, usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const peer = await crypto.subtle.importKey('raw', peerRaw, P256, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const ikm = await crypto.subtle.importKey('raw', concat(shared, bind.sealSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8(ENROLL_INFO), bind.phoneKeyRaw, bind.macKeyRaw) },
    ikm, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

export interface SealedAnswer {
  macKey: string;
  iv: string;
  sealed: string;
}

export interface SealedCredentials {
  deviceId: string;
  deviceToken: string;
}

function field(raw: unknown, key: string): unknown {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
}

/**
 * The device id and token the Mac sealed to `key`, when the answer opens with the ticket's `sealSecret` and the
 * AAD naming the address this phone dialled (`host`, `port`) and `nonce`; null for anything else.
 */
export async function openSealedCredentials(
  key: PhoneKey, answer: unknown, nonce: string, host: string, port: number, sealSecret: string,
): Promise<SealedCredentials | null> {
  const secret = SEAL_SECRET.test(sealSecret) ? b64urlDecode(sealSecret) : null;
  const phoneKeyRaw = b64urlDecode(key.phoneKey);
  if (!secret || secret.length !== 32 || !phoneKeyRaw) return null;
  const macKeyText = field(answer, 'macKey');
  const ivText = field(answer, 'iv');
  const sealedText = field(answer, 'sealed');
  if (typeof macKeyText !== 'string' || typeof ivText !== 'string' || typeof sealedText !== 'string') return null;
  const macKey = b64urlDecode(macKeyText);
  const iv = b64urlDecode(ivText);
  const sealed = b64urlDecode(sealedText);
  if (!macKey || macKey.length !== 65 || macKey[0] !== 0x04 || !iv || iv.length !== 12 || !sealed || sealed.length <= 16) return null;
  let plain: unknown;
  try {
    const aes = await enrollKey(key.privateKey, macKey, nonce, { sealSecret: secret, phoneKeyRaw, macKeyRaw: macKey }, 'decrypt');
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(enrollAad(nonce, host, port)), tagLength: 128 }, aes, sealed,
    );
    plain = JSON.parse(new TextDecoder().decode(opened));
  } catch {
    return null;
  }
  const deviceId = field(plain, 'deviceId');
  const deviceToken = field(plain, 'deviceToken');
  if (typeof deviceId !== 'string' || !UUID.test(deviceId) || typeof deviceToken !== 'string' || deviceToken.length < 20) return null;
  return { deviceId, deviceToken };
}
