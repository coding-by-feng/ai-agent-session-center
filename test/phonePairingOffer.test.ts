// test/phonePairingOffer.test.ts — "Pair a phone" is offered unless turned off (was off until the app shipped, AASC-30).
import { describe, it, expect } from 'vitest';
import { isPhonePairingOffered } from '../server/mobile/pairingOffer.js';

describe('isPhonePairingOffered', () => {
  it('is on by default: the phone app ships, so the QR leads somewhere', () => {
    expect(isPhonePairingOffered({}, {})).toBe(true);
    expect(isPhonePairingOffered({ phonePairing: true }, {})).toBe(true);
  });

  it('turns off with phonePairing: false in server-config.json', () => {
    expect(isPhonePairingOffered({ phonePairing: false }, {})).toBe(false);
  });

  it('AASC_PHONE_PAIRING overrides the file either way', () => {
    expect(isPhonePairingOffered({ phonePairing: false }, { AASC_PHONE_PAIRING: '1' })).toBe(true);
    expect(isPhonePairingOffered({ phonePairing: false }, { AASC_PHONE_PAIRING: 'true' })).toBe(true);
    expect(isPhonePairingOffered({}, { AASC_PHONE_PAIRING: '0' })).toBe(false);
    expect(isPhonePairingOffered({ phonePairing: true }, { AASC_PHONE_PAIRING: 'false' })).toBe(false);
  });

  it('ignores any other value of the variable and keeps the file’s answer', () => {
    expect(isPhonePairingOffered({}, { AASC_PHONE_PAIRING: 'no' })).toBe(true);
    expect(isPhonePairingOffered({ phonePairing: false }, { AASC_PHONE_PAIRING: '' })).toBe(false);
  });

  it('only a real false turns it off in the file (a hand-edited "false" string does not)', () => {
    expect(isPhonePairingOffered({ phonePairing: 'false' as unknown as boolean }, {})).toBe(true);
  });
});
