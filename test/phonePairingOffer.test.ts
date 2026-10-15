// test/phonePairingOffer.test.ts — AASC-30: "Pair a phone" stays off until the phone app ships.
import { describe, it, expect } from 'vitest';
import { isPhonePairingOffered } from '../server/mobile/pairingOffer.js';

describe('isPhonePairingOffered', () => {
  it('is off by default: there is no phone app to pair with yet', () => {
    expect(isPhonePairingOffered({}, {})).toBe(false);
    expect(isPhonePairingOffered({ phonePairing: false }, {})).toBe(false);
  });

  it('turns on with phonePairing: true in server-config.json', () => {
    expect(isPhonePairingOffered({ phonePairing: true }, {})).toBe(true);
  });

  it('AASC_PHONE_PAIRING overrides the file either way', () => {
    expect(isPhonePairingOffered({}, { AASC_PHONE_PAIRING: '1' })).toBe(true);
    expect(isPhonePairingOffered({}, { AASC_PHONE_PAIRING: 'true' })).toBe(true);
    expect(isPhonePairingOffered({ phonePairing: true }, { AASC_PHONE_PAIRING: '0' })).toBe(false);
    expect(isPhonePairingOffered({ phonePairing: true }, { AASC_PHONE_PAIRING: 'false' })).toBe(false);
  });

  it('ignores any other value of the variable and keeps the file’s answer', () => {
    expect(isPhonePairingOffered({}, { AASC_PHONE_PAIRING: 'yes' })).toBe(false);
    expect(isPhonePairingOffered({ phonePairing: true }, { AASC_PHONE_PAIRING: '' })).toBe(true);
  });

  it('only a real true counts in the file (a hand-edited "true" string does not)', () => {
    expect(isPhonePairingOffered({ phonePairing: 'true' as unknown as boolean }, {})).toBe(false);
  });
});
