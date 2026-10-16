// phoneRevocation.ts — what removing a phone from this Mac does (AASC-15, AASC-51, AASC-52).
//
// One revoke cuts everything the phone holds, whichever way it goes: the Mac
// revokes it (Revoke on the desktop, or a dashboard password change: at once
// when the server starts with the new password), the desktop denies it while
// pending, or the phone unpairs itself.
//
//   1. every session token the phone holds ends (not at the next refresh)
//   2. its live sockets are terminated
//   3. the backend device it created from the backend code the Mac issued it
//      is revoked through the Mac's cloud connection (phoneCloudBridge.ts).
//      That runs on its own: a slow or unreachable backend never holds up 1
//      and 2. Only a code the Mac bound counts: a phone paired before AASC-51
//      named its own, which could be another phone's (deviceCodeRefMigration.ts).

import type { DeviceAuth, MobileDeviceRecord } from './deviceAuth.js';

export interface PhoneRevocationDeps {
  revokeTokens: (deviceId: string) => void;
  disconnect: (deviceId: string) => void;
  /** Revoke the backend device made from this backend code; never throws. */
  revokeBackend: (codeRef: string | null) => Promise<void>;
  info: (message: string) => void;
}

export function createPhoneRevokedHandler(deps: PhoneRevocationDeps): (device: MobileDeviceRecord) => void {
  return (device) => {
    deps.revokeTokens(device.id);
    deps.disconnect(device.id);
    void deps.revokeBackend(device.beCodeRefMacBound ? device.beCodeRef : null);
    deps.info(`Phone access removed: ${device.label} (${device.platform})`);
  };
}

/**
 * A dashboard password change, as the server sees it: the password is read at
 * startup, so every phone paired under the old one is revoked right then,
 * backend device included, not at its next sign-in. Run once after the cloud
 * connection is open; the backend revokes run on their own and never hold up
 * the start. Logs a count only.
 */
export function revokePhonesFromOldPassword(
  deviceAuth: Pick<DeviceAuth, 'revokeStaleCredentials'>,
  info: (message: string) => void,
): number {
  const revoked = deviceAuth.revokeStaleCredentials();
  if (revoked > 0) {
    info(`The dashboard password changed: ${revoked} paired ${revoked === 1 ? 'phone was' : 'phones were'} revoked, `
      + 'with their cloud devices. Pair them again.');
  }
  return revoked;
}
