// test/mobileBackendCodeStore.test.ts — AASC-52 over real SQLite: binding a backend code to a paired phone,
// and the ledger of every backend code this Mac minted (seeded at startup from the codes phones already hold).
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, vi, afterAll } from 'vitest';
import { sqliteIt } from './helpers/nativeSqlite.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** mobile_devices as AASC-51 left it: one phone holding a Mac-bound code, one a phone-chosen one. */
async function aasc51Db(file: string): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file);
  db.exec(`CREATE TABLE mobile_devices (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, platform TEXT NOT NULL CHECK (platform IN ('ios','android')),
    token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
    confirm_code TEXT NOT NULL, be_code_ref TEXT, be_code_ref_mac_bound INTEGER NOT NULL DEFAULT 0,
    credential_epoch TEXT, created_at INTEGER NOT NULL, approved_at INTEGER, last_seen_at INTEGER, revoked_at INTEGER)`);
  const insert = db.prepare(`INSERT INTO mobile_devices (id, label, platform, token_hash, status, confirm_code, be_code_ref,
    be_code_ref_mac_bound, created_at, approved_at) VALUES (?, 'Phone', 'ios', ?, ?, '123456', ?, ?, 10, ?)`);
  insert.run('bound', 'a'.repeat(64), 'active', 'mac-ref-1', 1, 20);
  insert.run('revoked', 'b'.repeat(64), 'revoked', 'mac-ref-2', 1, null);
  insert.run('none', 'c'.repeat(64), 'active', null, 0, 30);
  db.close();
}

describe('the backend code store (AASC-52)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-becode-'));
  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  sqliteIt('binds a code to a phone, records every code minted, and knows the codes phones held before', async () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    await aasc51Db(join(root, 'data', 'sessions.db'));
    vi.stubEnv('APP_USER_DATA', root);
    const db = await import('../server/db.js');
    const { sqliteMobileDeviceStore, sqliteBackendCodeLedger } = await import('../server/mobile/deviceStore.js');
    try {
      // Seeded at startup from the codes the Mac bound before AASC-52, revoked phones' too.
      expect(sqliteBackendCodeLedger.has('mac-ref-1')).toBe(true);
      expect(sqliteBackendCodeLedger.has('mac-ref-2')).toBe(true);
      expect(sqliteBackendCodeLedger.mintedAt('mac-ref-1')).toBe(20);
      expect(sqliteBackendCodeLedger.has('never-minted')).toBe(false);
      expect(sqliteBackendCodeLedger.mintedAt('never-minted')).toBeNull();

      sqliteMobileDeviceStore.update('none', { beCodeRef: 'new-ref', beCodeRefMacBound: true });
      expect(sqliteMobileDeviceStore.get('none')).toMatchObject({ beCodeRef: 'new-ref', beCodeRefMacBound: true });
      // Other fields untouched; an update without these fields leaves the binding alone.
      sqliteMobileDeviceStore.update('none', { lastSeenAt: 99 });
      expect(sqliteMobileDeviceStore.get('none')).toMatchObject({ beCodeRef: 'new-ref', beCodeRefMacBound: true, lastSeenAt: 99, status: 'active' });

      sqliteBackendCodeLedger.record({ codeRef: 'new-ref', deviceId: 'none', mintedAt: 1234 });
      expect(sqliteBackendCodeLedger.mintedAt('new-ref')).toBe(1234);
      // Recording the same ref twice keeps the first entry.
      sqliteBackendCodeLedger.record({ codeRef: 'new-ref', deviceId: 'other', mintedAt: 5678 });
      expect(sqliteBackendCodeLedger.mintedAt('new-ref')).toBe(1234);
    } finally {
      db.closeDb();
    }
  });
});
