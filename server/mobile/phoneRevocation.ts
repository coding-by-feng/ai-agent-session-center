// phoneRevocation.ts — what removing a phone from this Mac does (AASC-15, AASC-51).
//
// One revoke cuts everything the phone holds, whichever way it goes: the Mac
// revokes it (Revoke on the desktop, or a dashboard password change at its next
// sign-in), the desktop denies it while pending, or the phone unpairs itself.
//
//   1. every session token the phone holds ends (not at the next refresh)
//   2. its live sockets are terminated
//   3. the backend device it created from the pairing QR's backend code is
//      revoked through the Mac's cloud connection (phoneCloudBridge.ts). That
//      runs on its own: a slow or unreachable backend never holds up 1 and 2.

import type { MobileDeviceRecord } from './deviceAuth.js';

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
    void deps.revokeBackend(device.beCodeRef);
    deps.info(`Phone access removed: ${device.label} (${device.platform})`);
  };
}
