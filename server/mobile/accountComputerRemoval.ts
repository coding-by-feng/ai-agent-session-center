// accountComputerRemoval.ts — revoking an account computer on this machine sticks (plan 18, stage 2).
//
// A computer that connected through the AASC Cloud account (origin 'account', platform 'desktop') still holds
// its account sign-in, so with "connect without asking" on it could come straight back. When the owner revokes
// it HERE (Revoke in "Phones & computers"; deviceAuth onRemovedByOwner with 'revoke'), its backend device id
// (the redeem's clientDeviceId) goes on the local deny list, which computerEnroll checks right after the redeem
// (CLIENT_REVOKED).
//
// Two things differ from an account phone (accountPhoneRevocation.ts), on purpose:
//   - That computer is NOT signed out of AASC Cloud. It is a machine of its own, with its own sync and its own
//     place in the directory; being removed from this machine must not take those away. So no backend call.
//   - A computer that removes ITSELF ('unpair': Remove in its own list) is not denied. Its owner chose that
//     there, and may press Connect there again; with "ask" this machine still asks.
// A denied computer connects again once it has signed in to AASC Cloud anew, which gives it a new backend
// device id. A password change, an expiry, a Deny of a pending request and a replaced record never get here.

import type { AccountDenyList } from './accountPhoneRevocation.js';
import type { MobileDeviceRecord, OwnerRemoval } from './deviceAuth.js';

export interface AccountComputerRemovalDeps {
  denyList: Pick<AccountDenyList, 'add'>;
  warn: (message: string) => void;
}

export function createAccountComputerRemovedHandler(
  deps: AccountComputerRemovalDeps,
): (device: MobileDeviceRecord, how: OwnerRemoval) => void {
  return (device, how) => {
    if (device.origin !== 'account' || device.platform !== 'desktop' || !device.accountPhoneId) return;
    if (how !== 'revoke') return;
    try {
      deps.denyList.add(device.accountPhoneId);
    } catch (err) {
      deps.warn(`Couldn't record a removed account computer: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}
