// accountPhoneRevocation.ts — removing an account phone sticks (plan 17, review H1).
//
// A phone that enrolled through the AASC Cloud account (origin 'account') could otherwise come straight back:
// it still holds its account sign-in, so one tap re-enrolls it. When the owner removes it on purpose (Revoke on
// the desktop, or Unpair from the phone; deviceAuth onRemovedByOwner), two things happen:
//   a) its backend phone device (the redeem's phoneDeviceId) is revoked through this Mac's cloud connection,
//      which signs the phone out of AASC Cloud. On its own: a slow or unreachable cloud never holds up the
//      revoke on the Mac, and a failure is logged without ids or tokens.
//   b) that id goes on a local deny list, which account enroll checks right after the redeem (PHONE_REVOKED),
//      so the phone stays out even if (a) never reached the cloud.
// Signing in with Google on that phone again makes a new backend device, so it can connect again unless the
// owner turns account phones off. A password change, a pending or provisional expiry and a replaced twin are
// not "on purpose" and never get here. Code-paired rows are left to phoneRevocation.ts.

import type { MobileDeviceRecord } from './deviceAuth.js';

export interface AccountDenyList {
  has(phoneDeviceId: string): boolean;
  add(phoneDeviceId: string): void;
}

export interface AccountPhoneRevocationDeps {
  denyList: AccountDenyList;
  /** Revoke one backend device through this Mac's cloud connection (DELETE /v1/devices/:id). */
  revokeBackendDevice: (deviceId: string) => Promise<void>;
  warn: (message: string) => void;
}

export function createAccountPhoneRevokedHandler(deps: AccountPhoneRevocationDeps): (device: MobileDeviceRecord) => void {
  return (device) => {
    if (device.origin !== 'account' || !device.accountPhoneId) return;
    const phoneId = device.accountPhoneId;
    try {
      deps.denyList.add(phoneId);
    } catch (err) {
      deps.warn(`Couldn't record a removed account phone: ${err instanceof Error ? err.message : String(err)}`);
    }
    void Promise.resolve()
      .then(() => deps.revokeBackendDevice(phoneId))
      .catch(() => deps.warn(`Couldn't sign ${device.label} out of AASC Cloud; it stays refused on this Mac.`));
  };
}
