// Plan 17 review M1 / Correctness 3: the account switch's state, with why it is greyed out.
import { describe, expect, it } from 'vitest';
import { readAccountEnroll } from './mobilePairingApi';

describe('readAccountEnroll', () => {
  it('passes each known reason through', () => {
    for (const blocked of ['pairing-off', 'no-password', 'no-cloud'] as const) {
      expect(readAccountEnroll({ enabled: false, available: false, email: null, blocked })?.blocked).toBe(blocked);
    }
  });

  it('reads no reason as usable when available', () => {
    expect(readAccountEnroll({ enabled: true, available: true, email: 'me@example.com', blocked: null }))
      .toEqual({ enabled: true, available: true, email: 'me@example.com', blocked: null });
  });

  it('gives an older server (no blocked field) or an unknown reason the one reason it knew', () => {
    expect(readAccountEnroll({ enabled: true, available: false, email: null })?.blocked).toBe('no-cloud');
    expect(readAccountEnroll({ enabled: true, available: true, email: null })?.blocked).toBeNull();
    expect(readAccountEnroll({ enabled: true, available: false, email: null, blocked: 'later-reason' })?.blocked).toBe('no-cloud');
  });

  it('is null for an answer it cannot read', () => {
    expect(readAccountEnroll(null)).toBeNull();
    expect(readAccountEnroll({ enabled: 'yes', available: true })).toBeNull();
  });
});
