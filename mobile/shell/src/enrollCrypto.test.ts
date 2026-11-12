// Plan 17: the phone's half of the enroll seal, checked against Node's own crypto (what the Mac uses).
import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  b64urlDecode, b64urlEncode, ENROLL_INFO, enrollAad, newEnrollNonce, newPhoneKey, openSealedCredentials, phoneKeyHash,
} from './enrollCrypto';

const NONCE = 'a'.repeat(64);
/** The ticket's seal secret: only the backend, the phone and the Mac that redeems the ticket know it. */
const SECRET = randomBytes(32).toString('base64url');

/**
 * The Mac's seal exactly as plan 17 (C1) writes it, with Node `crypto` (server/mobile/accountEnroll.ts mirrors this):
 * ikm = ECDH ‖ sealSecret, salt = utf8(nonce), info = utf8('aasc-enroll-v1') ‖ phoneKeyRaw ‖ macKeyRaw.
 * A box without the ticket's secret seals with `secret` = anything else.
 */
function nodeSeal(phoneKey: string, nonce: string, reachedAt: string, plaintext: unknown, secret: string = SECRET) {
  const ecdh = createECDH('prime256v1');
  const macKey = ecdh.generateKeys();
  const phoneRaw = Buffer.from(phoneKey, 'base64url');
  const ikm = Buffer.concat([ecdh.computeSecret(phoneRaw), Buffer.from(secret, 'base64url')]);
  const info = Buffer.concat([Buffer.from('aasc-enroll-v1', 'utf8'), phoneRaw, macKey]);
  const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(nonce, 'utf8'), info, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`aasc-enroll-v1:${nonce}:${reachedAt}`, 'utf8'));
  const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(plaintext), 'utf8')), cipher.final(), cipher.getAuthTag()]);
  return { macKey: macKey.toString('base64url'), iv: iv.toString('base64url'), sealed: sealed.toString('base64url') };
}

const CREDS = { deviceId: '0f8b1c2d-3e4f-4a5b-8c6d-7e8f90a1b2c3', deviceToken: 'tok_'.padEnd(48, 'x') };

describe('enrollCrypto', () => {
  it('base64url is unpadded and round-trips', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0x00, 0x01, 0x02]);
    expect(b64urlEncode(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
    expect(b64urlEncode(bytes)).not.toContain('=');
    expect([...b64urlDecode(b64urlEncode(bytes))!]).toEqual([...bytes]);
    expect(b64urlDecode('not base64!')).toBeNull();
  });

  it('a phone key is the raw 65-byte uncompressed P-256 point, 87 base64url characters', async () => {
    const key = await newPhoneKey();
    expect(key.phoneKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const raw = Buffer.from(key.phoneKey, 'base64url');
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(await phoneKeyHash(key.phoneKey)).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('a nonce is 32 random bytes as hex', () => {
    const a = newEnrollNonce();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newEnrollNonce()).not.toBe(a);
  });

  it('opens what the Mac sealed for the address the phone dialled', async () => {
    const key = await newPhoneKey();
    const answer = nodeSeal(key.phoneKey, NONCE, '100.101.102.103:3333', CREDS);
    expect(await openSealedCredentials(key, answer, NONCE, '100.101.102.103', 3333, SECRET)).toEqual(CREDS);
    expect(enrollAad(NONCE, '100.101.102.103', 3333, SECRET)).toBe(`${ENROLL_INFO}:${NONCE}:100.101.102.103:3333`);
  });

  it('refuses an answer sealed for another address (a relay), another nonce, or another key', async () => {
    const key = await newPhoneKey();
    const answer = nodeSeal(key.phoneKey, NONCE, '192.168.1.20:3333', CREDS);
    expect(await openSealedCredentials(key, answer, NONCE, '192.168.1.30', 3333, SECRET)).toBeNull();
    expect(await openSealedCredentials(key, answer, NONCE, '192.168.1.20', 3334, SECRET)).toBeNull();
    expect(await openSealedCredentials(key, answer, 'b'.repeat(64), '192.168.1.20', 3333, SECRET)).toBeNull();
    expect(await openSealedCredentials(await newPhoneKey(), answer, NONCE, '192.168.1.20', 3333, SECRET)).toBeNull();
  });

  it('refuses a seal a box made with its own key for the dialled address, without the ticket’s secret (C1)', async () => {
    const key = await newPhoneKey();
    // The box saw phoneKey and nonce on the LAN and seals for the very address the phone dialled, with its own token.
    const forged = nodeSeal(key.phoneKey, NONCE, '192.168.1.20:3333', CREDS, randomBytes(32).toString('base64url'));
    expect(await openSealedCredentials(key, forged, NONCE, '192.168.1.20', 3333, SECRET)).toBeNull();
    // The same seal with the ticket's secret opens: the secret is the only difference.
    const real = nodeSeal(key.phoneKey, NONCE, '192.168.1.20:3333', CREDS);
    expect(await openSealedCredentials(key, real, NONCE, '192.168.1.20', 3333, SECRET)).toEqual(CREDS);
  });

  it('binds both public keys: an answer whose macKey was swapped doesn’t open', async () => {
    const key = await newPhoneKey();
    const real = nodeSeal(key.phoneKey, NONCE, '192.168.1.20:3333', CREDS);
    const other = createECDH('prime256v1').generateKeys().toString('base64url');
    expect(await openSealedCredentials(key, { ...real, macKey: other }, NONCE, '192.168.1.20', 3333, SECRET)).toBeNull();
  });

  it('refuses a seal secret that isn’t 32 bytes of base64url', async () => {
    const key = await newPhoneKey();
    const real = nodeSeal(key.phoneKey, NONCE, '192.168.1.20:3333', CREDS);
    expect(await openSealedCredentials(key, real, NONCE, '192.168.1.20', 3333, 'short')).toBeNull();
  });

  it('refuses malformed answers and plaintexts that are not credentials', async () => {
    const key = await newPhoneKey();
    const good = nodeSeal(key.phoneKey, NONCE, '100.101.102.103:3333', CREDS);
    const at = ['100.101.102.103', 3333, SECRET] as const;
    expect(await openSealedCredentials(key, { ...good, macKey: 'short' }, NONCE, ...at)).toBeNull();
    expect(await openSealedCredentials(key, { ...good, iv: 'AAAA' }, NONCE, ...at)).toBeNull();
    expect(await openSealedCredentials(key, { ...good, sealed: '' }, NONCE, ...at)).toBeNull();
    expect(await openSealedCredentials(key, null, NONCE, ...at)).toBeNull();
    const notCreds = nodeSeal(key.phoneKey, NONCE, '100.101.102.103:3333', { deviceId: 'nope', deviceToken: 'short' });
    expect(await openSealedCredentials(key, notCreds, NONCE, ...at)).toBeNull();
  });
});
