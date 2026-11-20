// remoteAccessSeal.test.ts — the client's half of the account seal (plan 18, contract B): a computer connecting
// through the account opens what the machine sealed only with the ticket's seal secret and only for the address it
// dialled itself.
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import { ACCESS_SEAL_INFO, newClientKey, openSealedAccess } from '../electron/remote/accessSeal.js';
import { dialledAddress } from '../electron/remote/remoteClient.js';
import { ACCESS_INFO, sealAsMachine } from './remoteAccountFixture.js';

const NONCE = 'c'.repeat(64);
const ADDRESS = '192.168.1.20:3333';
const DEVICE_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const DEVICE_TOKEN = 'dGhpcyBpcyBhIGRldmljZSB0b2tlbiBmb3IgdGVzdHM';
const PENDING = { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, status: 'pending', confirmCode: '482913' };
const ACTIVE = { deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN, status: 'active', confirmCode: null };

const secret = (): string => randomBytes(32).toString('base64url');

/** A seal for a fresh client key; `sealSecret` is the ticket's real one, whatever `over` made the machine seal with. */
function sealed(plaintext: unknown, over: Partial<Parameters<typeof sealAsMachine>[0]> = {}) {
  const key = newClientKey();
  const sealSecret = secret();
  const answer = sealAsMachine({ clientKey: key.clientKey, sealSecret, nonce: NONCE, boundAddress: ADDRESS, plaintext, ...over });
  return { key, sealSecret, answer };
}

describe('newClientKey', () => {
  it('is a fresh uncompressed P-256 point each time, 87 base64url characters', () => {
    const a = newClientKey();
    const b = newClientKey();
    expect(a.clientKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(Buffer.from(a.clientKey, 'base64url')).toHaveLength(65);
    expect(Buffer.from(a.clientKey, 'base64url')[0]).toBe(0x04);
    expect(a.clientKey).not.toBe(b.clientKey);
  });

  it('keeps the private half where nothing can serialise it', () => {
    const key = newClientKey();
    expect(JSON.parse(JSON.stringify(key))).toEqual({ clientKey: key.clientKey });
  });
});

describe('dialledAddress', () => {
  it('is the host and port of the origin dialled, with the port a URL leaves out', () => {
    expect(dialledAddress('http://192.168.1.20:3333')).toBe('192.168.1.20:3333');
    expect(dialledAddress('http://192.168.1.20:80')).toBe('192.168.1.20:80');
    expect(dialledAddress('http://45.63.31.79:8080/')).toBe('45.63.31.79:8080');
    expect(dialledAddress('not a url')).toBeNull();
  });
});

describe('openSealedAccess', () => {
  it('uses the contract’s domain string', () => {
    expect(ACCESS_SEAL_INFO).toBe(ACCESS_INFO);
  });

  it('opens a pending record with its confirm code', () => {
    const { key, sealSecret, answer } = sealed(PENDING);
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, sealSecret)).toEqual(PENDING);
  });

  it('opens an active record, which has no confirm code', () => {
    const { key, sealSecret, answer } = sealed(ACTIVE);
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, sealSecret)).toEqual(ACTIVE);
    // A code sent with an active record is nothing to show: nobody is waiting for Allow.
    const coded = sealed({ ...ACTIVE, confirmCode: '482913' });
    expect(openSealedAccess(coded.key, coded.answer, NONCE, ADDRESS, coded.sealSecret)).toEqual(ACTIVE);
  });

  it('does not open for another address: a relay’s answer is sealed for the machine’s own', () => {
    const { key, sealSecret, answer } = sealed(PENDING);
    expect(openSealedAccess(key, answer, NONCE, '192.168.1.66:3333', sealSecret)).toBeNull();
    expect(openSealedAccess(key, answer, NONCE, '192.168.1.20:3334', sealSecret)).toBeNull();
  });

  it('does not open without the ticket’s seal secret: a box that saw the key can’t seal its own token', () => {
    const { key, answer } = sealed(PENDING);
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, secret())).toBeNull();
  });

  it('does not open a seal made with no secret at all, from the public key and the nonce alone', () => {
    // What any box that saw the request could make. Sealed for the right address, and still not the machine's.
    const { key, sealSecret, answer } = sealed(PENDING, { sealSecret: '' });
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, sealSecret)).toBeNull();
  });

  it('does not open for a machine key that is off the curve', () => {
    const { key, sealSecret, answer } = sealed(PENDING);
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]).toString('base64url');
    expect(openSealedAccess(key, { ...answer, machineKey: offCurve }, NONCE, ADDRESS, sealSecret)).toBeNull();
  });

  it('does not open for another nonce, another key or a changed byte', () => {
    const { key, sealSecret, answer } = sealed(PENDING);
    expect(openSealedAccess(key, answer, 'd'.repeat(64), ADDRESS, sealSecret)).toBeNull();
    expect(openSealedAccess(newClientKey(), answer, NONCE, ADDRESS, sealSecret)).toBeNull();
    const bytes = Buffer.from(answer.sealed, 'base64url');
    bytes[3] ^= 1;
    expect(openSealedAccess(key, { ...answer, sealed: bytes.toString('base64url') }, NONCE, ADDRESS, sealSecret)).toBeNull();
  });

  it('does not open a phone enroll seal (plan 17’s domain string)', () => {
    const { key, sealSecret, answer } = sealed(PENDING, { info: 'aasc-enroll-v1' });
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, sealSecret)).toBeNull();
  });

  it.each([
    ['no answer', null],
    ['a string', 'sealed'],
    ['a missing field', { machineKey: 'x'.repeat(87), iv: 'y'.repeat(16) }],
    ['a machine key that is no point', { machineKey: 'A'.repeat(87), iv: 'A'.repeat(16), sealed: 'A'.repeat(64) }],
    ['a short iv', { machineKey: newClientKey().clientKey, iv: 'AAAA', sealed: 'A'.repeat(64) }],
    ['nothing sealed', { machineKey: newClientKey().clientKey, iv: 'A'.repeat(16), sealed: 'A'.repeat(20) }],
    ['characters outside base64url', { machineKey: newClientKey().clientKey, iv: 'A'.repeat(16), sealed: '!'.repeat(64) }],
  ])('is null for %s', (_name, answer) => {
    expect(openSealedAccess(newClientKey(), answer, NONCE, ADDRESS, secret())).toBeNull();
  });

  it('is null for a seal secret, nonce or address of the wrong shape', () => {
    const { key, sealSecret, answer } = sealed(PENDING);
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, 'short')).toBeNull();
    expect(openSealedAccess(key, answer, 'nonce', ADDRESS, sealSecret)).toBeNull();
    expect(openSealedAccess(key, answer, NONCE, '', sealSecret)).toBeNull();
  });

  it.each([
    ['a revoked status', { ...PENDING, status: 'revoked' }],
    ['no token', { deviceId: DEVICE_ID, status: 'active', confirmCode: null }],
    ['a short token', { ...ACTIVE, deviceToken: 'short' }],
    ['a device id that is no UUID', { ...ACTIVE, deviceId: 'device-1' }],
    ['a confirm code that is not six digits', { ...PENDING, confirmCode: '12ab56' }],
    ['a pending record with no confirm code', { ...PENDING, confirmCode: null }],
    ['text that is no JSON', 'not json'],
  ])('is null when what was sealed is %s', (_name, plaintext) => {
    const { key, sealSecret, answer } = sealed(plaintext);
    expect(openSealedAccess(key, answer, NONCE, ADDRESS, sealSecret)).toBeNull();
  });
});
