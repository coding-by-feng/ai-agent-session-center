// deviceOriginMigration.ts — record how each paired device was paired (plan 17).
//
// A phone signed into this Mac's AASC Cloud account can enroll without a code (accountEnroll.ts). Its row says
// so: `origin` 'account' (others 'code', the default every existing row gets), the account's email and the phone's
// backend device id. Adding a
// column with a default and a CHECK needs no rebuild, so this only ALTERs, once: a second run, a fresh table
// (MOBILE_DEVICES_DDL has both) or no table at all finds nothing to do.

import type Database from 'better-sqlite3';

const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['origin', "origin TEXT NOT NULL DEFAULT 'code' CHECK (origin IN ('code','account'))"],
  ['account_email', 'account_email TEXT'],
  // Review H1: the phone's backend device id, for an explicit Revoke / Unpair to revoke and deny.
  ['account_phone_id', 'account_phone_id TEXT'],
];

/** Add `origin`, `account_email` and `account_phone_id` to mobile_devices where missing. True when it added any. */
export function migrateMobileDeviceOrigin(db: Database.Database): boolean {
  const have = new Set(
    (db.prepare('PRAGMA table_info(mobile_devices)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (have.size === 0) return false;
  const missing = COLUMNS.filter(([name]) => !have.has(name));
  if (missing.length === 0) return false;
  db.transaction(() => {
    for (const [, definition] of missing) db.exec(`ALTER TABLE mobile_devices ADD COLUMN ${definition}`);
  })();
  return true;
}
