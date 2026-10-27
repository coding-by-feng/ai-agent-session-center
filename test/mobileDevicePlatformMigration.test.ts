// test/mobileDevicePlatformMigration.test.ts — paired computers (Oct 28 2026): mobile_devices' platform CHECK
// allowed only 'ios' and 'android', and SQLite can't widen a CHECK in place. The migration rebuilds the table
// once with 'desktop' allowed, keeping every row and column; a second run does nothing.
import { describe, expect } from 'vitest';
import { sqliteIt } from './helpers/nativeSqlite.js';
import { MOBILE_DEVICES_DDL, migrateMobileDevicePlatforms } from '../server/mobile/devicePlatformMigration.js';

/** mobile_devices as AASC-51 left it: the codeRef column, the phone-only CHECK. */
const PHONE_ONLY_TABLE = MOBILE_DEVICES_DDL.replace("'ios','android','desktop'", "'ios','android'");

type Db = import('better-sqlite3').Database;
async function phoneOnlyDb(): Promise<Db> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(PHONE_ONLY_TABLE);
  db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, be_code_ref,
    be_code_ref_mac_bound, credential_epoch, created_at, approved_at) VALUES
    ('p1', 'iPhone', 'ios', ?, 'active', '111111', 'ref-1', 1, 'epoch', 10, 20)`).run('a'.repeat(64));
  db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at, revoked_at)
    VALUES ('p2', 'Pixel', 'android', ?, 'revoked', '222222', 11, 30)`).run('b'.repeat(64));
  return db;
}

const insertDesktop = (db: Db) => db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status,
  confirm_code, created_at) VALUES ('c1', 'studio-mac', 'desktop', ?, 'pending', '333333', 12)`).run('c'.repeat(64));

describe('migrateMobileDevicePlatforms', () => {
  sqliteIt('refuses a desktop row before, takes one after, and keeps every existing row as it was', async () => {
    const db = await phoneOnlyDb();
    expect(() => insertDesktop(db)).toThrow(/CHECK/);
    const before = db.prepare('SELECT * FROM mobile_devices ORDER BY id').all();
    expect(migrateMobileDevicePlatforms(db)).toBe(true);
    expect(db.prepare('SELECT * FROM mobile_devices ORDER BY id').all()).toEqual(before);
    insertDesktop(db);
    expect(db.prepare("SELECT platform FROM mobile_devices WHERE id = 'c1'").get()).toEqual({ platform: 'desktop' });
    // The other CHECK and the unique token hash survive the rebuild.
    expect(() => db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at)
      VALUES ('x', 'x', 'windows', ?, 'active', '0', 1)`).run('d'.repeat(64))).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, created_at)
      VALUES ('y', 'y', 'ios', ?, 'active', '0', 1)`).run('a'.repeat(64))).toThrow(/UNIQUE/);
  });

  sqliteIt('does nothing on a second run, on a fresh table, or with no table', async () => {
    const db = await phoneOnlyDb();
    expect(migrateMobileDevicePlatforms(db)).toBe(true);
    expect(migrateMobileDevicePlatforms(db)).toBe(false);
    const { default: Database } = await import('better-sqlite3');
    const fresh = new Database(':memory:');
    fresh.exec(MOBILE_DEVICES_DDL);
    expect(migrateMobileDevicePlatforms(fresh)).toBe(false);
    expect(migrateMobileDevicePlatforms(new Database(':memory:'))).toBe(false);
  });
});
