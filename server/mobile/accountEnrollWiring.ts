// accountEnrollWiring.ts — how server/index.ts builds plan 17 (phones signed into this Mac's AASC Cloud account).
//
// One place for the setting, the account-phone revoke handler and the enroll service, so a test can build exactly
// what the server builds (test/accountEnrollNoCloud.test.ts). AASC Cloud sign-in is optional: with no connection
// (none saved, or no connector at all) nothing here makes a backend request. Building does none, the status reads
// only the connector's local state, an enroll stops at NOT_THIS_MAC before the redeem, and a revoke is refused by
// the phone cloud bridge before its client is touched (the phone is still deny-listed here).

import { EnrollRedeemError, redeemEnrollTicket } from '../cloud/enroll.js';
import type { CloudConnector } from '../cloud/types.js';
import { createAccountEnroll, type AccountEnroll } from './accountEnroll.js';
import { createAccountEnrollSetting } from './accountEnrollSetting.js';
import { createAccountPhoneRevokedHandler, type AccountDenyList } from './accountPhoneRevocation.js';
import type { DeviceAuth, MobileDeviceRecord } from './deviceAuth.js';
import type { PhoneCloudBridge } from './phoneCloudBridge.js';

export interface AccountEnrollWiringDeps {
  /** This Mac's cloud connector; null when its storage couldn't be opened. */
  cloud: CloudConnector | null;
  phoneCloud: Pick<PhoneCloudBridge, 'revokeDevice'>;
  /** server-config.json, where the desktop's switch saves `phoneAccountEnroll`. */
  configPath: string;
  savedSetting: boolean | undefined;
  env: NodeJS.ProcessEnv;
  pairingOffered: () => boolean;
  passwordEnabled: () => boolean;
  denyList: AccountDenyList;
  info: (message: string) => void;
  warn: (message: string) => void;
}

export interface AccountEnrollWiring {
  setting: ReturnType<typeof createAccountEnrollSetting>;
  /** For createDeviceAuth: an explicit Revoke / Unpair of an account phone (review H1). */
  onRemovedByOwner: (device: MobileDeviceRecord) => void;
  /** The enroll service, once deviceAuth exists (it takes onRemovedByOwner above). */
  createEnroll: (deviceAuth: Pick<DeviceAuth, 'enrollActive' | 'provisionalAccountCount'>) => AccountEnroll;
}

export function createAccountEnrollWiring(deps: AccountEnrollWiringDeps): AccountEnrollWiring {
  const { cloud } = deps;
  const setting = createAccountEnrollSetting({ configPath: deps.configPath, saved: deps.savedSetting, env: deps.env });
  const onRemovedByOwner = createAccountPhoneRevokedHandler({
    denyList: deps.denyList,
    revokeBackendDevice: (deviceId) => deps.phoneCloud.revokeDevice(deviceId),
    warn: deps.warn,
  });
  const createEnroll: AccountEnrollWiring['createEnroll'] = (deviceAuth) => createAccountEnroll({
    enabled: () => setting.enabled(),
    // Review M1 / correctness 3: off with phone pairing off; unavailable without a dashboard password.
    pairingOffered: deps.pairingOffered,
    passwordEnabled: deps.passwordEnabled,
    denyList: deps.denyList,
    cloudStatus: () => cloud?.status() ?? null,
    redeem: (ticket) => (cloud
      ? redeemEnrollTicket(cloud.client, ticket)
      : Promise.reject(new EnrollRedeemError('cloud-failed'))),
    deviceAuth,
    info: deps.info,
  });
  return { setting, onRemovedByOwner, createEnroll };
}
