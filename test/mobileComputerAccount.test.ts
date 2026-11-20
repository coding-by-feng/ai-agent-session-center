// test/mobileComputerAccount.test.ts — plan 18, stage 2: a computer record made through the AASC Cloud account.
//
// deviceAuth.enrollComputer makes a `desktop` record of origin `account`, holding the client's own backend
// device id. `ask` (the default): PENDING with a confirm code, like a computer paired by link, until Allow.
// `auto`: ACTIVE at once, provisional until its first sign-in like an account phone. Nothing the owner has
// allowed is displaced by a request nobody allowed yet: an earlier record of the same backend client device
// goes only when the new one is in force. Removing one on purpose is told apart from the computer removing
// itself, so only the first can keep it out (accountComputerRemoval.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDeviceAuth, hashSecret, proofForToken, challengeProof, MAC_PROOF_PREFIX, WHO_TAG_PREFIX,
  MAX_PROVISIONAL_ACCOUNT_ROWS, PENDING_TTL_MS, PROVISIONAL_ACCOUNT_TTL_MS, TooManyWaitingAccountDevicesError,
  type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';
import { createAccountPhoneRevokedHandler } from '../server/mobile/accountPhoneRevocation.js';
import { createAccountComputerRemovedHandler } from '../server/mobile/accountComputerRemoval.js';

const CLIENT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_CLIENT = '00000000-0000-4000-8000-0000000000c2';

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

describe('deviceAuth.enrollComputer', () => {
  let store: ReturnType<typeof memoryStore>;
  let t: number;
  let onRevoked: ReturnType<typeof vi.fn<(device: MobileDeviceRecord) => void>>;
  let onRemovedByOwner: ReturnType<typeof vi.fn<(device: MobileDeviceRecord, how: 'revoke' | 'unpair') => void>>;
  let auth: ReturnType<typeof createDeviceAuth>;

  const enroll = (over: Partial<Parameters<typeof auth.enrollComputer>[0]> = {}) =>
    auth.enrollComputer({ label: 'Kason’s MacBook Pro', accountEmail: 'me@example.com', backendDeviceId: CLIENT, approve: 'ask', ...over });
  const signIn = (id: string, token: string) => {
    const { nonce } = auth.createChallenge(id);
    return auth.exchange(id, nonce, proofForToken(token, nonce));
  };

  beforeEach(() => {
    store = memoryStore();
    t = 1_000_000;
    onRevoked = vi.fn();
    onRemovedByOwner = vi.fn();
    auth = createDeviceAuth({ store, now: () => t, credentialEpoch: () => 'epoch-1', onRevoked, onRemovedByOwner });
  });

  it('ask: makes a pending computer with a confirm code, which signs in only after Allow', () => {
    const { device, deviceToken } = enroll();
    expect(device).toMatchObject({
      platform: 'desktop', origin: 'account', status: 'pending', accountEmail: 'me@example.com', accountPhoneId: CLIENT,
      label: 'Kason’s MacBook Pro', approvedAt: null, lastSeenAt: null, credentialEpoch: 'epoch-1',
    });
    expect(device.confirmCode).toMatch(/^\d{6}$/);
    expect(device.tokenHash).toBe(hashSecret(deviceToken));
    expect(auth.list()).toEqual([expect.objectContaining({ id: device.id, status: 'pending', confirmCode: device.confirmCode, origin: 'account' })]);
    expect(signIn(device.id, deviceToken)).toEqual({ ok: false, reason: 'pending' });
    expect(auth.approve(device.id)).toMatchObject({ status: 'active', origin: 'account', confirmCode: null });
    expect(signIn(device.id, deviceToken).ok).toBe(true);
  });

  it('auto: makes an active computer that signs in at once', () => {
    const { device, deviceToken } = enroll({ approve: 'auto' });
    expect(device).toMatchObject({ platform: 'desktop', origin: 'account', status: 'active', approvedAt: t, accountPhoneId: CLIENT });
    expect(signIn(device.id, deviceToken).ok).toBe(true);
  });

  it('names the record by the given name, cleaned, or "Computer"', () => {
    expect(enroll({ label: '  Mac\u0007 mini  ' }).device.label).toBe('Mac mini');
    expect(enroll({ label: '', backendDeviceId: OTHER_CLIENT }).device.label).toBe('Computer');
  });

  it('auto: a computer that never signs in is deleted after two minutes, like an account phone', () => {
    const { device, deviceToken } = enroll({ approve: 'auto' });
    t += PROVISIONAL_ACCOUNT_TTL_MS + 1;
    expect(auth.list()).toEqual([]);
    expect(store.rows.has(device.id)).toBe(false);
    expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: device.id, status: 'revoked' }));
    expect(onRemovedByOwner).not.toHaveBeenCalled();
    expect(signIn(device.id, deviceToken).ok).toBe(false);
  });

  it('ask: a computer the owner allowed is never swept, however long it takes to sign in', () => {
    const { device, deviceToken } = enroll();
    t += 3 * 60_000;
    expect(auth.approve(device.id)).not.toBeNull();
    t += 24 * 3_600_000;
    expect(auth.list().map((d) => d.id)).toEqual([device.id]);
    expect(signIn(device.id, deviceToken).ok).toBe(true);
  });

  it('ask: an Allow in the same millisecond as the request still counts as a click (not provisional)', () => {
    const { device } = enroll();
    expect(auth.approve(device.id)).not.toBeNull(); // the clock has not moved
    expect(store.rows.get(device.id)!.approvedAt).toBeGreaterThan(store.rows.get(device.id)!.createdAt);
    t += PROVISIONAL_ACCOUNT_TTL_MS + 1;
    expect(auth.list().map((d) => d.id)).toEqual([device.id]);
    expect(auth.provisionalAccountCount()).toBe(0);
  });

  it('ask: a pending computer nobody allows expires after ten minutes like any pending device', () => {
    const { device, deviceToken } = enroll();
    t += PENDING_TTL_MS + 1;
    expect(auth.list()).toEqual([]);
    expect(auth.approve(device.id)).toBeNull();
    expect(signIn(device.id, deviceToken).ok).toBe(false);
    expect(onRemovedByOwner).not.toHaveBeenCalled();
  });

  describe('the same backend client device asking again', () => {
    it('ask: replaces its own request that still waits, and keeps one row', () => {
      const first = enroll();
      const second = enroll();
      expect(auth.list().map((d) => d.id)).toEqual([second.device.id]);
      expect(store.rows.has(first.device.id)).toBe(false);
      expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: first.device.id }));
      expect(onRemovedByOwner).not.toHaveBeenCalled();
      expect(auth.approve(first.device.id)).toBeNull();
    });

    it('ask: leaves the computer the owner allowed in force until the new request is allowed too', () => {
      const first = enroll();
      auth.approve(first.device.id);
      expect(signIn(first.device.id, first.deviceToken).ok).toBe(true);
      const second = enroll();
      expect(auth.list().map((d) => [d.id, d.status])).toEqual([[first.device.id, 'active'], [second.device.id, 'pending']]);
      expect(signIn(first.device.id, first.deviceToken).ok).toBe(true); // nothing changed without a click
      expect(onRevoked).not.toHaveBeenCalled();

      expect(auth.approve(second.device.id)).toMatchObject({ status: 'active' });
      expect(auth.list().map((d) => d.id)).toEqual([second.device.id]);
      expect(store.rows.has(first.device.id)).toBe(false);
      expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: first.device.id, status: 'revoked' }));
      expect(onRemovedByOwner).not.toHaveBeenCalled(); // replaced, not removed on purpose
      expect(signIn(first.device.id, first.deviceToken).ok).toBe(false);
      expect(signIn(second.device.id, second.deviceToken).ok).toBe(true);
    });

    it('ask: a denied new request leaves the allowed computer alone', () => {
      const first = enroll();
      auth.approve(first.device.id);
      const second = enroll();
      expect(auth.deny(second.device.id)).toBe(true);
      expect(auth.list().map((d) => d.id)).toEqual([first.device.id]);
      expect(signIn(first.device.id, first.deviceToken).ok).toBe(true);
      expect(onRemovedByOwner).not.toHaveBeenCalled();
    });

    it('auto: replaces every earlier record of that client at once', () => {
      const allowed = enroll();
      auth.approve(allowed.device.id);
      const waiting = enroll();
      const fresh = enroll({ approve: 'auto' });
      expect(auth.list().map((d) => d.id)).toEqual([fresh.device.id]);
      expect(store.rows.has(allowed.device.id)).toBe(false);
      expect(store.rows.has(waiting.device.id)).toBe(false);
      expect(onRemovedByOwner).not.toHaveBeenCalled();
    });

    it('never touches another client\'s record, a computer paired by link, or an account phone', () => {
      const otherClient = enroll({ backendDeviceId: OTHER_CLIENT });
      const { code } = auth.createPairingCode();
      const linked = auth.redeem({ code, label: 'Old NUC', platform: 'desktop' })!;
      auth.approve(linked.device.id);
      const phone = auth.enrollActive({ label: 'iPhone', platform: 'ios', accountEmail: 'me@example.com', accountPhoneId: CLIENT });
      signIn(phone.device.id, phone.deviceToken);
      const mine = enroll({ approve: 'auto' });
      expect(auth.list().map((d) => d.id).sort()).toEqual(
        [otherClient.device.id, linked.device.id, phone.device.id, mine.device.id].sort(),
      );
      expect(onRevoked).not.toHaveBeenCalled();
    });
  });

  it('holds at most five account devices waiting (for Allow or a first sign-in) at once', () => {
    for (let i = 0; i < MAX_PROVISIONAL_ACCOUNT_ROWS; i++) {
      enroll({ backendDeviceId: `00000000-0000-4000-8000-00000000000${i}`, approve: i % 2 ? 'ask' : 'auto' });
    }
    expect(auth.waitingAccountCount()).toBe(MAX_PROVISIONAL_ACCOUNT_ROWS);
    expect(() => enroll()).toThrow(TooManyWaitingAccountDevicesError);
    // The same client asking again takes the place of its own waiting request, so it is not counted twice.
    expect(() => enroll({ backendDeviceId: '00000000-0000-4000-8000-000000000001' })).not.toThrow();
    const { code } = auth.createPairingCode();
    expect(auth.redeem({ code, label: 'By link', platform: 'desktop' })).not.toBeNull(); // pairing by link is unaffected
  });

  it('an allowed, signed-in computer no longer counts as waiting', () => {
    const { device, deviceToken } = enroll();
    expect(auth.waitingAccountCount()).toBe(1);
    auth.approve(device.id);
    expect(auth.waitingAccountCount()).toBe(0);
    signIn(device.id, deviceToken);
    expect(auth.waitingAccountCount()).toBe(0);
  });

  it('proves this machine to an active account computer, and gives a pending one the decoy (/identify)', () => {
    const { device, deviceToken } = enroll();
    const nonce = 'c3'.repeat(32);
    const tag = challengeProof(hashSecret(deviceToken), `${WHO_TAG_PREFIX}${nonce}`);
    const real = challengeProof(hashSecret(deviceToken), `${MAC_PROOF_PREFIX}${nonce}:192.168.1.57:3333`);
    expect(auth.macProof(tag, nonce, '192.168.1.57:3333')).not.toBe(real);
    auth.approve(device.id);
    expect(auth.macProof(tag, nonce, '192.168.1.57:3333')).toBe(real);
    expect(auth.macProof(tag, nonce, '192.168.1.66:3333')).not.toBe(real);
  });

  it('tells onRemovedByOwner how the record went: Revoke on this machine, or the computer removing itself', () => {
    const a = enroll({ approve: 'auto' });
    const b = enroll({ approve: 'auto', backendDeviceId: OTHER_CLIENT });
    expect(auth.revoke(a.device.id)).toBe(true);
    const { nonce } = auth.createChallenge(b.device.id);
    expect(auth.unpair(b.device.id, nonce, proofForToken(b.deviceToken, nonce))).toBe(true);
    expect(onRemovedByOwner.mock.calls.map(([d, how]) => [d.accountPhoneId, how])).toEqual([[CLIENT, 'revoke'], [OTHER_CLIENT, 'unpair']]);
  });
});

describe('deviceAuth: records made through the account, and one the account signed out (plan 18 reconcile)', () => {
  const BACKEND_PHONE = '00000000-0000-4000-8000-0000000000b1';
  let store: ReturnType<typeof memoryStore>;
  let onRevoked: ReturnType<typeof vi.fn<(device: MobileDeviceRecord) => void>>;
  let onRemovedByOwner: ReturnType<typeof vi.fn<(device: MobileDeviceRecord, how: 'revoke' | 'unpair') => void>>;
  let auth: ReturnType<typeof createDeviceAuth>;

  beforeEach(() => {
    store = memoryStore();
    onRevoked = vi.fn();
    onRemovedByOwner = vi.fn();
    auth = createDeviceAuth({ store, credentialEpoch: () => 'epoch-1', onRevoked, onRemovedByOwner });
  });

  const linkPaired = () => {
    const { code } = auth.createPairingCode();
    const made = auth.redeem({ code, label: 'By link', platform: 'desktop' })!;
    auth.approve(made.device.id);
    return made;
  };

  it('lists the live records made through the account by their backend device, and never a secret', () => {
    const phone = auth.enrollActive({ label: 'iPhone', platform: 'ios', accountEmail: 'me@example.com', accountPhoneId: BACKEND_PHONE });
    const waiting = auth.enrollComputer({ label: 'MacBook Pro', accountEmail: null, backendDeviceId: CLIENT, approve: 'ask' });
    linkPaired();
    auth.enrollActive({ label: 'No backend id', platform: 'ios', accountEmail: null, accountPhoneId: null });
    const gone = auth.enrollComputer({ label: 'Gone', accountEmail: null, backendDeviceId: OTHER_CLIENT, approve: 'auto' });
    auth.revoke(gone.device.id);
    const records = auth.accountDeviceRecords();
    expect(records).toEqual([
      { id: phone.device.id, label: 'iPhone', platform: 'ios', status: 'active', backendDeviceId: BACKEND_PHONE, accountEmail: 'me@example.com' },
      { id: waiting.device.id, label: 'MacBook Pro', platform: 'desktop', status: 'pending', backendDeviceId: CLIENT, accountEmail: null },
    ]);
    const text = JSON.stringify(records);
    for (const secret of [phone.deviceToken, waiting.deviceToken, phone.device.tokenHash, waiting.device.confirmCode]) expect(text).not.toContain(secret);
  });

  it('revokeSignedOut ends the record like a local Revoke, but never as the owner removing it here', () => {
    const phone = auth.enrollActive({ label: 'iPhone', platform: 'ios', accountEmail: null, accountPhoneId: BACKEND_PHONE });
    expect(auth.revokeSignedOut(phone.device.id)).toBe(true);
    expect(store.rows.get(phone.device.id)).toMatchObject({ status: 'revoked' });
    expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: phone.device.id, status: 'revoked' }));
    expect(onRemovedByOwner).not.toHaveBeenCalled();
    const { nonce } = auth.createChallenge(phone.device.id);
    expect(auth.exchange(phone.device.id, nonce, proofForToken(phone.deviceToken, nonce))).toEqual({ ok: false, reason: 'revoked' });
    expect(auth.revokeSignedOut(phone.device.id)).toBe(false); // once
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it('revokeSignedOut refuses any record that was not made through the account, whatever it carries', () => {
    const link = linkPaired();
    expect(auth.revokeSignedOut(link.device.id)).toBe(false);
    store.rows.set(link.device.id, { ...store.rows.get(link.device.id)!, accountPhoneId: BACKEND_PHONE }); // still origin 'code'
    expect(auth.revokeSignedOut(link.device.id)).toBe(false);
    const noBackendId = auth.enrollActive({ label: 'Old', platform: 'ios', accountEmail: null, accountPhoneId: null });
    expect(auth.revokeSignedOut(noBackendId.device.id)).toBe(false);
    expect(auth.revokeSignedOut('00000000-0000-4000-8000-00000000dead')).toBe(false);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(auth.accountDeviceRecords()).toEqual([]);
  });
});

describe('removing an account computer (accountComputerRemoval.ts)', () => {
  const record = (over: Partial<MobileDeviceRecord> = {}): MobileDeviceRecord => ({
    id: 'r1', label: 'MacBook Pro', platform: 'desktop', tokenHash: 'h', status: 'revoked', confirmCode: '000000',
    beCodeRef: null, beCodeRefMacBound: false, credentialEpoch: null, origin: 'account', accountEmail: 'me@example.com',
    accountPhoneId: CLIENT, createdAt: 1, approvedAt: 2, lastSeenAt: 3, revokedAt: 4, ...over,
  });

  it('keeps out a computer the owner revoked on this machine', () => {
    const denied = new Set<string>();
    const handler = createAccountComputerRemovedHandler({ denyList: { has: (id) => denied.has(id), add: (id) => void denied.add(id) }, warn: vi.fn() });
    handler(record(), 'revoke');
    expect([...denied]).toEqual([CLIENT]);
  });

  it('does not keep out a computer that removed itself: its owner may connect it again', () => {
    const add = vi.fn();
    const handler = createAccountComputerRemovedHandler({ denyList: { has: () => false, add }, warn: vi.fn() });
    handler(record(), 'unpair');
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    ['a computer paired by link', { origin: 'code' as const, accountPhoneId: null }],
    ['an account phone', { platform: 'ios' as const }],
    ['a record with no backend id', { accountPhoneId: null }],
  ])('ignores %s', (_label, over) => {
    const add = vi.fn();
    const handler = createAccountComputerRemovedHandler({ denyList: { has: () => false, add }, warn: vi.fn() });
    handler(record(over), 'revoke');
    expect(add).not.toHaveBeenCalled();
  });

  it('warns, without the id, when the deny list cannot be written', () => {
    const warn = vi.fn();
    const handler = createAccountComputerRemovedHandler({
      denyList: { has: () => false, add: () => { throw new Error('disk full'); } }, warn,
    });
    expect(() => handler(record(), 'revoke')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(CLIENT);
  });

  it('the account PHONE handler never acts on a computer: it is not signed out of AASC Cloud and not denied there', async () => {
    const add = vi.fn();
    const revokeBackendDevice = vi.fn(async () => {});
    const phoneHandler = createAccountPhoneRevokedHandler({ denyList: { has: () => false, add }, revokeBackendDevice, warn: vi.fn() });
    phoneHandler(record());
    await Promise.resolve();
    expect(revokeBackendDevice).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    phoneHandler(record({ platform: 'ios' }));
    await Promise.resolve();
    expect(revokeBackendDevice).toHaveBeenCalledWith(CLIENT);
    expect(add).toHaveBeenCalledWith(CLIENT);
  });
});
