import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRemoteStore, NO_KEYCHAIN, type RemoteCrypto } from '../electron/remote/remoteStore.js';

const TOKEN = 'device-token-very-secret-1234567890';

/** Reversible stand-in for safeStorage: tags the bytes so a plain token never appears. */
function fakeCrypto(available = true): RemoteCrypto {
  return {
    isAvailable: () => available,
    encrypt: (v) => Buffer.from(`enc:${Buffer.from(v).toString('hex')}`),
    decrypt: (b) => Buffer.from(b.toString().slice(4), 'hex').toString(),
  };
}

const base = {
  name: 'Studio Mac',
  lan: '192.168.1.20',
  tailnet: null,
  port: 3333,
  status: 'pending' as const,
  confirmCode: '123456',
  addedAt: 1_000,
  lastSeenAt: null,
  deviceId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
};

let dir: string;
let file: string;
let ids: number;
const newId = (): string => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-remote-store-'));
  file = join(dir, 'remote-computers.json');
  ids = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('remoteStore', () => {
  it('adds a computer and lists it without its token', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    const added = store.add(base, TOKEN);
    expect(added.ok).toBe(true);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: newIdAt(1), name: 'Studio Mac', lan: '192.168.1.20', tailnet: null, port: 3333,
      status: 'pending', confirmCode: '123456', addedAt: 1_000, lastSeenAt: null,
    });
    expect(JSON.stringify(list)).not.toContain(TOKEN);
    expect(list[0]).not.toHaveProperty('token');
    expect(list[0]).not.toHaveProperty('deviceId');
    expect(store.get(newIdAt(1))).not.toHaveProperty('token');
  });

  it('keeps a public address from the link, and reads it back from disk (Oct 28 2026)', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add({ ...base, lan: null, publicAddress: '45.63.31.79' }, TOKEN);
    expect(store.get(newIdAt(1))?.publicAddress).toBe('45.63.31.79');
    const again = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    expect(again.get(newIdAt(1))?.publicAddress).toBe('45.63.31.79');
  });

  it('reads a record saved before public addresses as having none', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    expect(store.get(newIdAt(1))).not.toHaveProperty('publicAddress');
  });

  it('drops a record whose public address is not a public address', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const records = Array.isArray(raw) ? raw : raw.computers;
    records[0].publicAddress = '192.168.1.9';
    writeFileSync(file, JSON.stringify(raw));
    expect(createRemoteStore({ file, crypto: fakeCrypto(), newId }).list()).toEqual([]);
  });

  it('never writes the token in the clear, and gives it back through credentials()', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(store.credentials(newIdAt(1))).toEqual({ deviceId: base.deviceId, deviceToken: TOKEN });
    // A fresh store reads it back from disk.
    const again = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    expect(again.credentials(newIdAt(1))?.deviceToken).toBe(TOKEN);
  });

  it('writes the file 0600 and leaves no temp file behind', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    store.update(newIdAt(1), { status: 'active' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['remote-computers.json']);
  });

  it('tightens an older, looser file on the next write', () => {
    writeFileSync(file, JSON.stringify({ version: 1, computers: [] }), { mode: 0o644 });
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to add without a keychain, and writes nothing', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(false), newId });
    expect(store.canStore()).toBe(false);
    expect(store.add(base, TOKEN)).toEqual({ ok: false, error: NO_KEYCHAIN });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses when encryption throws', () => {
    const crypto = { ...fakeCrypto(), encrypt: () => { throw new Error('locked'); } };
    const store = createRemoteStore({ file, crypto, newId });
    expect(store.add(base, TOKEN)).toEqual({ ok: false, error: NO_KEYCHAIN });
  });

  it('returns null credentials when the keychain can’t decrypt', () => {
    createRemoteStore({ file, crypto: fakeCrypto(), newId }).add(base, TOKEN);
    const crypto = { ...fakeCrypto(), decrypt: () => { throw new Error('other user'); } };
    expect(createRemoteStore({ file, crypto, newId }).credentials(newIdAt(1))).toBeNull();
  });

  it('updates without mutating what list() returned before', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    const before = store.list();
    const after = store.update(newIdAt(1), { status: 'active', confirmCode: null, lastSeenAt: 5_000, tailnet: '100.64.0.9' });
    expect(after).toMatchObject({ status: 'active', confirmCode: null, lastSeenAt: 5_000, tailnet: '100.64.0.9' });
    expect(before[0].status).toBe('pending');
    expect(store.credentials(newIdAt(1))?.deviceToken).toBe(TOKEN);
    expect(store.update('00000000-0000-4000-8000-999999999999', { name: 'x' })).toBeNull();
  });

  it('removes a computer', () => {
    const store = createRemoteStore({ file, crypto: fakeCrypto(), newId });
    store.add(base, TOKEN);
    store.add({ ...base, name: 'Second' }, TOKEN);
    expect(store.remove(newIdAt(1))).toBe(true);
    expect(store.remove(newIdAt(1))).toBe(false);
    expect(store.list().map((r) => r.name)).toEqual(['Second']);
    expect(store.credentials(newIdAt(1))).toBeNull();
  });

  it('treats a missing or corrupt file as no computers, and drops malformed records', () => {
    expect(createRemoteStore({ file, crypto: fakeCrypto(), newId }).list()).toEqual([]);
    writeFileSync(file, '{not json');
    expect(createRemoteStore({ file, crypto: fakeCrypto(), newId }).list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 1, computers: [{ id: '../../etc', name: 'x' }, null, 5] }));
    expect(createRemoteStore({ file, crypto: fakeCrypto(), newId }).list()).toEqual([]);
  });
});

function newIdAt(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}
