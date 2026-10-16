// test/mobileBackendCodeStore.test.ts — AASC-52 over real SQLite: binding a backend code to a paired phone,
// and the ledger of every backend code this Mac minted (seeded at every start from the codes phones already hold).
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, vi, afterAll, afterEach } from 'vitest';
import { sqliteIt } from './helpers/nativeSqlite.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** An AASC-51 QR backend code lived 600 s (the ledger adds the margin when it reads it). */
const LEGACY_CODE_LIFE_MS = 600_000;

/** mobile_devices as AASC-51 left it: one phone holding a Mac-bound code, one a phone-chosen one. */
async function aasc51Db(file: string, extra?: (db: import('better-sqlite3').Database) => void): Promise<void> {
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
  extra?.(db);
  db.close();
}

/** A fresh data dir and a fresh db.ts over it (db.ts opens its file at import). */
async function openAt(root: string) {
  vi.resetModules();
  vi.stubEnv('APP_USER_DATA', root);
  const db = await import('../server/db.js');
  const { sqliteMobileDeviceStore, sqliteBackendCodeLedger } = await import('../server/mobile/deviceStore.js');
  return { db, store: sqliteMobileDeviceStore, ledger: sqliteBackendCodeLedger };
}

describe('the backend code store (AASC-52)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-becode-'));
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  sqliteIt('binds a code to a phone, records every code minted with its expiry, and knows the codes phones held before', async () => {
    const dir = join(root, 'fresh');
    mkdirSync(join(dir, 'data'), { recursive: true });
    await aasc51Db(join(dir, 'data', 'sessions.db'));
    const { db, store, ledger } = await openAt(dir);
    try {
      // Seeded at startup from the codes the Mac bound before AASC-52, revoked phones' too, with the
      // 600 s those QR codes lived, counted from when the phone paired (no later than the QR was made).
      expect(ledger.has('mac-ref-1')).toBe(true);
      expect(ledger.has('mac-ref-2')).toBe(true);
      expect(ledger.expiresAt('mac-ref-1')).toBe(10 + LEGACY_CODE_LIFE_MS);
      expect(ledger.expiresAt('mac-ref-2')).toBe(10 + LEGACY_CODE_LIFE_MS);
      expect(ledger.has('never-minted')).toBe(false);
      expect(ledger.expiresAt('never-minted')).toBeNull();

      store.update('none', { beCodeRef: 'new-ref', beCodeRefMacBound: true });
      expect(store.get('none')).toMatchObject({ beCodeRef: 'new-ref', beCodeRefMacBound: true });
      // Other fields untouched; an update without these fields leaves the binding alone.
      store.update('none', { lastSeenAt: 99 });
      expect(store.get('none')).toMatchObject({ beCodeRef: 'new-ref', beCodeRefMacBound: true, lastSeenAt: 99, status: 'active' });

      ledger.record({ codeRef: 'new-ref', deviceId: 'none', mintedAt: 1234, expiresAt: 61_234 });
      expect(ledger.expiresAt('new-ref')).toBe(61_234);
      // Recording the same ref twice keeps the first entry.
      ledger.record({ codeRef: 'new-ref', deviceId: 'other', mintedAt: 5678, expiresAt: 65_678 });
      expect(ledger.expiresAt('new-ref')).toBe(61_234);
    } finally {
      db.closeDb();
    }

    // The seed runs at every start: it changes nothing it already wrote, nor the codes minted since.
    const again = await openAt(dir);
    try {
      expect(again.ledger.expiresAt('mac-ref-1')).toBe(10 + LEGACY_CODE_LIFE_MS);
      expect(again.ledger.expiresAt('new-ref')).toBe(61_234);
    } finally {
      again.db.closeDb();
    }
  });

  sqliteIt('never shortens a code minted over a session that a phone still holds (a ledger from before the expiry column)', async () => {
    const dir = join(root, 'session-held');
    mkdirSync(join(dir, 'data'), { recursive: true });
    await aasc51Db(join(dir, 'data', 'sessions.db'), (raw) => {
      raw.exec('CREATE TABLE mobile_backend_codes (code_ref TEXT PRIMARY KEY, device_id TEXT NOT NULL, minted_at INTEGER NOT NULL)');
      // The phone 'bound' (paired at 10) later got mac-ref-1 over its session, minted at 9 000 000.
      raw.prepare('INSERT INTO mobile_backend_codes (code_ref, device_id, minted_at) VALUES (?, ?, ?)').run('mac-ref-1', 'bound', 9_000_000);
    });
    const { db, ledger } = await openAt(dir);
    try {
      expect(ledger.expiresAt('mac-ref-1')).toBe(9_000_000 + 60_000);
    } finally {
      db.closeDb();
    }
  });

  sqliteIt('gives a ledger from before codes had an expiry one: 600 s for a QR code, 60 s for an AASC-52 one', async () => {
    const dir = join(root, 'pre-expiry');
    mkdirSync(join(dir, 'data'), { recursive: true });
    await aasc51Db(join(dir, 'data', 'sessions.db'), (raw) => {
      raw.exec('CREATE TABLE mobile_backend_codes (code_ref TEXT PRIMARY KEY, device_id TEXT NOT NULL, minted_at INTEGER NOT NULL)');
      const row = raw.prepare('INSERT INTO mobile_backend_codes (code_ref, device_id, minted_at) VALUES (?, ?, ?)');
      row.run('mac-ref-1', 'bound', 20); // the old seed: a QR code, its phone's approval time
      row.run('minted-52', 'none', 5_000); // a code minted over the phone's session before this column
    });
    const { db, ledger } = await openAt(dir);
    try {
      expect(ledger.expiresAt('mac-ref-1')).toBe(10 + LEGACY_CODE_LIFE_MS);
      expect(ledger.expiresAt('minted-52')).toBe(5_000 + 60_000);
      expect(ledger.expiresAt('mac-ref-2')).toBe(10 + LEGACY_CODE_LIFE_MS);
    } finally {
      db.closeDb();
    }
  });
});
