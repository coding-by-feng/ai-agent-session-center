// remoteStoreAccount.test.ts — remote-computers.json records made through the AASC Cloud account (plan 18, stage 2):
// how they are told from records paired by link, and that connecting a machine again replaces its record.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRemoteStore, type RemoteCrypto } from '../electron/remote/remoteStore.js';

const TOKEN = 'device-token-very-secret-1234567890';
const NEW_TOKEN = 'another-device-token-0987654321-abc';
const MACHINE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_MACHINE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function fakeCrypto(): RemoteCrypto {
  return {
    isAvailable: () => true,
    encrypt: (v) => Buffer.from(`enc:${Buffer.from(v).toString('hex')}`),
    decrypt: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
  };
}

const link = {
  name: 'Old NUC', lan: '192.168.1.30', tailnet: null, port: 3333, status: 'active' as const, confirmCode: null,
  addedAt: 1_000, lastSeenAt: null, deviceId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
};
const account = {
  name: 'Mac mini', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, status: 'pending' as const,
  confirmCode: '482913', addedAt: 2_000, lastSeenAt: null, deviceId: '2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d',
  origin: 'account' as const, backendDeviceId: MACHINE,
};

let dir: string;
let file: string;
let ids: number;
const newId = (): string => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const idAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const open = () => createRemoteStore({ file, crypto: fakeCrypto(), newId });

/** Rewrite the first stored record and read the file with a fresh store. */
function reloadWith(change: (record: Record<string, unknown>) => void) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { computers: Record<string, unknown>[] };
  change(raw.computers[0]);
  writeFileSync(file, JSON.stringify(raw));
  return open();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-remote-store-account-'));
  file = join(dir, 'remote-computers.json');
  ids = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a record’s origin', () => {
  it('is "link" unless it was made through the account', () => {
    const store = open();
    store.add(link, TOKEN);
    expect(store.get(idAt(1))?.origin).toBe('link');
    expect(store.get(idAt(1))).not.toHaveProperty('backendDeviceId');
  });

  it('keeps an account record’s origin and its machine on the account, across a restart', () => {
    const store = open();
    const added = store.add(account, TOKEN);
    expect(added).toMatchObject({ ok: true, data: { origin: 'account', backendDeviceId: MACHINE, status: 'pending', confirmCode: '482913' } });
    const again = open();
    expect(again.get(idAt(1))).toMatchObject({ origin: 'account', backendDeviceId: MACHINE, name: 'Mac mini' });
    expect(again.credentials(idAt(1))).toEqual({ deviceId: account.deviceId, deviceToken: TOKEN });
  });

  it('reads a record saved before plan 18, which has neither field, as paired by link', () => {
    open().add(link, TOKEN);
    const store = reloadWith((record) => {
      delete record.origin;
      delete record.backendDeviceId;
    });
    expect(store.list()).toHaveLength(1);
    expect(store.get(idAt(1))?.origin).toBe('link');
    expect(store.credentials(idAt(1))?.deviceToken).toBe(TOKEN);
  });

  it.each([
    ['an origin it doesn’t know', (r: Record<string, unknown>) => { r.origin = 'cloud'; }],
    ['an origin that is no string', (r: Record<string, unknown>) => { r.origin = 1; }],
    ['a machine id that is no UUID', (r: Record<string, unknown>) => { r.backendDeviceId = '../../etc'; }],
    ['a machine id in upper case', (r: Record<string, unknown>) => { r.backendDeviceId = MACHINE.toUpperCase(); }],
    ['a machine id that is no string', (r: Record<string, unknown>) => { r.backendDeviceId = 7; }],
    ['an account record with no machine id', (r: Record<string, unknown>) => { delete r.backendDeviceId; }],
  ])('drops a stored record with %s', (_name, change) => {
    open().add(account, TOKEN);
    expect(reloadWith(change).list()).toEqual([]);
  });

  it('refuses to add an account record that names no machine', () => {
    const store = open();
    const { backendDeviceId: _none, ...nameless } = account;
    expect(store.add(nameless, TOKEN).ok).toBe(false);
    expect(store.add({ ...account, backendDeviceId: 'not-a-uuid' }, TOKEN).ok).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it('never lists the token or this computer’s device id there, whatever the origin', () => {
    const store = open();
    store.add(link, TOKEN);
    store.add(account, NEW_TOKEN);
    const listed = JSON.stringify(store.list());
    expect(listed).not.toContain(TOKEN);
    expect(listed).not.toContain(NEW_TOKEN);
    expect(listed).not.toContain(account.deviceId);
    expect(readFileSync(file, 'utf8')).not.toContain(NEW_TOKEN);
  });
});

describe('connecting a machine again through the account', () => {
  it('replaces its record: one row, the same id, the new key and state', () => {
    const store = open();
    store.add(link, 'the-link-record-keeps-its-own-token');
    store.add(account, TOKEN);
    store.update(idAt(2), { status: 'revoked', confirmCode: null, lastSeenAt: 9_000 });
    const again = store.add({ ...account, deviceId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', confirmCode: '111222', addedAt: 3_000 }, NEW_TOKEN);
    expect(again).toMatchObject({ ok: true, data: { id: idAt(2), status: 'pending', confirmCode: '111222', addedAt: 3_000, lastSeenAt: null } });
    expect(store.list().map((r) => r.id)).toEqual([idAt(1), idAt(2)]);
    expect(store.credentials(idAt(2))).toEqual({ deviceId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', deviceToken: NEW_TOKEN });
    // And on disk: a fresh store sees one account row, with the new key.
    const fresh = open();
    expect(fresh.list().filter((r) => r.origin === 'account')).toHaveLength(1);
    expect(fresh.credentials(idAt(2))?.deviceToken).toBe(NEW_TOKEN);
    // The old key is gone from the file, not kept beside the new one.
    expect(readFileSync(file, 'utf8')).toContain(fakeCrypto().encrypt(NEW_TOKEN).toString('base64'));
    expect(readFileSync(file, 'utf8')).not.toContain(fakeCrypto().encrypt(TOKEN).toString('base64'));
  });

  it('adds a second row for another machine', () => {
    const store = open();
    store.add(account, TOKEN);
    store.add({ ...account, backendDeviceId: OTHER_MACHINE, name: 'Linux box' }, NEW_TOKEN);
    expect(store.list().map((r) => r.name)).toEqual(['Mac mini', 'Linux box']);
  });

  it('leaves a record paired by link alone, even at the same address', () => {
    const store = open();
    store.add({ ...link, lan: account.lan }, TOKEN);
    store.add(account, NEW_TOKEN);
    expect(store.list().map((r) => r.origin)).toEqual(['link', 'account']);
    expect(store.credentials(idAt(1))?.deviceToken).toBe(TOKEN);
    // Pairing by link again never replaces anything: it is a second row, as before.
    store.add(link, TOKEN);
    expect(store.list()).toHaveLength(3);
  });

  it('keeps the old record when the new key can’t be stored', () => {
    const store = open();
    store.add(account, TOKEN);
    const locked = createRemoteStore({ file, crypto: { ...fakeCrypto(), encrypt: () => { throw new Error('locked'); } }, newId });
    expect(locked.add({ ...account, confirmCode: '111222' }, NEW_TOKEN).ok).toBe(false);
    expect(open().get(idAt(1))?.confirmCode).toBe('482913');
    expect(open().credentials(idAt(1))?.deviceToken).toBe(TOKEN);
  });
});

// Plan 18: a machine's addresses change (a new lease at home, Tailscale signed in later). A record made through the
// account takes them from the account's directory, since it trusts no address before the machine proves itself there.
describe('an account record’s addresses', () => {
  const moved = { lan: '192.168.1.77', tailnet: '100.64.0.9', publicAddress: '45.63.31.79', port: 3444 };

  it('are replaced by the directory’s: home network, Tailscale, public address and port', () => {
    const store = open();
    store.add(account, TOKEN);
    expect(store.refreshAddresses(idAt(1), moved)).toMatchObject({ id: idAt(1), ...moved, status: 'pending', confirmCode: '482913' });
    // On disk too, with the key untouched.
    const again = open();
    expect(again.get(idAt(1))).toMatchObject(moved);
    expect(again.credentials(idAt(1))).toEqual({ deviceId: account.deviceId, deviceToken: TOKEN });
  });

  it('lose an address the directory no longer lists', () => {
    const store = open();
    store.add({ ...account, publicAddress: '45.63.31.79' }, TOKEN);
    const next = store.refreshAddresses(idAt(1), { lan: null, tailnet: '100.64.0.9', publicAddress: null, port: 3333 });
    expect(next).toMatchObject({ lan: null, tailnet: '100.64.0.9' });
    expect(next).not.toHaveProperty('publicAddress');
    expect(open().get(idAt(1))).not.toHaveProperty('publicAddress');
  });

  it('never change for a record paired by link', () => {
    const store = open();
    store.add(link, TOKEN);
    const before = readFileSync(file, 'utf8');
    expect(store.refreshAddresses(idAt(1), moved)).toBeNull();
    expect(store.get(idAt(1))).toMatchObject({ lan: '192.168.1.30', tailnet: null, port: 3333 });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each([
    ['a home-network address that is public', { ...moved, lan: '8.8.8.8' }],
    ['the cloud metadata address', { ...moved, lan: '169.254.169.254' }],
    ['a Tailscale address that is not one', { ...moved, tailnet: '192.168.1.5' }],
    ['a public address that is private', { ...moved, publicAddress: '10.0.0.1' }],
    ['a host name', { ...moved, lan: 'mac-mini.local' }],
    ['a port that is none', { ...moved, port: 0 }],
    ['no address at all', { lan: null, tailnet: null, publicAddress: null, port: 3333 }],
  ])('change nothing when the new ones hold %s', (_name, bad) => {
    const store = open();
    store.add(account, TOKEN);
    const before = readFileSync(file, 'utf8');
    expect(store.refreshAddresses(idAt(1), bad)).toBeNull();
    expect(store.get(idAt(1))).toMatchObject({ lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('write nothing when they are what the record already has', () => {
    const store = open();
    store.add(account, TOKEN);
    const before = statSync(file).ino;
    expect(store.refreshAddresses(idAt(1), { lan: '192.168.1.20', tailnet: '100.101.102.103', publicAddress: null, port: 3333 })).toMatchObject({ lan: '192.168.1.20' });
    expect(statSync(file).ino).toBe(before);
  });

  it('are nothing for a computer that isn’t there', () => {
    expect(open().refreshAddresses(idAt(9), moved)).toBeNull();
  });
});
