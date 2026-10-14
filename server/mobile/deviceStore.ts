// deviceStore.ts — the SQLite-backed MobileDeviceStore (table mobile_devices in db.ts).
import * as db from '../db.js';
import type { MobileDeviceRecord, MobileDeviceStore } from './deviceAuth.js';

function fromRow(row: db.MobileDeviceRow): MobileDeviceRecord {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    tokenHash: row.token_hash,
    status: row.status,
    confirmCode: row.confirm_code,
    beCodeRef: row.be_code_ref,
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
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.approvedAt !== undefined && { approved_at: patch.approvedAt }),
      ...(patch.lastSeenAt !== undefined && { last_seen_at: patch.lastSeenAt }),
      ...(patch.revokedAt !== undefined && { revoked_at: patch.revokedAt }),
    });
  },
  listLive() {
    return db.listMobileDevices().map(fromRow);
  },
  remove(id) {
    db.deleteMobileDevice(id);
  },
};
