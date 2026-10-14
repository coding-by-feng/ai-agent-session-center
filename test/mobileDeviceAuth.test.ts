// test/mobileDeviceAuth.test.ts — AASC-15: pairing a phone with this Mac.
//
// The rules that keep a raced or stolen QR from becoming access: single-use two-minute codes, a pending
// state no token can get past until the desktop approves, tokens stored only as hashes, and revocation
// that reaches every session (onRevoked).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDeviceAuth, hashSecret, normalizePairingCode, sanitizeDeviceLabel, TooManyPairingCodesError, proofForToken,
  PAIRING_CODE_TTL_MS, PENDING_TTL_MS, MAX_OUTSTANDING_CODES, CHALLENGE_TTL_MS,
  type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

function memoryStore(): MobileDeviceStore & { rows: Map<string, MobileDeviceRecord> } {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    rows,
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

let clock = 1_000_000;
let store: ReturnType<typeof memoryStore>;
let onRevoked: ReturnType<typeof vi.fn>;
let auth: ReturnType<typeof createDeviceAuth>;
let epoch: string | null;

beforeEach(() => {
  clock = 1_000_000;
  epoch = 'pw-1';
  store = memoryStore();
  onRevoked = vi.fn();
  auth = createDeviceAuth({ store, now: () => clock, onRevoked, credentialEpoch: () => epoch });
});

/** Sign in the way the phone does: ask for a nonce, answer with the HMAC proof. */
function signIn(deviceId: string, deviceToken: string) {
  const { nonce } = auth.createChallenge(deviceId);
  return auth.exchange(deviceId, nonce, proofForToken(deviceToken, nonce));
}
function unpair(deviceId: string, deviceToken: string) {
  const { nonce } = auth.createChallenge(deviceId);
  return auth.unpair(deviceId, nonce, proofForToken(deviceToken, nonce));
}

function pairPhone(label = 'Kason iPhone') {
  const { code } = auth.createPairingCode();
  const result = auth.redeem({ code, label, platform: 'ios' });
  if (!result) throw new Error('redeem failed');
  return result;
}

describe('pairing codes', () => {
  it('are 10 characters from an unambiguous alphabet and last two minutes', () => {
    const { code, expiresAt } = auth.createPairingCode();
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
    expect(expiresAt - clock).toBe(PAIRING_CODE_TTL_MS);
  });

  it(`allow at most ${MAX_OUTSTANDING_CODES} open at once`, () => {
    for (let i = 0; i < MAX_OUTSTANDING_CODES; i++) auth.createPairingCode();
    expect(() => auth.createPairingCode()).toThrow(TooManyPairingCodesError);
    clock += PAIRING_CODE_TTL_MS + 1; // expired codes free their slot
    expect(() => auth.createPairingCode()).not.toThrow();
  });

  it('accept the code typed in lower case or with dashes', () => {
    const { code } = auth.createPairingCode();
    const typed = `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase();
    expect(normalizePairingCode(typed)).toBe(code);
    expect(auth.redeem({ code: typed, label: 'x', platform: 'android' })).not.toBeNull();
  });

  it('are single use — a second phone scanning the same QR gets nothing', () => {
    const { code } = auth.createPairingCode();
    expect(auth.redeem({ code, label: 'first', platform: 'ios' })).not.toBeNull();
    expect(auth.redeem({ code, label: 'second', platform: 'ios' })).toBeNull();
  });

  it('expire after two minutes', () => {
    const { code } = auth.createPairingCode();
    clock += PAIRING_CODE_TTL_MS;
    expect(auth.redeem({ code, label: 'late', platform: 'ios' })).toBeNull();
  });

  it('reject a code that was never issued', () => {
    expect(auth.redeem({ code: 'ABCDEFGHJK', label: 'x', platform: 'ios' })).toBeNull();
  });
});

describe('a redeemed phone', () => {
  it('starts pending with a 6-digit confirmation code', () => {
    const { device } = pairPhone();
    expect(device.status).toBe('pending');
    expect(device.confirmCode).toMatch(/^\d{6}$/);
  });

  it('is stored with the token hash only, never the token', () => {
    const { device, deviceToken } = pairPhone();
    const row = store.rows.get(device.id)!;
    expect(row.tokenHash).toBe(hashSecret(deviceToken));
    expect(JSON.stringify(row)).not.toContain(deviceToken);
  });

  it('cannot open a session until approved', () => {
    const { device, deviceToken } = pairPhone();
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'pending' });
    expect(auth.approve(device.id)?.status).toBe('active');
    const ok = signIn(device.id, deviceToken);
    expect(ok.ok).toBe(true);
    expect(store.rows.get(device.id)!.lastSeenAt).toBe(clock);
  });

  it('is refused with a wrong token or an unknown id', () => {
    const { device } = pairPhone();
    auth.approve(device.id);
    expect(signIn(device.id, 'x'.repeat(43))).toEqual({ ok: false, reason: 'invalid' });
    expect(signIn('00000000-0000-4000-8000-000000000000', 'x'.repeat(43))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('is revoked if nobody approves it within ten minutes', () => {
    const { device, deviceToken } = pairPhone();
    clock += PENDING_TTL_MS;
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'revoked' });
    expect(auth.approve(device.id)).toBeNull();
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in challenges', () => {
  it('never needs the token on the wire: a captured proof can’t be replayed', () => {
    const { device, deviceToken } = pairPhone();
    auth.approve(device.id);
    const { nonce } = auth.createChallenge(device.id);
    const proof = proofForToken(deviceToken, nonce);
    expect(auth.exchange(device.id, nonce, proof).ok).toBe(true);
    expect(auth.exchange(device.id, nonce, proof)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expire after a minute and belong to one device', () => {
    const a = pairPhone('A');
    const b = pairPhone('B');
    auth.approve(a.device.id);
    auth.approve(b.device.id);
    const forA = auth.createChallenge(a.device.id);
    expect(auth.exchange(b.device.id, forA.nonce, proofForToken(b.deviceToken, forA.nonce))).toEqual({ ok: false, reason: 'invalid' });
    const late = auth.createChallenge(a.device.id);
    clock += CHALLENGE_TTL_MS;
    expect(auth.exchange(a.device.id, late.nonce, proofForToken(a.deviceToken, late.nonce))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('are issued for unknown ids too, so the endpoint doesn’t reveal which devices exist', () => {
    expect(auth.createChallenge('00000000-0000-4000-8000-000000000000').nonce).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('a malformed proof fails without throwing', () => {
    const { device } = pairPhone();
    auth.approve(device.id);
    const { nonce } = auth.createChallenge(device.id);
    expect(auth.exchange(device.id, nonce, 'zz')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('password binding', () => {
  it('changing the dashboard password revokes every paired phone at its next sign-in', () => {
    const { device, deviceToken } = pairPhone();
    auth.approve(device.id);
    expect(signIn(device.id, deviceToken).ok).toBe(true);
    epoch = 'pw-2';
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'revoked' });
    expect(onRevoked).toHaveBeenCalledTimes(1);
    epoch = 'pw-1'; // changing it back doesn't resurrect the phone
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('deny, revoke and unpair', () => {
  it('deny deletes a pending phone and fires onRevoked', () => {
    const { device, deviceToken } = pairPhone();
    expect(auth.deny(device.id)).toBe(true);
    expect(store.rows.has(device.id)).toBe(false);
    expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: device.id, status: 'revoked' }));
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('deny does nothing to an approved phone (that is revoke)', () => {
    const { device } = pairPhone();
    auth.approve(device.id);
    expect(auth.deny(device.id)).toBe(false);
  });

  it('revoke ends an approved phone and fires onRevoked once', () => {
    const { device, deviceToken } = pairPhone();
    auth.approve(device.id);
    expect(auth.revoke(device.id)).toBe(true);
    expect(auth.revoke(device.id)).toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('unpair needs the phone’s own token', () => {
    const { device, deviceToken } = pairPhone();
    auth.approve(device.id);
    expect(unpair(device.id, 'wrong-token-wrong-token')).toBe(false);
    expect(unpair(device.id, deviceToken)).toBe(true);
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });
});

describe('list', () => {
  it('shows pending and active phones without secrets, and the confirmation code only while pending', () => {
    const a = pairPhone('Phone A');
    const b = pairPhone('Phone B');
    auth.approve(b.device.id);
    const c = pairPhone('Phone C');
    auth.revoke(c.device.id);
    const views = auth.list();
    expect(views.map((v) => v.label)).toEqual(['Phone A', 'Phone B']);
    expect(views[0].confirmCode).toBe(a.device.confirmCode);
    expect(views[1].confirmCode).toBeNull();
    expect(JSON.stringify(views)).not.toContain('tokenHash');
  });
});

describe('sanitizeDeviceLabel', () => {
  it('strips control characters and caps the length', () => {
    expect(sanitizeDeviceLabel('  Kason\u0000\u001b[31m iPhone  ')).toBe('Kason [31m iPhone');
    expect(sanitizeDeviceLabel('x'.repeat(200))).toHaveLength(80);
    expect(sanitizeDeviceLabel('\u0007')).toBe('Phone');
  });
});
