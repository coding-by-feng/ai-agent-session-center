// cloudPhoneAudit.ts — backend phone devices no paired phone holds any more (AASC-52).
//
// A backend revoke can fail while the Mac side goes through (the backend was
// down); a phone's last code can be redeemed late, by it or by someone who took
// it, after the phone got a new one. Each leaves a live backend push device that
// isn't linked to a phone paired with this Mac. The desktop's phone list shows
// how many, and offers one action that revokes them.
//
// "Unlinked" = a live phone-kind device on the account whose creating code this
// Mac minted (the ledger) and that no phone paired here (pending or active)
// holds. Never this Mac's own device or a non-phone device (the bridge drops
// those), and never a phone another Mac on the same account issued: the
// backend's device list doesn't say which Mac minted a code, so a code this Mac
// has no record of is left alone, and the owner CLI removes those. That includes
// a pre-AASC-52 QR's backend half someone redeemed while nobody redeemed its Mac
// half: the Mac only learned a QR code's ref when a phone redeemed the Mac code.
// (When a phone did, the ref is on its row, and its first backend-code request
// revokes whatever that code made.)
//
// Desktop-only: mounted behind the mobile router's local gate and the dashboard
// session, never on the phone allow-list. Logs counts only.

import type { BackendDevice } from '../cloud/devices.js';
import type { PhoneCloudBridge } from './phoneCloudBridge.js';

export interface CloudPhoneAuditDeps {
  cloud: Pick<PhoneCloudBridge, 'cloudAvailable' | 'listPhoneDevices' | 'revokeDevice'>;
  /** Backend codes bound to phones paired with this Mac now (deviceAuth.linkedBackendCodeRefs). */
  linkedCodeRefs: () => ReadonlySet<string>;
  /** Did this Mac mint this backend code? (BackendCodeLedger.has) */
  mintedHere: (codeRef: string) => boolean;
  warn: (message: string) => void;
}

export type CloudPhoneCount = { cloud: false } | { cloud: true; unlinked: number };
export type CloudPhoneRemoval = { cloud: false } | { cloud: true; removed: number; failed: number };

export function createCloudPhoneAudit(deps: CloudPhoneAuditDeps) {
  /** Read fresh every time: a phone linked a moment ago must never be removed. Null: no cloud. */
  async function unlinked(): Promise<BackendDevice[] | null> {
    if (!deps.cloud.cloudAvailable()) return null;
    const devices = await deps.cloud.listPhoneDevices();
    const linked = deps.linkedCodeRefs();
    return devices.filter((d) => !!d.createdByCode && deps.mintedHere(d.createdByCode) && !linked.has(d.createdByCode));
  }

  return {
    async count(): Promise<CloudPhoneCount> {
      const found = await unlinked();
      return found ? { cloud: true, unlinked: found.length } : { cloud: false };
    },

    /** Revoke every unlinked device, one at a time (the owner has few). */
    async removeUnlinked(): Promise<CloudPhoneRemoval> {
      const found = await unlinked();
      if (!found) return { cloud: false };
      let removed = 0;
      for (const device of found) {
        try {
          await deps.cloud.revokeDevice(device.id);
          removed += 1;
        } catch {
          /* counted below */
        }
      }
      const failed = found.length - removed;
      if (failed > 0) {
        deps.warn(`${failed} cloud phone ${failed === 1 ? 'device' : 'devices'} not linked to a paired phone couldn't be removed`);
      }
      return { cloud: true, removed, failed };
    },
  };
}

export type CloudPhoneAudit = ReturnType<typeof createCloudPhoneAudit>;
