// deviceCodeRefMigration.ts — forget the backend codeRefs phones chose themselves (AASC-51).
//
// Before AASC-51, /pair stored whatever `beCodeRef` the phone sent. Revoking a
// phone now revokes the backend device its codeRef names, so a phone-chosen one
// could point a revoke at another phone's backend device. Rows record who bound
// the codeRef (be_code_ref_mac_bound, set only from attachBackendCode); this
// clears every codeRef the Mac did not bind and says how many phones are left
// for the owner CLI. Same style as db.ts's sessions migration: PRAGMA table_info
// is the source of truth, and a second run finds nothing to do.

import type Database from 'better-sqlite3';

export function migrateMobileDeviceCodeRefs(
  db: Database.Database,
  warn: (message: string) => void,
): number {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(mobile_devices)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!columns.has('be_code_ref_mac_bound')) {
    // DEFAULT 0: every existing row is from before the Mac bound codeRefs.
    db.exec(
      'ALTER TABLE mobile_devices ADD COLUMN be_code_ref_mac_bound INTEGER NOT NULL DEFAULT 0',
    );
  }
  const cleared = db
    .prepare(
      'UPDATE mobile_devices SET be_code_ref = NULL WHERE be_code_ref IS NOT NULL AND be_code_ref_mac_bound = 0',
    )
    .run().changes;
  if (cleared > 0) {
    // A count only: no code, codeRef, device id or token.
    warn(
      `${cleared} ${cleared === 1 ? 'phone' : 'phones'} paired before AASC-51 had a backend code the phone reported; ` +
        'revoking them on this Mac will not revoke their backend devices. Revoke those with the owner CLI ' +
        '(owner devices / owner revoke).',
    );
  }
  return cleared;
}
