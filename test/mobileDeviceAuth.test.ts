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

function approvedPhone(label = 'Kason iPhone') {
  const phone = pairPhone(label);
  auth.approve(phone.device.id);
  return phone;
}

describe('backend code (AASC-51, AASC-52)', () => {
  it('a redeemed pairing code never carries one: the QR has the Mac code only', () => {
    expect(pairPhone().device).toMatchObject({ beCodeRef: null, beCodeRefMacBound: false });
    expect('attachBackendCode' in auth).toBe(false);
  });

  it('goes only to an approved phone whose token is from the current password', () => {
    expect(auth.backendCodeHolder('00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'unknown' });
    const pending = pairPhone('Pending');
    expect(auth.backendCodeHolder(pending.device.id)).toEqual({ ok: false, reason: 'pending' });
    const active = approvedPhone();
    expect(auth.backendCodeHolder(active.device.id)).toMatchObject({ ok: true, device: { id: active.device.id, status: 'active' } });
    auth.revoke(active.device.id);
    expect(auth.backendCodeHolder(active.device.id)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a phone from before a password change is refused and revoked on the spot', () => {
    const phone = approvedPhone();
    epoch = 'pw-2';
    expect(auth.backendCodeHolder(phone.device.id)).toEqual({ ok: false, reason: 'revoked' });
    expect(store.rows.get(phone.device.id)?.status).toBe('revoked');
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('is bound to the phone it was issued to, by the Mac (never by the phone)', () => {
    const phone = approvedPhone();
    expect(auth.bindBackendCode(phone.device.id, 'ref-1')).toBe(true);
    expect(store.rows.get(phone.device.id)).toMatchObject({ beCodeRef: 'ref-1', beCodeRefMacBound: true });
    // Asking again replaces it: one phone, one backend code.
    expect(auth.bindBackendCode(phone.device.id, 'ref-2')).toBe(true);
    expect(store.rows.get(phone.device.id)).toMatchObject({ beCodeRef: 'ref-2', beCodeRefMacBound: true });
    const pending = pairPhone('Pending');
    expect(auth.bindBackendCode(pending.device.id, 'ref-3')).toBe(false);
    expect(store.rows.get(pending.device.id)?.beCodeRef).toBeNull();
  });

  it('lists the backend codes bound to live phones only', () => {
    const a = approvedPhone('A');
    const b = approvedPhone('B');
    approvedPhone('C'); // no backend code
    auth.bindBackendCode(a.device.id, 'ref-a');
    auth.bindBackendCode(b.device.id, 'ref-b');
    auth.revoke(b.device.id);
    store.insert({ ...a.device, id: 'legacy', tokenHash: 'f'.repeat(64), beCodeRef: 'phone-chosen', beCodeRefMacBound: false });
    expect([...auth.linkedBackendCodeRefs()]).toEqual(['ref-a']);
  });
});

describe('a password change (AASC-52)', () => {
  it('revokes every phone paired under the old password at once, not at its next sign-in', () => {
    const a = approvedPhone('A');
    const b = pairPhone('B'); // pending phones too
    auth.bindBackendCode(a.device.id, 'ref-a');
    expect(auth.revokeStaleCredentials()).toBe(0);
    expect(onRevoked).not.toHaveBeenCalled();
    epoch = 'pw-2';
    const c = approvedPhone('C'); // paired under the new password: stays
    expect(auth.revokeStaleCredentials()).toBe(2);
    expect(onRevoked.mock.calls.map(([d]) => d.id).sort()).toEqual([a.device.id, b.device.id].sort());
    // The handler gets the full record, so it can revoke the backend device bound to it.
    expect(onRevoked.mock.calls.find(([d]) => d.id === a.device.id)?.[0]).toMatchObject({ beCodeRef: 'ref-a', beCodeRefMacBound: true, status: 'revoked' });
    expect(store.rows.get(c.device.id)?.status).toBe('active');
    expect(auth.revokeStaleCredentials()).toBe(0); // once
  });

  it('revokes nothing when no password is in force: an unreadable config must not wipe every phone', () => {
    const a = approvedPhone('A');
    epoch = null; // server-config.json missing, truncated or cleared: the phone routes refuse anyway
    expect(auth.revokeStaleCredentials()).toBe(0);
    expect(store.rows.get(a.device.id)?.status).toBe('active');
    epoch = 'pw-1'; // the same password back: the phone still works
    expect(signIn(a.device.id, a.deviceToken).ok).toBe(true);
    epoch = 'pw-2'; // a different one: revoked then
    expect(auth.revokeStaleCredentials()).toBe(1);
  });
});

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

describe('rename and sign out from the desktop', () => {
  it('rename changes the label, cleaned the same way as at pairing', () => {
    const phone = approvedPhone();
    const view = auth.rename(phone.device.id, '  Work\u0007  iPhone ');
    expect(view?.label).toBe('Work iPhone');
    expect(store.rows.get(phone.device.id)?.label).toBe('Work iPhone');
    expect(auth.list()[0].label).toBe('Work iPhone');
  });

  it('rename caps the label at 80 characters and refuses an empty one', () => {
    const phone = approvedPhone();
    expect(auth.rename(phone.device.id, 'x'.repeat(200))?.label).toHaveLength(80);
    expect(auth.rename(phone.device.id, '  \u0001 ')).toBeNull();
    expect(store.rows.get(phone.device.id)?.label).toHaveLength(80);
  });

  it('rename works on a pending phone but not on an unknown or revoked one', () => {
    const pending = pairPhone();
    expect(auth.rename(pending.device.id, 'Spare')?.label).toBe('Spare');
    expect(auth.rename('nope', 'Spare')).toBeNull();
    const gone = approvedPhone();
    auth.revoke(gone.device.id);
    expect(auth.rename(gone.device.id, 'Spare')).toBeNull();
  });

  it('a later sign-in never overwrites the new name', () => {
    const phone = approvedPhone();
    auth.rename(phone.device.id, 'Work iPhone');
    expect(signIn(phone.device.id, phone.deviceToken).ok).toBe(true);
    expect(auth.list()[0].label).toBe('Work iPhone');
  });

  it('sign out ends the sessions of an approved phone and keeps it paired', () => {
    const onSignedOut = vi.fn();
    auth = createDeviceAuth({ store, now: () => clock, onRevoked, onSignedOut, credentialEpoch: () => epoch });
    const phone = approvedPhone();
    expect(auth.signOut(phone.device.id)?.status).toBe('active');
    expect(onSignedOut).toHaveBeenCalledWith(expect.objectContaining({ id: phone.device.id }));
    expect(onRevoked).not.toHaveBeenCalled();
    // Still paired: the phone can sign in again with its key.
    expect(signIn(phone.device.id, phone.deviceToken).ok).toBe(true);
  });

  it('sign out refuses a pending, revoked or unknown phone', () => {
    const onSignedOut = vi.fn();
    auth = createDeviceAuth({ store, now: () => clock, onRevoked, onSignedOut, credentialEpoch: () => epoch });
    expect(auth.signOut(pairPhone().device.id)).toBeNull();
    const gone = approvedPhone();
    auth.revoke(gone.device.id);
    expect(auth.signOut(gone.device.id)).toBeNull();
    expect(auth.signOut('nope')).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});
