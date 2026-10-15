// test/mobileDeviceCodeRefMigration.test.ts — AASC-51 review: phones paired before AASC-51 hold a backend
// codeRef the PHONE chose (main's /pair took it from the request body). A revoke must never act on one, so
// a one-time startup migration clears every codeRef the Mac did not bind itself, and says how many phones
// need the owner CLI revoke of their backend device instead. No code and no token reaches the log.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, vi, afterAll } from 'vitest';
import { sqliteIt } from './helpers/nativeSqlite.js';
import { migrateMobileDeviceCodeRefs } from '../server/mobile/deviceCodeRefMigration.js';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../server/logger.js', () => ({ default: mockLog }));

/** mobile_devices as main created it (AASC-15): no record of who chose the codeRef. */
const LEGACY_TABLE = `CREATE TABLE mobile_devices (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
  confirm_code TEXT NOT NULL,
  be_code_ref TEXT,
  credential_epoch TEXT,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  last_seen_at INTEGER,
  revoked_at INTEGER
)`;

type Db = import('better-sqlite3').Database;
async function legacyDb(file = ':memory:'): Promise<Db> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file);
  db.exec(LEGACY_TABLE);
  const insert =
    db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, be_code_ref, created_at)
    VALUES (?, ?, 'ios', ?, ?, '123456', ?, 1)`);
  insert.run('phone-a', 'Active phone', 'a'.repeat(64), 'active', 'phone-chosen-ref-a');
  insert.run('phone-b', 'Revoked phone', 'b'.repeat(64), 'revoked', 'phone-chosen-ref-b');
  insert.run('phone-c', 'No backend', 'c'.repeat(64), 'active', null);
  return db;
}
const rows = (db: Db) =>
  db.prepare('SELECT id, be_code_ref, be_code_ref_mac_bound FROM mobile_devices ORDER BY id').all();

describe('migrateMobileDeviceCodeRefs', () => {
  sqliteIt(
    'clears every phone-chosen codeRef once and logs only how many phones need the owner revoke',
    async () => {
      const db = await legacyDb();
      const info = vi.fn();
      expect(migrateMobileDeviceCodeRefs(db, info)).toBe(2);
      expect(rows(db)).toEqual([
        { id: 'phone-a', be_code_ref: null, be_code_ref_mac_bound: 0 },
        { id: 'phone-b', be_code_ref: null, be_code_ref_mac_bound: 0 },
        { id: 'phone-c', be_code_ref: null, be_code_ref_mac_bound: 0 },
      ]);
      expect(info).toHaveBeenCalledTimes(1);
      const message = String(info.mock.calls[0][0]);
      expect(message).toMatch(/\b2 phones\b/);
      expect(message).toMatch(/owner revoke/);
      for (const secret of ['phone-chosen', 'aaaa', 'bbbb', 'phone-a', 'phone-b'])
        expect(message).not.toContain(secret);
      // A codeRef the Mac binds afterwards is kept, and the migration has nothing left to do.
      db.prepare(
        `INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, be_code_ref, be_code_ref_mac_bound, created_at)
      VALUES ('phone-d', 'New phone', 'ios', ?, 'active', '654321', 'mac-ref', 1, 2)`,
      ).run('d'.repeat(64));
      expect(migrateMobileDeviceCodeRefs(db, info)).toBe(0);
      expect(info).toHaveBeenCalledTimes(1);
      expect(
        db.prepare("SELECT be_code_ref FROM mobile_devices WHERE id = 'phone-d'").get(),
      ).toEqual({ be_code_ref: 'mac-ref' });
      db.close();
    },
  );
});

describe('at startup (db.ts)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-coderef-'));
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  sqliteIt(
    'an existing database is migrated when the server opens it, and the store reports nothing Mac-bound',
    async () => {
      mkdirSync(join(root, 'data'), { recursive: true });
      (await legacyDb(join(root, 'data', 'sessions.db'))).close();
      vi.stubEnv('APP_USER_DATA', root);
      const db = await import('../server/db.js');
      const { sqliteMobileDeviceStore } = await import('../server/mobile/deviceStore.js');
      try {
        expect(sqliteMobileDeviceStore.get('phone-a')).toMatchObject({
          beCodeRef: null,
          beCodeRefMacBound: false,
        });
        const warned = mockLog.warn.mock.calls.filter(([, m]) => /owner revoke/.test(String(m)));
        expect(warned).toHaveLength(1);
        // Once: a second pass over the same file changes nothing and says nothing.
        expect(migrateMobileDeviceCodeRefs(db.dbHandle(), vi.fn())).toBe(0);
        // A new phone the Mac binds keeps its codeRef through the store.
        sqliteMobileDeviceStore.insert({
          id: 'phone-new',
          label: 'New',
          platform: 'android',
          tokenHash: 'e'.repeat(64),
          status: 'pending',
          confirmCode: '111111',
          beCodeRef: 'mac-ref',
          beCodeRefMacBound: true,
          credentialEpoch: null,
          createdAt: 5,
          approvedAt: null,
          lastSeenAt: null,
          revokedAt: null,
        });
        expect(sqliteMobileDeviceStore.get('phone-new')).toMatchObject({
          beCodeRef: 'mac-ref',
          beCodeRefMacBound: true,
        });
      } finally {
        db.closeDb();
      }
    },
  );
});
