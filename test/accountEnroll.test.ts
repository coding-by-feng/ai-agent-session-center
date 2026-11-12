// test/accountEnroll.test.ts — plan 17: a phone signed into the account enrolls with this Mac, no Allow click.
//
// Order (each step stops the next): no cloud connection, or one that is not the ticket's Mac → 'not-this-mac'
// (no backend call, whatever the settings); phone pairing or the setting off → 'off'; five phones still waiting
// for their first sign-in → 'busy'; the route's strike hook; the backend redeems the ticket; a phone the owner
// removed (deny list) → 'phone-revoked'; the phone's key must hash to the ticket's; then an ACTIVE record named by
// the backend, and its token sealed to the phone's key, keyed with the ticket's sealSecret, with the address the
// phone dialled in the AEAD's associated data.
//
// The seal is decrypted here with WebCrypto (globalThis.crypto.subtle), exactly as the phone does, to pin the
// two implementations together; a different address, nonce, key or sealSecret must fail.
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAccountEnroll, type AccountEnrollDeps, type AccountEnrollInput } from '../server/mobile/accountEnroll.js';
import { EnrollRedeemError, type RedeemedEnrollTicket } from '../server/cloud/enroll.js';
import {
  createDeviceAuth, hashSecret, proofForToken, PROVISIONAL_ACCOUNT_TTL_MS, type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

const subtle = globalThis.crypto.subtle;
const MAC_DEVICE = '00000000-0000-4000-8000-0000000000aa';
const OTHER_MAC = '00000000-0000-4000-8000-0000000000bb';
const PHONE_DEVICE = '00000000-0000-4000-8000-0000000000cc';
const TICKET = 'k'.repeat(43);
const NONCE = 'a1'.repeat(32);
const REACHED_AT = '192.168.1.57:3333';

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

const b64u = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** The phone's ephemeral key pair, made with WebCrypto as the shell makes it. */
async function phoneKeyPair(): Promise<{ privateKey: CryptoKey; phoneKey: string; raw: Uint8Array; keyHash: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, phoneKey: b64u(raw), raw, keyHash: createHash('sha256').update(raw).digest('hex') };
}

/** The phone's side of the seal, in WebCrypto only (the shell's enrollCrypto mirrors this). */
async function openSeal(
  answer: { macKey: string; iv: string; sealed: string },
  phone: { privateKey: CryptoKey; raw: Uint8Array },
  sealSecret: string,
  nonce: string,
  dialled: string,
): Promise<unknown> {
  const macRaw = fromB64u(answer.macKey);
  const macPub = await subtle.importKey('raw', macRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: macPub }, phone.privateKey, 256));
  const hkdf = await subtle.importKey('raw', concat(shared, fromB64u(sealSecret)), 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8('aasc-enroll-v1'), phone.raw, macRaw) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(answer.iv), additionalData: utf8(`aasc-enroll-v1:${nonce}:${dialled}`), tagLength: 128 },
    key,
    fromB64u(answer.sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

describe('createAccountEnroll', () => {
  let store: ReturnType<typeof memoryStore>;
  let auth: ReturnType<typeof createDeviceAuth>;
  let t: number;
  let enabled: boolean;
  let offered: boolean;
  let password: boolean;
  let connection: { deviceId: string; accountEmail?: string } | null;
  let state: 'connected' | 'offline' | 'revoked' | 'disconnected';
  let denied: Set<string>;
  let sealSecret: string;
  let redeem: ReturnType<typeof vi.fn<(ticket: string) => Promise<RedeemedEnrollTicket>>>;
  let phone: Awaited<ReturnType<typeof phoneKeyPair>>;
  let info: ReturnType<typeof vi.fn>;

  function make(overrides: Partial<AccountEnrollDeps> = {}) {
    return createAccountEnroll({
      enabled: () => enabled,
      pairingOffered: () => offered,
      passwordEnabled: () => password,
      cloudStatus: () => (connection ? { connection, state } : { connection: null, state: 'disconnected' }),
      redeem,
      deviceAuth: auth,
      denyList: { has: (id) => denied.has(id) },
      info,
      ...overrides,
    });
  }

  function input(overrides: Partial<AccountEnrollInput> = {}): AccountEnrollInput {
    return {
      macDeviceId: MAC_DEVICE,
      ticket: TICKET,
      phoneKey: phone.phoneKey,
      nonce: NONCE,
      label: 'Label from the body',
      platform: 'ios',
      reachedAt: REACHED_AT,
      ...overrides,
    };
  }

  const redeemed = (over: Partial<RedeemedEnrollTicket> = {}): RedeemedEnrollTicket => ({
    phoneDeviceId: PHONE_DEVICE, phoneName: 'Kason’s iPhone', email: 'me@example.com', phoneKeyHash: phone.keyHash,
    sealSecret, ...over,
  });

  beforeEach(async () => {
    store = memoryStore();
    t = 1_000_000;
    auth = createDeviceAuth({ store, now: () => t, credentialEpoch: () => 'epoch-1' });
    enabled = true;
    offered = true;
    password = true;
    connection = { deviceId: MAC_DEVICE, accountEmail: 'me@example.com' };
    state = 'connected';
    denied = new Set();
    sealSecret = randomBytes(32).toString('base64url');
    phone = await phoneKeyPair();
    info = vi.fn();
    redeem = vi.fn(async () => redeemed());
  });

  it('enrolls an active phone and seals its token so the phone can open it with WebCrypto', async () => {
    const out = await make().enroll(input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(redeem).toHaveBeenCalledWith(TICKET);
    expect(out.answer.macKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(fromB64u(out.answer.macKey)[0]).toBe(0x04);
    expect(out.answer.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const opened = (await openSeal(out.answer, phone, sealSecret, NONCE, REACHED_AT)) as { deviceId: string; deviceToken: string };
    expect(Object.keys(opened).sort()).toEqual(['deviceId', 'deviceToken']);
    const rec = store.rows.get(opened.deviceId)!;
    expect(rec).toMatchObject({
      status: 'active', origin: 'account', accountEmail: 'me@example.com', accountPhoneId: PHONE_DEVICE,
      platform: 'ios', credentialEpoch: 'epoch-1',
    });
    expect(rec.approvedAt).toBeTypeOf('number');
    expect(rec.tokenHash).toBe(hashSecret(opened.deviceToken));
    expect(out.device).toMatchObject({ id: opened.deviceId, origin: 'account', accountEmail: 'me@example.com' });
    const { nonce } = auth.createChallenge(opened.deviceId);
    expect(auth.exchange(opened.deviceId, nonce, proofForToken(opened.deviceToken, nonce)).ok).toBe(true);
  });

  it('names the phone by the backend\'s phone name, never the body\'s label', async () => {
    redeem.mockResolvedValueOnce(redeemed({ phoneName: '  Kason’s\u0007 iPhone ' }));
    const out = await make().enroll(input({ label: 'Totally the Mac admin' }));
    expect(out.ok && out.device.label).toBe('Kason’s iPhone');
  });

  it('falls back to "Phone" when the backend\'s name is empty', async () => {
    redeem.mockResolvedValueOnce(redeemed({ phoneName: '' }));
    const out = await make().enroll(input());
    expect(out.ok && out.device.label).toBe('Phone');
  });

  it.each([
    ['a different address in the AAD (a relay the phone dialled)', { dialled: '192.168.1.66:3333' }],
    ['a different nonce', { nonce: 'b2'.repeat(32) }],
    ['a different sealSecret (a box that only saw the phone\'s public key)', { secret: randomBytes(32).toString('base64url') }],
  ])('fails to open with %s', async (_label, change: { dialled?: string; nonce?: string; secret?: string }) => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    await expect(openSeal(out.answer, phone, change.secret ?? sealSecret, change.nonce ?? NONCE, change.dialled ?? REACHED_AT))
      .rejects.toThrow();
  });

  it('fails to open with another phone\'s key', async () => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    const stranger = await phoneKeyPair();
    await expect(openSeal(out.answer, stranger, sealSecret, NONCE, REACHED_AT)).rejects.toThrow();
  });

  it('binds both public keys into the key (info): the same secrets under another phone key fail', async () => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    // Same private key, but a lie about which public key was sent: the info differs, so the key does.
    const other = await phoneKeyPair();
    await expect(openSeal(out.answer, { privateKey: phone.privateKey, raw: other.raw }, sealSecret, NONCE, REACHED_AT))
      .rejects.toThrow();
  });

  it('uses a fresh Mac key and iv every time', async () => {
    const a = await make().enroll(input());
    const b = await make().enroll(input());
    if (!a.ok || !b.ok) throw new Error('expected success');
    expect(a.answer.macKey).not.toBe(b.answer.macKey);
    expect(a.answer.iv).not.toBe(b.answer.iv);
  });

  it.each([
    ['the setting is off', () => { enabled = false; }],
    ['phone pairing is off', () => { offered = false; }],
  ])('says off, and calls nothing, when %s', async (_label, arrange) => {
    arrange();
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'off' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it.each([
    ['no cloud connection', () => { connection = null; }],
    ['a connection that is another Mac', () => { connection = { deviceId: OTHER_MAC }; }],
    ['another Mac, even with the setting off', () => { connection = { deviceId: OTHER_MAC }; enabled = false; }],
  ])('says not-this-mac with %s, without calling the backend or striking', async (_label, arrange) => {
    arrange();
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'not-this-mac' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
  });

  it('calls beforeRedeem once, after the local checks and before the backend', async () => {
    const order: string[] = [];
    redeem.mockImplementationOnce(async () => { order.push('redeem'); return redeemed(); });
    await make().enroll(input(), { beforeRedeem: () => order.push('strike') });
    expect(order).toEqual(['strike', 'redeem']);
  });

  it.each(['invalid', 'expired', 'used', 'phone-revoked', 'cloud-failed'] as const)(
    'passes the backend\'s %s through and keeps no record',
    async (reason) => {
      redeem.mockRejectedValueOnce(new EnrollRedeemError(reason));
      expect(await make().enroll(input())).toEqual({ ok: false, reason });
      expect(store.rows.size).toBe(0);
    },
  );

  it('reads any other redeem failure as cloud-failed', async () => {
    redeem.mockRejectedValueOnce(new Error('boom'));
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'cloud-failed' });
  });

  it('refuses a phone the owner removed (deny list) as phone-revoked, and keeps no record', async () => {
    denied.add(PHONE_DEVICE);
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'phone-revoked' });
    expect(store.rows.size).toBe(0);
  });

  it('refuses a phone key that does not hash to the ticket\'s (a relay swapped keys)', async () => {
    const relay = await phoneKeyPair();
    expect(await make().enroll(input({ phoneKey: relay.phoneKey }))).toEqual({ ok: false, reason: 'invalid' });
    expect(store.rows.size).toBe(0);
  });

  it('refuses a key that is not a P-256 point, even when it hashes right, and keeps no record', async () => {
    const bogus = new Uint8Array(65).fill(7);
    bogus[0] = 4;
    redeem.mockResolvedValueOnce(redeemed({ phoneKeyHash: createHash('sha256').update(bogus).digest('hex') }));
    expect(await make().enroll(input({ phoneKey: b64u(bogus) }))).toEqual({ ok: false, reason: 'invalid' });
    expect(store.rows.size).toBe(0);
  });

  it('says busy, before the backend, while five enrolled phones still wait for their first sign-in', async () => {
    for (let i = 0; i < 5; i++) {
      redeem.mockResolvedValueOnce(redeemed({ phoneDeviceId: `00000000-0000-4000-8000-00000000000${i}` }));
      expect((await make().enroll(input())).ok).toBe(true);
    }
    redeem.mockClear();
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'busy' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
    t += PROVISIONAL_ACCOUNT_TTL_MS + 1; // they never signed in: swept
    expect((await make().enroll(input())).ok).toBe(true);
    expect(store.rows.size).toBe(1);
  });

  it('records a null email when the account has none', async () => {
    redeem.mockResolvedValueOnce(redeemed({ email: null }));
    const out = await make().enroll(input());
    expect(out.ok && out.device.accountEmail).toBeNull();
  });

  it('logs the paired phone, never the email, ticket, key, nonce, secret or token', async () => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    const opened = (await openSeal(out.answer, phone, sealSecret, NONCE, REACHED_AT)) as { deviceToken: string };
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Kason’s iPhone');
    for (const secret of ['me@example.com', TICKET, phone.phoneKey, NONCE, sealSecret, opened.deviceToken, out.answer.sealed]) {
      expect(logged).not.toContain(secret);
    }
  });

  describe('status', () => {
    it('is enabled, available and names the account while connected', () => {
      expect(make().status()).toEqual({ enabled: true, available: true, email: 'me@example.com', blocked: null });
    });

    it('stays available while offline (restored, not yet checked)', () => {
      state = 'offline';
      expect(make().status()).toMatchObject({ available: true, blocked: null });
    });

    it('is unavailable with no connection or a revoked one', () => {
      state = 'revoked';
      expect(make().status()).toEqual({ enabled: true, available: false, email: 'me@example.com', blocked: 'no-cloud' });
      connection = null;
      expect(make().status()).toEqual({ enabled: true, available: false, email: null, blocked: 'no-cloud' });
    });

    it('is unavailable without a dashboard password', () => {
      password = false;
      expect(make().status()).toMatchObject({ available: false, blocked: 'no-password' });
    });

    it('is off and blocked while phone pairing is off, whatever the setting says', () => {
      offered = false;
      expect(make().status()).toMatchObject({ enabled: false, blocked: 'pairing-off' });
    });

    it('shows the setting off', () => {
      enabled = false;
      expect(make().status()).toMatchObject({ enabled: false, blocked: null });
    });

    it('says no-cloud first for a Mac not signed into AASC Cloud, whatever else is off: the desktop then shows no account UI', () => {
      connection = null;
      password = false;
      offered = false;
      expect(make().status()).toMatchObject({ available: false, blocked: 'no-cloud' });
      connection = { deviceId: MAC_DEVICE, accountEmail: 'me@example.com' };
      state = 'disconnected';
      expect(make().status()).toMatchObject({ blocked: 'no-cloud' });
    });

    it('names pairing-off before no-password for a signed-in Mac', () => {
      password = false;
      offered = false;
      expect(make().status()).toMatchObject({ blocked: 'pairing-off' });
      offered = true;
      expect(make().status()).toMatchObject({ blocked: 'no-password' });
    });

    it('has no email from a Mac joined with a pairing code', () => {
      connection = { deviceId: MAC_DEVICE };
      expect(make().status()).toEqual({ enabled: true, available: true, email: null, blocked: null });
    });
  });
});
