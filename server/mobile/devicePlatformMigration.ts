// devicePlatformMigration.ts — let mobile_devices hold paired computers (Oct 28 2026).
//
// A paired AASC desktop (another computer's AASC, signed in with a device key the
// way a phone is) is a `desktop` row. The table's CHECK allowed only 'ios' and
// 'android', and SQLite can't change a CHECK in place, so the table is rebuilt
// once with the wider one: same columns, same rows, in one transaction. The
// table's own SQL in sqlite_master is the source of truth, and a second run
// finds nothing to do.

import type Database from 'better-sqlite3';

/** mobile_devices as it is created now; db.ts uses the same text for a fresh install. */
export const MOBILE_DEVICES_DDL = `CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android','desktop')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  confirm_code TEXT NOT NULL,
  be_code_ref TEXT,
  be_code_ref_mac_bound INTEGER NOT NULL DEFAULT 0,
  credential_epoch TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER
)`;

/** Rebuild mobile_devices with the `desktop` platform allowed. True when it rebuilt. */
export function migrateMobileDevicePlatforms(db: Database.Database): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mobile_devices'").get() as
    | { sql: string }
    | undefined;
  if (!row || row.sql.includes("'desktop'")) return false;
  const columns = (db.prepare('PRAGMA table_info(mobile_devices)').all() as Array<{ name: string }>).map((c) => c.name);
  const list = columns.map((c) => `"${c}"`).join(', ');
  db.transaction(() => {
    db.exec(MOBILE_DEVICES_DDL.replace('IF NOT EXISTS mobile_devices', 'mobile_devices_next'));
    db.exec(`INSERT INTO mobile_devices_next (${list}) SELECT ${list} FROM mobile_devices`);
    db.exec('DROP TABLE mobile_devices');
    db.exec('ALTER TABLE mobile_devices_next RENAME TO mobile_devices');
  })();
  return true;
}
