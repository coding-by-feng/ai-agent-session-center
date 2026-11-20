// test/computerEnroll.test.ts — plan 18, stage 2: a computer signed into the account connects without a link.
//
// Order (each step stops the next, mirroring accountEnroll.ts): no cloud connection, or one that is not the
// ticket's machine → 'not-this-machine' (no backend call, whatever the settings); not offered here → 'off';
// five account devices still waiting → 'busy'; the route's strike hook; the backend redeems the ticket; a
// client that is a phone, or whose key does not hash to the ticket's → 'invalid'; only then, to the key the
// ticket was made for, a client the owner revoked here (deny list) → 'client-revoked'; then a computer record
// (pending with a confirm code, or active when the owner chose "connect without asking"), and its token sealed
// to the client's key, keyed with the ticket's sealSecret, with the address the client dialled in the AEAD's
// associated data.
//
// The seal is opened here with WebCrypto, exactly as the client does, to pin the two implementations together.
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ACCESS_SEAL_INFO, createComputerEnroll, type ComputerEnrollDeps, type ComputerEnrollInput,
} from '../server/mobile/computerEnroll.js';
import { MachineRedeemError, type RedeemedMachineTicket } from '../server/cloud/machines.js';
import {
  createDeviceAuth, hashSecret, proofForToken, TooManyWaitingAccountDevicesError, type MobileDeviceRecord,
  type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

const subtle = globalThis.crypto.subtle;
const MACHINE = '00000000-0000-4000-8000-0000000000aa';
const OTHER_MACHINE = '00000000-0000-4000-8000-0000000000bb';
const CLIENT = '00000000-0000-4000-8000-0000000000cc';
const TICKET = 'k'.repeat(43);
const NONCE = 'a1'.repeat(32);
const BOUND = '192.168.1.57:3333';

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

/** The client's ephemeral key pair, made with WebCrypto. */
async function clientKeyPair(): Promise<{ privateKey: CryptoKey; clientKey: string; raw: Uint8Array; keyHash: string }> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, clientKey: b64u(raw), raw, keyHash: createHash('sha256').update(raw).digest('hex') };
}

/** The client's side of the seal, in WebCrypto only: CONTRACT.md section B, to the letter. */
async function openSeal(
  answer: { machineKey: string; iv: string; sealed: string },
  client: { privateKey: CryptoKey; raw: Uint8Array },
  sealSecret: string,
  nonce: string,
  dialled: string,
  domain = 'aasc-access-v1',
): Promise<unknown> {
  const machineRaw = fromB64u(answer.machineKey);
  const machinePub = await subtle.importKey('raw', machineRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: machinePub }, client.privateKey, 256));
  const hkdf = await subtle.importKey('raw', concat(shared, fromB64u(sealSecret)), 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8(domain), client.raw, machineRaw) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(answer.iv), additionalData: utf8(`${domain}:${nonce}:${dialled}`), tagLength: 128 },
    key,
    fromB64u(answer.sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

interface Opened { deviceId: string; deviceToken: string; status: 'pending' | 'active'; confirmCode: string | null }

describe('createComputerEnroll', () => {
  let store: ReturnType<typeof memoryStore>;
  let auth: ReturnType<typeof createDeviceAuth>;
  let t: number;
  let offered: boolean;
  let mode: 'ask' | 'auto';
  let connection: { deviceId: string; accountEmail?: string } | null;
  let denied: Set<string>;
  let sealSecret: string;
  let redeem: ReturnType<typeof vi.fn<(ticket: string) => Promise<RedeemedMachineTicket>>>;
  let client: Awaited<ReturnType<typeof clientKeyPair>>;
  let info: ReturnType<typeof vi.fn>;

  function make(overrides: Partial<ComputerEnrollDeps> = {}) {
    return createComputerEnroll({
      offered: () => offered,
      mode: () => mode,
      cloudStatus: () => (connection ? { connection, state: 'connected' } : { connection: null, state: 'disconnected' }),
      redeem,
      deviceAuth: auth,
      denyList: { has: (id) => denied.has(id) },
      info,
      ...overrides,
    });
  }

  function input(overrides: Partial<ComputerEnrollInput> = {}): ComputerEnrollInput {
    return { machineId: MACHINE, ticket: TICKET, clientKey: client.clientKey, nonce: NONCE, boundAddress: BOUND, ...overrides };
  }

  const redeemed = (over: Partial<RedeemedMachineTicket> = {}): RedeemedMachineTicket => ({
    clientDeviceId: CLIENT, clientName: 'Kason’s MacBook Pro', clientKind: 'server', email: 'me@example.com',
    clientKeyHash: client.keyHash, sealSecret, ...over,
  });

  beforeEach(async () => {
    store = memoryStore();
    t = 1_000_000;
    auth = createDeviceAuth({ store, now: () => t, credentialEpoch: () => 'epoch-1' });
    offered = true;
    mode = 'ask';
    connection = { deviceId: MACHINE, accountEmail: 'me@example.com' };
    denied = new Set();
    sealSecret = randomBytes(32).toString('base64url');
    client = await clientKeyPair();
    info = vi.fn();
    redeem = vi.fn(async () => redeemed());
  });

  it('uses its own domain string', () => {
    expect(ACCESS_SEAL_INFO).toBe('aasc-access-v1');
  });

  it('ask: makes a pending computer and seals its token, status and confirm code for the client', async () => {
    const out = await make().enroll(input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(redeem).toHaveBeenCalledWith(TICKET);
    expect(out.answer.machineKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(fromB64u(out.answer.machineKey)[0]).toBe(0x04);
    expect(out.answer.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Object.keys(out.answer).sort()).toEqual(['iv', 'machineKey', 'sealed']);

    const opened = (await openSeal(out.answer, client, sealSecret, NONCE, BOUND)) as Opened;
    expect(Object.keys(opened).sort()).toEqual(['confirmCode', 'deviceId', 'deviceToken', 'status']);
    expect(opened.status).toBe('pending');
    expect(opened.confirmCode).toMatch(/^\d{6}$/);
    const rec = store.rows.get(opened.deviceId)!;
    expect(rec).toMatchObject({
      status: 'pending', platform: 'desktop', origin: 'account', accountEmail: 'me@example.com', accountPhoneId: CLIENT,
      label: 'Kason’s MacBook Pro', confirmCode: opened.confirmCode, credentialEpoch: 'epoch-1', approvedAt: null,
    });
    expect(rec.tokenHash).toBe(hashSecret(opened.deviceToken));
    expect(out.device).toMatchObject({ id: opened.deviceId, status: 'pending', origin: 'account', platform: 'desktop' });

    const first = auth.createChallenge(opened.deviceId);
    expect(auth.exchange(opened.deviceId, first.nonce, proofForToken(opened.deviceToken, first.nonce)))
      .toEqual({ ok: false, reason: 'pending' });
    expect(auth.approve(opened.deviceId)).not.toBeNull();
    const second = auth.createChallenge(opened.deviceId);
    expect(auth.exchange(opened.deviceId, second.nonce, proofForToken(opened.deviceToken, second.nonce)).ok).toBe(true);
  });

  it('auto: makes an active computer, sealed with status active and no confirm code', async () => {
    mode = 'auto';
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    const opened = (await openSeal(out.answer, client, sealSecret, NONCE, BOUND)) as Opened;
    expect(opened).toMatchObject({ status: 'active', confirmCode: null });
    expect(store.rows.get(opened.deviceId)).toMatchObject({ status: 'active', platform: 'desktop', origin: 'account' });
    const { nonce } = auth.createChallenge(opened.deviceId);
    expect(auth.exchange(opened.deviceId, nonce, proofForToken(opened.deviceToken, nonce)).ok).toBe(true);
  });

  it('names the computer by the backend\'s client name, or "Computer"', async () => {
    redeem.mockResolvedValueOnce(redeemed({ clientName: '  Mac\u0007 mini ' }));
    const named = await make().enroll(input());
    expect(named.ok && named.device.label).toBe('Mac mini');
    redeem.mockResolvedValueOnce(redeemed({ clientName: '', clientDeviceId: '00000000-0000-4000-8000-0000000000dd' }));
    const unnamed = await make().enroll(input());
    expect(unnamed.ok && unnamed.device.label).toBe('Computer');
  });

  it.each([
    ['a different address in the AAD (a relay the client dialled)', { dialled: '192.168.1.66:3333' }],
    ['a different nonce', { nonce: 'b2'.repeat(32) }],
    ['a different sealSecret (a box that only saw the client\'s public key)', { secret: randomBytes(32).toString('base64url') }],
    ['plan 17\'s domain string (a phone enroll answer is never a computer\'s)', { domain: 'aasc-enroll-v1' }],
  ])('fails to open with %s', async (_label, change: { dialled?: string; nonce?: string; secret?: string; domain?: string }) => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    await expect(openSeal(
      out.answer, client, change.secret ?? sealSecret, change.nonce ?? NONCE, change.dialled ?? BOUND, change.domain,
    )).rejects.toThrow();
  });

  it('fails to open with another client\'s key, and with a lie about which public key was sent', async () => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    const stranger = await clientKeyPair();
    await expect(openSeal(out.answer, stranger, sealSecret, NONCE, BOUND)).rejects.toThrow();
    await expect(openSeal(out.answer, { privateKey: client.privateKey, raw: stranger.raw }, sealSecret, NONCE, BOUND))
      .rejects.toThrow();
  });

  it('binds the answer to the address it was given, such as the published public one behind a port forward', async () => {
    const out = await make().enroll(input({ boundAddress: '45.63.31.79:3333' }));
    if (!out.ok) throw new Error('expected success');
    await expect(openSeal(out.answer, client, sealSecret, NONCE, '45.63.31.79:3333')).resolves.toBeTruthy();
    await expect(openSeal(out.answer, client, sealSecret, NONCE, BOUND)).rejects.toThrow();
  });

  it('uses a fresh machine key and iv every time', async () => {
    const a = await make().enroll(input());
    const b = await make().enroll(input());
    if (!a.ok || !b.ok) throw new Error('expected success');
    expect(a.answer.machineKey).not.toBe(b.answer.machineKey);
    expect(a.answer.iv).not.toBe(b.answer.iv);
  });

  it('says off, and calls nothing, when account computers are not offered here', async () => {
    offered = false;
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'off' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it.each([
    ['no cloud connection', () => { connection = null; }],
    ['a connection that is another machine', () => { connection = { deviceId: OTHER_MACHINE }; }],
    ['another machine, even when not offered', () => { connection = { deviceId: OTHER_MACHINE }; offered = false; }],
  ])('says not-this-machine with %s, without calling the backend or striking', async (_label, arrange) => {
    arrange();
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'not-this-machine' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
  });

  it('says not-this-machine with no connector at all', async () => {
    expect(await make({ cloudStatus: () => null }).enroll(input())).toEqual({ ok: false, reason: 'not-this-machine' });
    expect(redeem).not.toHaveBeenCalled();
  });

  it('calls beforeRedeem once, after the local checks and before the backend', async () => {
    const order: string[] = [];
    redeem.mockImplementationOnce(async () => { order.push('redeem'); return redeemed(); });
    await make().enroll(input(), { beforeRedeem: () => order.push('strike') });
    expect(order).toEqual(['strike', 'redeem']);
  });

  it.each(['invalid', 'expired', 'used', 'client-revoked', 'cloud-failed'] as const)(
    'passes the backend\'s %s through and keeps no record',
    async (reason) => {
      redeem.mockRejectedValueOnce(new MachineRedeemError(reason));
      expect(await make().enroll(input())).toEqual({ ok: false, reason });
      expect(store.rows.size).toBe(0);
    },
  );

  it('reads any other redeem failure as cloud-failed', async () => {
    redeem.mockRejectedValueOnce(new Error('boom'));
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'cloud-failed' });
  });

  it('refuses a client the owner revoked here (deny list) as client-revoked, and keeps no record', async () => {
    denied.add(CLIENT);
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'client-revoked' });
    expect(store.rows.size).toBe(0);
  });

  it('tells only the key the ticket was made for that its client was revoked: a swapped key on that ticket learns nothing', async () => {
    denied.add(CLIENT);
    const relay = await clientKeyPair();
    expect(await make().enroll(input({ clientKey: relay.clientKey }))).toEqual({ ok: false, reason: 'invalid' });
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'client-revoked' });
    expect(store.rows.size).toBe(0);
  });

  it('and a key that is no P-256 point, on a revoked client\'s ticket, is invalid too', async () => {
    denied.add(CLIENT);
    const bogus = new Uint8Array(65).fill(7);
    bogus[0] = 4;
    redeem.mockResolvedValueOnce(redeemed({ clientKeyHash: createHash('sha256').update(bogus).digest('hex') }));
    expect(await make().enroll(input({ clientKey: b64u(bogus) }))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a phone: a phone is never given a computer\'s reach', async () => {
    redeem.mockResolvedValueOnce(redeemed({ clientKind: 'phone' }));
    expect(await make().enroll(input())).toEqual({ ok: false, reason: 'invalid' });
    expect(store.rows.size).toBe(0);
  });

  it('accepts a client whose kind the backend does not record', async () => {
    redeem.mockResolvedValueOnce(redeemed({ clientKind: null }));
    expect((await make().enroll(input())).ok).toBe(true);
  });

  it('refuses a client key that does not hash to the ticket\'s (a relay swapped keys)', async () => {
    const relay = await clientKeyPair();
    expect(await make().enroll(input({ clientKey: relay.clientKey }))).toEqual({ ok: false, reason: 'invalid' });
    expect(store.rows.size).toBe(0);
  });

  it('refuses a key that is not a P-256 point, even when it hashes right, and keeps no record', async () => {
    const bogus = new Uint8Array(65).fill(7);
    bogus[0] = 4;
    redeem.mockResolvedValueOnce(redeemed({ clientKeyHash: createHash('sha256').update(bogus).digest('hex') }));
    expect(await make().enroll(input({ clientKey: b64u(bogus) }))).toEqual({ ok: false, reason: 'invalid' });
    expect(store.rows.size).toBe(0);
  });

  it('says busy, before the backend, while five account devices still wait', async () => {
    for (let i = 0; i < 5; i++) {
      redeem.mockResolvedValueOnce(redeemed({ clientDeviceId: `00000000-0000-4000-8000-00000000000${i}` }));
      expect((await make().enroll(input())).ok).toBe(true);
    }
    redeem.mockClear();
    const beforeRedeem = vi.fn();
    expect(await make().enroll(input(), { beforeRedeem })).toEqual({ ok: false, reason: 'busy' });
    expect(redeem).not.toHaveBeenCalled();
    expect(beforeRedeem).not.toHaveBeenCalled();
  });

  it('says busy when the record cannot be made after the redeem (the slots filled meanwhile)', async () => {
    const enrollComputer = vi.fn(() => { throw new TooManyWaitingAccountDevicesError(); });
    const out = await make({ deviceAuth: { enrollComputer, waitingAccountCount: () => 0 } }).enroll(input());
    expect(out).toEqual({ ok: false, reason: 'busy' });
  });

  it('records a null email when the account has none', async () => {
    redeem.mockResolvedValueOnce(redeemed({ email: null }));
    const out = await make().enroll(input());
    expect(out.ok && out.device.accountEmail).toBeNull();
  });

  it('a second request by the same client leaves one waiting record', async () => {
    const first = await make().enroll(input());
    const second = await make().enroll(input());
    if (!first.ok || !second.ok) throw new Error('expected success');
    expect(auth.list().map((d) => d.id)).toEqual([second.device.id]);
  });

  it('logs the computer and how it stands, never the email, ticket, key, nonce, secret, token or confirm code', async () => {
    const out = await make().enroll(input());
    if (!out.ok) throw new Error('expected success');
    const opened = (await openSeal(out.answer, client, sealSecret, NONCE, BOUND)) as Opened;
    const logged = info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('Kason’s MacBook Pro');
    expect(logged).toContain('pending');
    for (const secret of [
      'me@example.com', TICKET, client.clientKey, NONCE, sealSecret, opened.deviceToken, out.answer.sealed, opened.confirmCode!,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
