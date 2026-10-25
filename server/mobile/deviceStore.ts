// deviceStore.ts — the SQLite-backed MobileDeviceStore (table mobile_devices in db.ts)
// and BackendCodeLedger (table mobile_backend_codes, AASC-52).
import * as db from '../db.js';
import type { MobileDeviceRecord, MobileDeviceStore } from './deviceAuth.js';
import type { BackendCodeLedger } from './phoneBackendCode.js';

function fromRow(row: db.MobileDeviceRow): MobileDeviceRecord {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    tokenHash: row.token_hash,
    status: row.status,
    confirmCode: row.confirm_code,
    beCodeRef: row.be_code_ref,
    beCodeRefMacBound: row.be_code_ref_mac_bound === 1,
    credentialEpoch: row.credential_epoch,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export const sqliteMobileDeviceStore: MobileDeviceStore = {
  insert(rec) {
    db.insertMobileDevice({
      id: rec.id,
      label: rec.label,
      platform: rec.platform,
      token_hash: rec.tokenHash,
      status: rec.status,
      confirm_code: rec.confirmCode,
      be_code_ref: rec.beCodeRef,
      be_code_ref_mac_bound: rec.beCodeRefMacBound ? 1 : 0,
      credential_epoch: rec.credentialEpoch,
      created_at: rec.createdAt,
      approved_at: rec.approvedAt,
      last_seen_at: rec.lastSeenAt,
      revoked_at: rec.revokedAt,
    });
  },
  get(id) {
    const row = db.getMobileDevice(id);
    return row ? fromRow(row) : null;
  },
  update(id, patch) {
    db.updateMobileDevice(id, {
      ...(patch.label !== undefined && { label: patch.label }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.approvedAt !== undefined && { approved_at: patch.approvedAt }),
      ...(patch.lastSeenAt !== undefined && { last_seen_at: patch.lastSeenAt }),
      ...(patch.revokedAt !== undefined && { revoked_at: patch.revokedAt }),
      ...(patch.beCodeRef !== undefined && { be_code_ref: patch.beCodeRef }),
      ...(patch.beCodeRefMacBound !== undefined && { be_code_ref_mac_bound: patch.beCodeRefMacBound ? 1 : 0 }),
    });
  },
  listLive() {
    return db.listMobileDevices().map(fromRow);
  },
  remove(id) {
    db.deleteMobileDevice(id);
  },
};

export const sqliteBackendCodeLedger: BackendCodeLedger = {
  record({ codeRef, deviceId, mintedAt, expiresAt }) {
    db.insertMobileBackendCode({ code_ref: codeRef, device_id: deviceId, minted_at: mintedAt, expires_at: expiresAt });
  },
  expiresAt(codeRef) {
    return db.getMobileBackendCode(codeRef)?.expires_at ?? null;
  },
  has(codeRef) {
    return db.getMobileBackendCode(codeRef) !== null;
  },
};
