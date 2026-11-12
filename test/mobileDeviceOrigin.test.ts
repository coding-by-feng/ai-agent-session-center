// test/mobileDeviceOrigin.test.ts — plan 17: a phone record says how it was paired.
//
// `origin` is 'code' (QR / typed code, then Allow) or 'account' (enrolled through the AASC Cloud account, active
// at once), with the account's email on account rows. deviceAuth.enrollActive makes the account row: active,
// approved now, under the current password, with a token shown once. The column pair is added to existing
// tables once (idempotent), and a fresh install gets them from MOBILE_DEVICES_DDL.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterAll, afterEach } from 'vitest';
import { sqliteIt } from './helpers/nativeSqlite.js';
import {
  createDeviceAuth, hashSecret, MAX_PROVISIONAL_ACCOUNT_ROWS, PROVISIONAL_ACCOUNT_TTL_MS, proofForToken, toView,
  TooManyProvisionalPhonesError, type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

const PHONE_ID = '00000000-0000-4000-8000-0000000000cc';
import { MOBILE_DEVICES_DDL } from '../server/mobile/devicePlatformMigration.js';
import { migrateMobileDeviceOrigin } from '../server/mobile/deviceOriginMigration.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

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

describe('deviceAuth.enrollActive', () => {
  it('makes an active account row under the current password, with its token shown once', () => {
    const store = memoryStore();
    let t = 1_000;
    const auth = createDeviceAuth({ store, now: () => t, credentialEpoch: () => 'epoch-1' });
    const { device, deviceToken } = auth.enrollActive({ label: '  Kason\u0007 iPhone ', platform: 'ios', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID });
    expect(device).toMatchObject({
      status: 'active', origin: 'account', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID,
      label: 'Kason iPhone', platform: 'ios',
      credentialEpoch: 'epoch-1', approvedAt: 1_000, createdAt: 1_000, beCodeRef: null, beCodeRefMacBound: false,
    });
    expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.rows.get(device.id)?.tokenHash).toBe(hashSecret(deviceToken));
    const first = auth.createChallenge(device.id);
    expect(auth.exchange(device.id, first.nonce, proofForToken(deviceToken, first.nonce)).ok).toBe(true);
    t += 60_000 * 60; // long past the pending and provisional windows: once signed in, an account row stays
    const { nonce } = auth.createChallenge(device.id);
    expect(auth.exchange(device.id, nonce, proofForToken(deviceToken, nonce)).ok).toBe(true);
  });

  it('names an unnamed phone, and keeps a null email', () => {
    const auth = createDeviceAuth({ store: memoryStore() });
    const { device } = auth.enrollActive({ label: '\u0000', platform: 'android', accountEmail: null, accountPhoneId: PHONE_ID });
    expect(device).toMatchObject({ label: 'Phone', accountEmail: null, origin: 'account' });
  });

  it('is revoked by a password change like any phone', () => {
    let epoch = 'epoch-1';
    const auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => epoch });
    const { device } = auth.enrollActive({ label: 'Pixel', platform: 'android', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID });
    epoch = 'epoch-2';
    expect(auth.revokeStaleCredentials()).toBe(1);
    expect(auth.list()).toEqual([]);
    expect(device.id).toBeTruthy();
  });

  it('deletes an account row whose phone never signs in within two minutes, and keeps one that did', () => {
    const store = memoryStore();
    let t = 1_000;
    const onRevoked = vi.fn();
    const onRemovedByOwner = vi.fn();
    const auth = createDeviceAuth({ store, now: () => t, onRevoked, onRemovedByOwner });
    const quiet = auth.enrollActive({ label: 'Quiet', platform: 'ios', accountEmail: null, accountPhoneId: PHONE_ID });
    const signed = auth.enrollActive({ label: 'Signed', platform: 'ios', accountEmail: null, accountPhoneId: PHONE_ID });
    const { nonce } = auth.createChallenge(signed.device.id);
    expect(auth.exchange(signed.device.id, nonce, proofForToken(signed.deviceToken, nonce)).ok).toBe(true);
    expect(auth.provisionalAccountCount()).toBe(1);
    t += PROVISIONAL_ACCOUNT_TTL_MS - 1;
    expect(auth.list().map((d) => d.label).sort()).toEqual(['Quiet', 'Signed']);
    t += 2;
    expect(auth.list().map((d) => d.label)).toEqual(['Signed']);
    expect(store.rows.has(quiet.device.id)).toBe(false); // deleted, not kept as revoked
    expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ id: quiet.device.id, status: 'revoked' }));
    expect(onRemovedByOwner).not.toHaveBeenCalled(); // an expiry is not the owner's doing
    const late = auth.createChallenge(quiet.device.id);
    expect(auth.exchange(quiet.device.id, late.nonce, proofForToken(quiet.deviceToken, late.nonce)).ok).toBe(false);
  });

  it('sweeps on exchange too, so a phone that comes back late is refused', () => {
    let t = 1_000;
    const auth = createDeviceAuth({ store: memoryStore(), now: () => t });
    const { device, deviceToken } = auth.enrollActive({ label: 'Late', platform: 'ios', accountEmail: null, accountPhoneId: PHONE_ID });
    const { nonce } = auth.createChallenge(device.id);
    t += PROVISIONAL_ACCOUNT_TTL_MS + 1;
    expect(auth.exchange(device.id, nonce, proofForToken(deviceToken, nonce))).toEqual({ ok: false, reason: 'invalid' });
  });

  it('holds at most five phones waiting for their first sign-in', () => {
    const auth = createDeviceAuth({ store: memoryStore() });
    for (let i = 0; i < MAX_PROVISIONAL_ACCOUNT_ROWS; i++) {
      auth.enrollActive({ label: `P${i}`, platform: 'ios', accountEmail: null, accountPhoneId: PHONE_ID });
    }
    expect(() => auth.enrollActive({ label: 'P5', platform: 'ios', accountEmail: null, accountPhoneId: PHONE_ID }))
      .toThrow(TooManyProvisionalPhonesError);
    const { code } = auth.createPairingCode();
    expect(auth.redeem({ code, label: 'Pixel', platform: 'android' })).not.toBeNull(); // code pairing is unaffected
  });

  it('tells onRemovedByOwner about Revoke and Unpair only, never a password change', () => {
    let epoch = 'epoch-1';
    const removed = vi.fn();
    const auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => epoch, onRemovedByOwner: removed });
    const sign = (id: string, token: string) => {
      const { nonce } = auth.createChallenge(id);
      return auth.exchange(id, nonce, proofForToken(token, nonce));
    };
    const a = auth.enrollActive({ label: 'A', platform: 'ios', accountEmail: null, accountPhoneId: 'phone-a' });
    const b = auth.enrollActive({ label: 'B', platform: 'ios', accountEmail: null, accountPhoneId: 'phone-b' });
    const c = auth.enrollActive({ label: 'C', platform: 'ios', accountEmail: null, accountPhoneId: 'phone-c' });
    for (const p of [a, b, c]) sign(p.device.id, p.deviceToken);
    expect(auth.revoke(a.device.id)).toBe(true);
    const { nonce } = auth.createChallenge(b.device.id);
    expect(auth.unpair(b.device.id, nonce, proofForToken(b.deviceToken, nonce))).toBe(true);
    expect(removed.mock.calls.map(([d]) => d.accountPhoneId)).toEqual(['phone-a', 'phone-b']);
    epoch = 'epoch-2';
    expect(auth.revokeStaleCredentials()).toBe(1); // c
    expect(removed).toHaveBeenCalledTimes(2);
  });

  it('keeps code pairing as origin code with no email', () => {
    const auth = createDeviceAuth({ store: memoryStore() });
    const { code } = auth.createPairingCode();
    const { device } = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
    expect(device).toMatchObject({ origin: 'code', accountEmail: null, accountPhoneId: null });
  });

  it('shows origin and email in the desktop view, and never the hash', () => {
    const auth = createDeviceAuth({ store: memoryStore() });
    const { device } = auth.enrollActive({ label: 'Pixel', platform: 'android', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID });
    const view = toView(device);
    expect(view).toMatchObject({ origin: 'account', accountEmail: 'me@example.com', confirmCode: null });
    expect(JSON.stringify(view)).not.toContain(device.tokenHash);
    expect(JSON.stringify(view)).not.toContain(PHONE_ID); // the backend id is never shown
    expect(auth.list()[0]).toMatchObject({ origin: 'account', accountEmail: 'me@example.com' });
  });
});

type Db = import('better-sqlite3').Database;
/** mobile_devices as it was before plan 17: every column but origin and account_email. */
const BEFORE_ORIGIN = `CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('ios','android','desktop')),
  token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  confirm_code TEXT NOT NULL, be_code_ref TEXT, be_code_ref_mac_bound INTEGER NOT NULL DEFAULT 0,
  credential_epoch TEXT, created_at INTEGER NOT NULL, approved_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER)`;

async function beforeOriginDb(): Promise<Db> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(BEFORE_ORIGIN);
  db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at)
    VALUES ('p1', 'iPhone', 'ios', ?, 'active', '111111', 10)`).run('a'.repeat(64));
  return db;
}

describe('migrateMobileDeviceOrigin', () => {
  sqliteIt('adds account_phone_id to a table that already has origin and account_email', async () => {
    const db = await beforeOriginDb();
    db.exec("ALTER TABLE mobile_devices ADD COLUMN origin TEXT NOT NULL DEFAULT 'code' CHECK (origin IN ('code','account'))");
    db.exec('ALTER TABLE mobile_devices ADD COLUMN account_email TEXT');
    expect(migrateMobileDeviceOrigin(db)).toBe(true);
    expect(db.prepare("SELECT account_phone_id FROM mobile_devices WHERE id = 'p1'").get()).toEqual({ account_phone_id: null });
    expect(migrateMobileDeviceOrigin(db)).toBe(false);
  });

  sqliteIt('adds origin (default code), account_email and account_phone_id to an existing table, once', async () => {
    const db = await beforeOriginDb();
    expect(migrateMobileDeviceOrigin(db)).toBe(true);
    expect(db.prepare("SELECT origin, account_email, account_phone_id FROM mobile_devices WHERE id = 'p1'").get())
      .toEqual({ origin: 'code', account_email: null, account_phone_id: null });
    expect(migrateMobileDeviceOrigin(db)).toBe(false);
    db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at, origin,
      account_email) VALUES ('p2', 'Pixel', 'android', ?, 'active', '0', 11, 'account', 'me@example.com')`).run('b'.repeat(64));
    expect(() => db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at,
      origin) VALUES ('p3', 'x', 'ios', ?, 'active', '0', 12, 'qr')`).run('c'.repeat(64))).toThrow(/CHECK/);
  });

  sqliteIt('does nothing on a fresh table or with no table', async () => {
    const { default: Database } = await import('better-sqlite3');
    const fresh = new Database(':memory:');
    fresh.exec(MOBILE_DEVICES_DDL);
    expect(migrateMobileDeviceOrigin(fresh)).toBe(false);
    const cols = (fresh.prepare('PRAGMA table_info(mobile_devices)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['origin', 'account_email', 'account_phone_id']));
    expect(migrateMobileDeviceOrigin(new Database(':memory:'))).toBe(false);
  });
});

describe('the SQLite device store keeps origin and email (plan 17)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-origin-'));
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  sqliteIt('migrates an old database at startup and round-trips an account row', async () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    const { default: Database } = await import('better-sqlite3');
    const file = new Database(join(root, 'data', 'sessions.db'));
    file.exec(BEFORE_ORIGIN);
    file.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at)
      VALUES ('p1', 'iPhone', 'ios', ?, 'active', '111111', 10)`).run('a'.repeat(64));
    file.close();

    vi.resetModules();
    vi.stubEnv('APP_USER_DATA', root);
    await import('../server/db.js');
    const { sqliteMobileDeviceStore: store, sqliteAccountDenyList: denyList } = await import('../server/mobile/deviceStore.js');
    expect(store.get('p1')).toMatchObject({ origin: 'code', accountEmail: null });

    const auth = createDeviceAuth({ store, credentialEpoch: () => 'epoch-1' });
    const { device } = auth.enrollActive({ label: 'Pixel', platform: 'android', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID });
    expect(store.get(device.id)).toMatchObject({
      origin: 'account', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID, status: 'active',
    });
    // The deny list (review H1) keeps a removed account phone out, once per id.
    expect(denyList.has(PHONE_ID)).toBe(false);
    denyList.add(PHONE_ID);
    denyList.add(PHONE_ID);
    expect(denyList.has(PHONE_ID)).toBe(true);
    expect(denyList.has('00000000-0000-4000-8000-0000000000dd')).toBe(false);
    expect(store.listLive().find((r) => r.id === device.id)).toMatchObject({ origin: 'account' });
  });
});
