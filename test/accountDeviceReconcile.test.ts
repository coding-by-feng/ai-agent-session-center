// test/accountDeviceReconcile.test.ts — plan 18: "Sign out that device" must mean it on every machine.
//
// Signing a device out of the AASC Cloud account ends its account sign-in, but a phone or computer that connected
// to this machine THROUGH the account holds a key of its own here. So this machine drops such a record once the
// account has signed its backend device out: only on positive, exact, validated proof (a COMPLETE read of the
// account's device list that shows that very backend device id with `revokedAt` set), or at once when the
// sign-out was made on this machine.
//
// What must be impossible by construction (Nov 17 2026: a read error taken for "gone" wiped a phone's pairings):
// dropping anything on absence, on a failed, partial, capped or unreadable read, with no usable connection, or a
// record that was paired by link or QR. Fake cloud client throughout: no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudError, type CloudClient, type CloudConnector, type CloudStatus } from '../server/cloud/types.js';
import { MAX_DEVICE_PAGES, readRevokedAccountDevices } from '../server/cloud/devices.js';
import type { CloudConnection } from '../src/types/cloud.js';
import {
  createAccountDeviceReconcile, RECONCILE_EVERY_MS, withAccountDeviceReconcile, type AccountDeviceReconcile,
} from '../server/mobile/accountDeviceReconcile.js';
import { createAccountPhoneRevokedHandler } from '../server/mobile/accountPhoneRevocation.js';
import { createAccountComputerRemovedHandler } from '../server/mobile/accountComputerRemoval.js';
import {
  createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

const PHONE = '00000000-0000-4000-8000-0000000000a1';
const COMPUTER = '00000000-0000-4000-8000-0000000000a2';
const OTHER = '00000000-0000-4000-8000-0000000000a3';
const AT = '2026-11-20T01:02:03.000Z';

const connection = (over: Partial<CloudConnection> = {}): CloudConnection => ({
  backendOrigin: 'https://backend.example', accountId: '00000000-0000-4000-8000-0000000000f1',
  deviceId: '00000000-0000-4000-8000-0000000000d1', deviceName: 'Mac mini', generation: 1,
  accountEmail: 'me@example.com', ...over,
});
const signedIn = (state: CloudStatus['state'] = 'connected', over: Partial<CloudConnection> = {}): CloudStatus =>
  ({ connection: connection(over), state, lastError: null });
const signedOut: CloudStatus = { connection: null, state: 'disconnected', lastError: null };

/** A device as the backend lists it; `revokedAt` set means the account signed it out. */
const row = (id: string, revokedAt: string | null = null, over: Record<string, unknown> = {}) => ({
  id, name: 'A device', kind: 'phone', createdByCode: null, createdAt: AT, lastUsedAt: null, revokedAt, scopes: [], ...over,
});
const page = (devices: unknown[], nextCursor: string | null = null) => ({ devices, nextCursor });

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

const reconcilers: AccountDeviceReconcile[] = [];
afterEach(() => {
  for (const reconcile of reconcilers.splice(0)) reconcile.stop();
  vi.useRealTimers();
});

/** This machine: real device records, the two "owner removed it" handlers wired as the server wires them, a fake cloud. */
function setUp(over: { status?: CloudStatus; reply?: (path: string, nth: number) => unknown } = {}) {
  const state = {
    status: over.status ?? signedIn(),
    reply: over.reply ?? (() => page([row(PHONE, AT), row(COMPUTER, AT)])),
  };
  const calls: string[] = [];
  const client: CloudClient = {
    request: (async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return state.reply(path, calls.length);
    }) as CloudClient['request'],
  };
  const store = memoryStore();
  const onRevoked = vi.fn<(device: MobileDeviceRecord) => void>();
  /** The deny list and the backend revoke that a LOCAL Revoke would use: neither may be touched here. */
  const denied = { add: vi.fn<(id: string) => void>(), has: () => false };
  const revokeBackendDevice = vi.fn(async () => {});
  const warn = vi.fn();
  const phoneRemoved = createAccountPhoneRevokedHandler({ denyList: denied, revokeBackendDevice, warn });
  const computerRemoved = createAccountComputerRemovedHandler({ denyList: denied, warn });
  const auth = createDeviceAuth({
    store, credentialEpoch: () => 'epoch-1', onRevoked,
    onRemovedByOwner: (device, how) => { phoneRemoved(device); computerRemoved(device, how); },
  });
  const info = vi.fn<(message: string) => void>();
  const reconcile = createAccountDeviceReconcile({
    cloud: { client, status: () => state.status }, deviceAuth: auth, info, debug: vi.fn(),
  });
  reconcilers.push(reconcile);

  /** A phone that connected through the account and signed in (so it is no longer provisional). */
  const accountPhone = (backendId = PHONE, email: string | null = 'me@example.com') => {
    const made = auth.enrollActive({ label: 'Kason’s iPhone', platform: 'ios', accountEmail: email, accountPhoneId: backendId });
    const { nonce } = auth.createChallenge(made.device.id);
    auth.exchange(made.device.id, nonce, proofForToken(made.deviceToken, nonce));
    return made;
  };
  const accountComputer = (backendId = COMPUTER, approve: 'ask' | 'auto' = 'auto') =>
    auth.enrollComputer({ label: 'MacBook Pro', accountEmail: 'me@example.com', backendDeviceId: backendId, approve });
  const linked = (platform: 'ios' | 'desktop' = 'desktop') => {
    const { code } = auth.createPairingCode();
    const made = auth.redeem({ code, label: 'Paired by link', platform })!;
    auth.approve(made.device.id);
    return made;
  };
  const signIn = (made: { device: MobileDeviceRecord; deviceToken: string }) => {
    const { nonce } = auth.createChallenge(made.device.id);
    return auth.exchange(made.device.id, nonce, proofForToken(made.deviceToken, nonce));
  };
  const live = () => auth.list().map((d) => d.id).sort();
  return { reconcile, state, calls, store, auth, onRevoked, denied, revokeBackendDevice, info, accountPhone, accountComputer, linked, signIn, live };
}

describe('readRevokedAccountDevices (cloud/devices.ts)', () => {
  const clientOf = (reply: (path: string, nth: number) => unknown) => {
    const calls: string[] = [];
    const client = { request: (async (_m: string, path: string) => { calls.push(path); return reply(path, calls.length); }) } as unknown as CloudClient;
    return { client, calls };
  };

  it('answers the ids a complete read shows revoked, and nothing about the others', async () => {
    const f = clientOf(() => page([row(PHONE, AT), row(COMPUTER, null), row(OTHER, AT)]));
    const read = await readRevokedAccountDevices(f.client);
    expect(read).toEqual({ complete: true, revoked: new Set([PHONE, OTHER]) });
  });

  it('reads every page before it says anything', async () => {
    const f = clientOf((path) => (path === '/v1/devices' ? page([row(PHONE, AT)], PHONE) : page([row(COMPUTER, AT)])));
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: true, revoked: new Set([PHONE, COMPUTER]) });
    expect(f.calls).toEqual(['/v1/devices', `/v1/devices?cursor=${PHONE}`]);
  });

  it(`is not complete, and names no id, when the page cap (${MAX_DEVICE_PAGES}) is reached with more to read`, async () => {
    const f = clientOf((_path, nth) => page([row(PHONE, AT)], `next-${nth}`)); // a new cursor every time
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: false });
    expect(f.calls).toHaveLength(MAX_DEVICE_PAGES);
  });

  it('is not complete, and stops asking, as soon as the backend repeats a cursor', async () => {
    const f = clientOf(() => page([row(PHONE, AT)], PHONE));
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: false });
    expect(f.calls).toEqual(['/v1/devices', `/v1/devices?cursor=${PHONE}`]);
  });

  it('is not complete when a cursor comes round again later (a loop of two)', async () => {
    const f = clientOf((path) => {
      if (path === '/v1/devices') return page([row(PHONE, AT)], PHONE);
      if (path === `/v1/devices?cursor=${PHONE}`) return page([row(COMPUTER, AT)], COMPUTER);
      return page([row(OTHER, AT)], PHONE);
    });
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: false });
    expect(f.calls).toHaveLength(3);
  });

  it.each([
    ['a request that fails', () => { throw new CloudError('offline', 'x'); }],
    ['a 403', () => { throw new CloudError('forbidden', 'x', 403); }],
    ['an answer that is no page', () => ({ devices: 'none' })],
    ['a second page that fails', (path: string) => { if (path === '/v1/devices') return page([row(PHONE, AT)], PHONE); throw new CloudError('backend_error', 'x'); }],
    ['a second page that is no page', (path: string) => (path === '/v1/devices' ? page([row(PHONE, AT)], PHONE) : { nope: true })],
  ])('rejects on %s: there is no partial answer', async (_label, reply) => {
    await expect(readRevokedAccountDevices(clientOf(reply as (path: string) => unknown).client)).rejects.toBeInstanceOf(CloudError);
  });

  it.each([
    ['a revokedAt that is no time', row(PHONE, 'yes' as never)],
    ['a revokedAt of another type', row(PHONE, null, { revokedAt: 7 })],
    ['no revokedAt at all', (() => { const { revokedAt: _r, ...rest } = row(PHONE, AT); return rest; })()],
  ])('never names a device whose own row it cannot read (%s), even when another row says revoked', async (_label, unreadable) => {
    const alone = clientOf(() => page([unreadable, row(COMPUTER, AT)]));
    expect(await readRevokedAccountDevices(alone.client)).toEqual({ complete: true, revoked: new Set([COMPUTER]) });
    const twice = clientOf(() => page([row(PHONE, AT), unreadable]));
    expect(await readRevokedAccountDevices(twice.client)).toEqual({ complete: true, revoked: new Set() });
  });

  it('never names a device two rows disagree about', async () => {
    const f = clientOf(() => page([row(PHONE, AT), row(PHONE, null)]));
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: true, revoked: new Set() });
  });

  it('ignores a row that names no device (it can be evidence about none)', async () => {
    const f = clientOf(() => page(['x', null, { revokedAt: AT }, row('not-a-uuid', AT), row(PHONE, AT)]));
    expect(await readRevokedAccountDevices(f.client)).toEqual({ complete: true, revoked: new Set([PHONE]) });
  });
});

describe('a device the account signed out', () => {
  it('is dropped here: an account phone and an account computer, and their sessions end', async () => {
    const f = setUp();
    const phone = f.accountPhone();
    const computer = f.accountComputer();
    expect(await f.reconcile.run()).toBe(2);
    expect(f.live()).toEqual([]);
    // As a local Revoke does: the record stays, revoked, and everything it held is cut (onRevoked).
    expect(f.store.rows.get(phone.device.id)).toMatchObject({ status: 'revoked' });
    expect(f.store.rows.get(computer.device.id)).toMatchObject({ status: 'revoked' });
    expect(f.onRevoked.mock.calls.map(([d]) => d.id).sort()).toEqual([phone.device.id, computer.device.id].sort());
    // What the device sees next: its key is refused as revoked.
    expect(f.signIn(phone)).toEqual({ ok: false, reason: 'revoked' });
    expect(f.signIn(computer)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('is dropped while it still waits for Allow, too', async () => {
    const f = setUp();
    const waiting = f.accountComputer(COMPUTER, 'ask');
    expect(await f.reconcile.run()).toBe(1);
    expect(f.auth.approve(waiting.device.id)).toBeNull();
  });

  it('asks the backend for the list and nothing else, and never as the owner removing it here', async () => {
    const f = setUp();
    f.accountPhone();
    f.accountComputer();
    await f.reconcile.run();
    expect(f.calls).toEqual(['GET /v1/devices']);
    // Not a local Revoke: nothing is pushed back to the backend, nothing joins the deny list.
    expect(f.revokeBackendDevice).not.toHaveBeenCalled();
    expect(f.denied.add).not.toHaveBeenCalled();
  });

  it('says so in one line per record, with no id, address or email', async () => {
    const f = setUp();
    f.accountPhone();
    f.accountComputer();
    await f.reconcile.run();
    expect(f.info).toHaveBeenCalledTimes(2);
    const logged = f.info.mock.calls.map(([m]) => m).join('\n');
    expect(logged).toContain('Kason’s iPhone');
    expect(logged).toContain('MacBook Pro');
    for (const secret of [PHONE, COMPUTER, 'me@example.com', 'backend.example']) expect(logged).not.toContain(secret);
  });

  it('leaves every other record alone', async () => {
    const f = setUp({ reply: () => page([row(PHONE, AT), row(COMPUTER, null), row(OTHER, null)]) });
    const gone = f.accountPhone();
    const kept = f.accountComputer();
    const other = f.accountPhone(OTHER);
    expect(await f.reconcile.run()).toBe(1);
    expect(f.live()).toEqual([kept.device.id, other.device.id].sort());
    expect(f.store.rows.get(gone.device.id)!.status).toBe('revoked');
  });
});

describe('a record paired by link or QR is never touched, whatever the list says', () => {
  it('not one whose local id is the very id the list shows revoked', async () => {
    const f = setUp();
    const link = f.linked();
    // The list names this record's LOCAL id as a revoked backend device: local ids are never what is matched.
    f.state.reply = () => page([row(link.device.id, AT)]);
    f.accountPhone(OTHER); // so there is something to reconcile and the list is read
    expect(await f.reconcile.run()).toBe(0);
    expect(f.live()).toContain(link.device.id);
    expect(f.signIn(link).ok).toBe(true);
  });

  it('not even a link-paired row that somehow carries a backend device id', async () => {
    const f = setUp();
    const link = f.linked('ios');
    f.store.rows.set(link.device.id, { ...f.store.rows.get(link.device.id)!, accountPhoneId: PHONE }); // origin stays 'code'
    f.accountPhone(OTHER);
    expect(await f.reconcile.run()).toBe(0);
    expect(f.reconcile.signedOut(PHONE)).toBe(0);
    expect(f.auth.revokeSignedOut(link.device.id)).toBe(false);
    expect(f.signIn(link).ok).toBe(true);
    expect(f.onRevoked).not.toHaveBeenCalled();
  });
});

describe('nothing is dropped without proof', () => {
  it('not on absence: a device the list does not mention stays', async () => {
    const f = setUp({ reply: () => page([row(OTHER, AT)]) });
    const phone = f.accountPhone();
    const computer = f.accountComputer();
    expect(await f.reconcile.run()).toBe(0);
    expect(f.live()).toEqual([phone.device.id, computer.device.id].sort());
    expect(f.onRevoked).not.toHaveBeenCalled();
  });

  it('not on an empty list', async () => {
    const f = setUp({ reply: () => page([]) });
    f.accountPhone();
    expect(await f.reconcile.run()).toBe(0);
    expect(f.live()).toHaveLength(1);
  });

  it.each([
    ['the network fails', () => { throw new CloudError('offline', 'x'); }],
    ['the backend answers 403', () => { throw new CloudError('forbidden', 'x', 403); }],
    ['the backend answers 500', () => { throw new CloudError('backend_error', 'x'); }],
    ['the answer is no device list', () => ({ success: true })],
    ['something else throws', () => { throw new Error('boom'); }],
    ['a page in the middle is bad, after one that showed the device revoked', (path: string) => (path === '/v1/devices' ? page([row(PHONE, AT), row(COMPUTER, AT)], PHONE) : { devices: 7 })],
    ['a later page fails, after one that showed the device revoked', (path: string) => { if (path === '/v1/devices') return page([row(PHONE, AT), row(COMPUTER, AT)], PHONE); throw new CloudError('offline', 'x'); }],
    ['the page cap is reached, every page showing the device revoked', (_path: string, nth: number) => page([row(PHONE, AT), row(COMPUTER, AT)], `next-${nth}`)],
    ['the backend repeats a cursor, every page showing the device revoked', () => page([row(PHONE, AT), row(COMPUTER, AT)], PHONE)],
  ])('not when %s', async (_label, reply) => {
    const f = setUp({ reply: reply as (path: string, nth: number) => unknown });
    const phone = f.accountPhone();
    const computer = f.accountComputer();
    await expect(f.reconcile.run()).resolves.toBe(0);
    expect(f.live()).toEqual([phone.device.id, computer.device.id].sort());
    expect(f.onRevoked).not.toHaveBeenCalled();
    expect(f.signIn(phone).ok).toBe(true);
  });

  it.each([
    ['its revokedAt is no time', row(PHONE, null, { revokedAt: 'gone' })],
    ['its revokedAt is of another type', row(PHONE, null, { revokedAt: true })],
    ['another row for it says it is live', row(PHONE, null)],
  ])('not for a device whose own row cannot be read (%s), while a readable one in the same list still is', async (_label, bad) => {
    const f = setUp({ reply: () => page([row(PHONE, AT), bad, row(COMPUTER, AT)]) });
    const phone = f.accountPhone();
    const computer = f.accountComputer();
    expect(await f.reconcile.run()).toBe(1);
    expect(f.live()).toEqual([phone.device.id]);
    expect(f.store.rows.get(computer.device.id)!.status).toBe('revoked');
  });

  it.each([
    ['no connection', signedOut],
    ['a revoked connection', signedIn('revoked')],
    ['a disconnected one that still names a connection', signedIn('disconnected')],
  ])('not with %s: the backend is not even asked', async (_label, status) => {
    const f = setUp({ status });
    f.accountPhone();
    expect(await f.reconcile.run()).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.live()).toHaveLength(1);
  });

  it('not when this machine signs out, or in to another account, while the list is being read', async () => {
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const f = setUp({ reply: async () => { await held; return page([row(PHONE, AT)]); } });
    f.accountPhone();
    const running = f.reconcile.run();
    f.state.status = signedIn('connected', { accountId: '00000000-0000-4000-8000-0000000000f2', generation: 2 });
    open();
    expect(await running).toBe(0);
    expect(f.live()).toHaveLength(1);
  });

  it('not for a record made through another account than the one the list is of', async () => {
    const f = setUp();
    const theirs = f.accountPhone(PHONE, 'someone-else@example.com');
    const mine = f.accountComputer();
    expect(await f.reconcile.run()).toBe(1);
    expect(f.live()).toEqual([theirs.device.id]);
    expect(f.store.rows.get(mine.device.id)!.status).toBe('revoked');
  });

  it('by the exact id alone when the record or the connection names no account to compare', async () => {
    const f = setUp();
    f.accountPhone(PHONE, null); // enrolled through an account with no email
    expect(await f.reconcile.run()).toBe(1);
    const g = setUp({ status: signedIn('connected', { accountEmail: undefined }) }); // joined with a pairing code
    g.accountPhone();
    expect(await g.reconcile.run()).toBe(1);
  });

  it('reads nothing at all while this machine holds no record made through the account', async () => {
    const f = setUp();
    f.linked();
    expect(await f.reconcile.run()).toBe(0);
    expect(f.calls).toEqual([]);
  });
});

describe('a sign-out made on this machine', () => {
  it('drops the matching record at once, with no list and no backend call', () => {
    const f = setUp();
    const phone = f.accountPhone();
    const kept = f.accountComputer();
    expect(f.reconcile.signedOut(PHONE)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.live()).toEqual([kept.device.id]);
    expect(f.onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: phone.device.id, status: 'revoked' }));
    expect(f.revokeBackendDevice).not.toHaveBeenCalled();
    expect(f.denied.add).not.toHaveBeenCalled();
    expect(f.info).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an id no record here was made as, or for anything that is no id', () => {
    const f = setUp();
    f.accountPhone();
    expect(f.reconcile.signedOut(OTHER)).toBe(0);
    expect(f.reconcile.signedOut('')).toBe(0);
    expect(f.live()).toHaveLength(1);
  });
});

describe('when it looks', () => {
  const revokedNever = () => page([row(OTHER, AT)]);

  it('once when started with a usable connection, then every five minutes while it is', async () => {
    vi.useFakeTimers();
    expect(RECONCILE_EVERY_MS).toBe(5 * 60_000);
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS - 1);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 2);
    expect(f.calls).toHaveLength(4);
  });

  it('a saved connection nothing has checked yet (offline after a restart) counts as usable', async () => {
    vi.useFakeTimers();
    const f = setUp({ status: signedIn('offline') });
    const phone = f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.rows.get(phone.device.id)!.status).toBe('revoked');
  });

  it('never, started with no connection: no timer runs and the backend is never asked', async () => {
    vi.useFakeTimers();
    const f = setUp({ status: signedOut });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3);
    expect(f.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('at once after a sign-in, then on its own five minutes', async () => {
    vi.useFakeTimers();
    const f = setUp({ status: signedOut, reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    f.state.status = signedIn();
    f.reconcile.connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(f.calls).toHaveLength(2);
  });

  it('stops on sign-out: the timer is gone and nothing more is asked', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    f.state.status = signedOut;
    f.reconcile.disconnected();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3);
    expect(f.calls).toHaveLength(1);
  });

  it('stops by itself when a tick finds the connection gone or revoked', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    f.state.status = signedIn('revoked');
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('stops at shutdown, and start twice makes one timer', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    f.reconcile.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    f.reconcile.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('one look at a time: a tick or an ask that meets a running look shares it', async () => {
    vi.useFakeTimers();
    let open!: () => void;
    const held = new Promise<void>((resolve) => { open = resolve; });
    const f = setUp({ reply: async () => { await held; return revokedNever(); } });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3); // three ticks while the first look is still out
    const asked = f.reconcile.run();
    expect(f.calls).toHaveLength(1);
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(await asked).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('a sign-in while a look is still out under the previous connection gets a look of its own', async () => {
    vi.useFakeTimers();
    let answerA!: () => void;
    const heldA = new Promise<void>((resolve) => { answerA = resolve; });
    // The previous connection's list says the phone was signed out; the new one's says the computer was.
    const f = setUp({ reply: async (_path, nth) => {
      if (nth > 1) return page([row(COMPUTER, AT)]);
      await heldA;
      return page([row(PHONE, AT)]);
    } });
    const phone = f.accountPhone();
    const computer = f.accountComputer();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1); // out under the first connection, not answered yet

    f.state.status = signedIn('connected', { generation: 2 }); // signed in again
    f.reconcile.connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2); // a second read, under the new connection
    expect(f.store.rows.get(computer.device.id)!.status).toBe('revoked');
    expect(f.live()).toEqual([phone.device.id]);

    answerA(); // the old look's answer arrives now: it is about a connection that is gone
    await vi.advanceTimersByTimeAsync(0);
    expect(f.live()).toEqual([phone.device.id]);
    expect(f.onRevoked.mock.calls.map(([d]) => d.id)).toEqual([computer.device.id]);
    // And the looking goes on, one look at a time again.
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(f.calls).toHaveLength(3);
  });

  it('the old look ending does not let a third one start beside the new connection\'s', async () => {
    vi.useFakeTimers();
    const answers: Array<() => void> = [];
    const f = setUp({ reply: (_path, nth) => new Promise((resolve) => { answers[nth] = () => resolve(page([row(OTHER, AT)])); }) });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    f.state.status = signedIn('connected', { generation: 2 });
    f.reconcile.connected();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    answers[1](); // the old look ends while the new one is still out
    await vi.advanceTimersByTimeAsync(0);
    void f.reconcile.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2); // shared with the new connection's look
    answers[2]();
    await vi.advanceTimersByTimeAsync(0);
    const again = f.reconcile.run(); // nothing is out now: a new ask is a new look
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(3);
    answers[3]();
    await expect(again).resolves.toBe(0);
  });

  it('never rejects and never throws, whatever a dependency does', async () => {
    const f = setUp();
    f.accountPhone();
    f.state.reply = () => { throw new TypeError('not even a CloudError'); };
    await expect(f.reconcile.run()).resolves.toBe(0);
    const broken = createAccountDeviceReconcile({
      cloud: { client: {} as CloudClient, status: () => { throw new Error('status fell over'); } },
      deviceAuth: f.auth, info: vi.fn(), debug: vi.fn(),
    });
    await expect(broken.run()).resolves.toBe(0);
    expect(() => broken.start()).not.toThrow();
    expect(broken.signedOut(OTHER)).toBe(0);
    broken.stop();
  });
});

describe('the connector the server signs in and out through (withAccountDeviceReconcile)', () => {
  const revokedNever = () => page([row(OTHER, AT)]);
  /** A connector whose sign-out is the test's; every other member unused here. */
  const wrap = (f: ReturnType<typeof setUp>, disconnectCloud: () => Promise<void>) =>
    withAccountDeviceReconcile({ disconnectCloud } as unknown as CloudConnector, () => f.reconcile);

  it('a sign-out that worked stops the looking, and only once it has', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    let done!: () => void;
    const leaving = wrap(f, () => new Promise<void>((resolve) => { done = resolve; })).disconnectCloud();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // still signed in until the sign-out is through
    f.state.status = signedOut;
    done();
    await leaving;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3);
    expect(f.calls).toHaveLength(1);
  });

  it('a sign-out that failed leaves it looking: the connection is still there', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    const phone = f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    const failing = wrap(f, async () => { throw new CloudError('offline', 'could not sign out'); });
    await expect(failing.disconnectCloud()).rejects.toThrow('could not sign out');
    expect(vi.getTimerCount()).toBe(1);
    f.state.reply = () => page([row(PHONE, AT)]); // and it still acts on what the account says
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS);
    expect(f.calls).toHaveLength(2);
    expect(f.store.rows.get(phone.device.id)!.status).toBe('revoked');
  });

  it('a sign-out that failed but left no connection stops at the next tick, asking nothing', async () => {
    vi.useFakeTimers();
    const f = setUp({ reply: revokedNever });
    f.accountPhone();
    f.reconcile.start();
    await vi.advanceTimersByTimeAsync(0);
    const failing = wrap(f, async () => { f.state.status = signedOut; throw new CloudError('offline', 'could not sign out'); });
    await expect(failing.disconnectCloud()).rejects.toThrow('could not sign out');
    await vi.advanceTimersByTimeAsync(RECONCILE_EVERY_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('a reconcile that throws never fails a sign-out', async () => {
    const cloud = { disconnectCloud: vi.fn(async () => {}) } as unknown as CloudConnector;
    const wrapped = withAccountDeviceReconcile(cloud, () => ({ connected: () => {}, disconnected: () => { throw new Error('boom'); } }));
    await expect(wrapped.disconnectCloud()).resolves.toBeUndefined();
  });
});
