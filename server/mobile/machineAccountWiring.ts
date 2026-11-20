// machineAccountWiring.ts — how server/index.ts builds plan 18, stage 2 ("one account, all devices").
//
// One place for the settings, the directory publisher, the connector the cloud routes use, the rule for a
// revoked account computer and the enroll service, so a test can build exactly what the server builds
// (test/machineAccountWiring.test.ts). AASC Cloud sign-in is optional: with no connection (none saved, or no
// connector at all) nothing here makes a backend request. Building makes none, the publisher asks nothing,
// an enroll stops at NOT_THIS_MACHINE before the redeem, and revoking a computer only writes the local deny list.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { MachineRedeemError, redeemMachineTicket } from '../cloud/machines.js';
import type { CloudConnector } from '../cloud/types.js';
import { createAccountComputerRemovedHandler } from './accountComputerRemoval.js';
import {
  createAccountDeviceReconcile, withAccountDeviceReconcile, type AccountDeviceReconcile,
} from './accountDeviceReconcile.js';
import type { AccountDenyList } from './accountPhoneRevocation.js';
import type { PublishedAddresses } from './boundAddress.js';
import { createComputerEnroll, type ComputerEnroll } from './computerEnroll.js';
import type { DeviceAuth, MobileDeviceRecord, OwnerRemoval } from './deviceAuth.js';
import {
  createMachineAccountSettings, type MachineAccountConfig, type MachineAccountSettingsStore,
} from './machineAccountSettings.js';
import {
  createMachineDirectoryPublisher, directoryAddresses, withMachineDirectory, type DirectoryTarget,
  type MachineDirectoryDeps, type MachineDirectoryPublisher,
} from './machineDirectoryPublisher.js';

export interface MachineAccountWiringDeps {
  /** This computer's cloud connector; null when its storage couldn't be opened. */
  cloud: CloudConnector | null;
  /** server-config.json, where the device panel saves the settings. */
  configPath: string;
  /** `showOnAccount`, `accountAddresses` and `computerAccountEnroll` as server-config.json had them at startup. */
  savedSettings: MachineAccountConfig;
  env: NodeJS.ProcessEnv;
  /** Is pairing offered at all (pairingOffer.ts)? Off turns account computers off too. */
  pairingOffered: () => boolean;
  /** Is a dashboard password set? Without one every device route is refused. */
  passwordEnabled: () => boolean;
  /** The pairing target (pairingTarget.ts): the one source of this computer's addresses and of the port others dial. */
  target: () => Promise<DirectoryTarget>;
  /** Devices the owner removed on purpose (the table account phones use: backend device ids). */
  denyList: AccountDenyList;
  /** A private file for the account the publisher last published to; null keeps it in memory only. */
  rememberedFile: string | null;
  info: (message: string) => void;
  warn: (message: string) => void;
  debug: (message: string) => void;
}

export interface MachineAccountWiring {
  settings: MachineAccountSettingsStore;
  /** Null without a connector. Started and stopped by the server. */
  publisher: MachineDirectoryPublisher | null;
  /** The connector for the cloud routes: the directory follows a sign-in and a sign-out. Null without one. */
  connector: CloudConnector | null;
  /**
   * What a request's Host may name for an answer to be bound to it (boundAddress.ts): this computer's public
   * address and its Tailscale address, as it would publish them now. Null while it is not shown to its account.
   */
  publishedAddresses: () => Promise<PublishedAddresses | null>;
  /** For createDeviceAuth, beside the account phone's handler: Revoke of an account computer keeps it out. */
  onRemovedByOwner: (device: MobileDeviceRecord, how: OwnerRemoval) => void;
  /** The enroll service, once deviceAuth exists (it takes onRemovedByOwner above). */
  createEnroll: (deviceAuth: Pick<DeviceAuth, 'enrollComputer' | 'waitingAccountCount'>) => ComputerEnroll;
  /**
   * The reconcile (accountDeviceReconcile.ts), once deviceAuth exists: this machine drops the records of devices
   * the account signed out. Null without a connector. Started and stopped by the server; a sign-in and a
   * sign-out through `connector` reach it by themselves.
   */
  createReconcile: (deviceAuth: Pick<DeviceAuth, 'accountDeviceRecords' | 'revokeSignedOut'>) => AccountDeviceReconcile | null;
}

/**
 * The account last published to, in a small private file (it holds the backend's origin and the account's id,
 * never a token). A file that can't be read counts as "never published"; one that can't be written is a warning.
 */
function rememberedAccount(file: string | null, warn: (message: string) => void): MachineDirectoryDeps['remembered'] {
  let loaded = false;
  let account: string | null = null;
  return {
    get() {
      if (!loaded) {
        loaded = true;
        if (file) {
          try {
            const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
            const saved = (value as { account?: unknown } | null)?.account;
            account = typeof saved === 'string' ? saved : null;
          } catch {
            account = null;
          }
        }
      }
      return account;
    },
    set(next) {
      loaded = true;
      account = next;
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ account: next })}\n`, { mode: 0o600 });
        renameSync(tmp, file);
      } catch (err) {
        warn(`Couldn't record where this computer is published: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

export function createMachineAccountWiring(deps: MachineAccountWiringDeps): MachineAccountWiring {
  const { cloud } = deps;
  const settings = createMachineAccountSettings({ configPath: deps.configPath, saved: deps.savedSettings, env: deps.env });

  const publisher = cloud
    ? createMachineDirectoryPublisher({
        cloud,
        settings: () => settings.get(),
        // Publishing a computer nobody could connect to would tell the cloud its addresses for nothing.
        // Pairing off is named first, as the phone switch's status does (accountEnroll.ts).
        unreachable: () => (!deps.pairingOffered() ? 'pairing-off' : !deps.passwordEnabled() ? 'no-password' : null),
        target: deps.target,
        remembered: rememberedAccount(deps.rememberedFile, deps.warn),
        log: { warn: deps.warn, debug: deps.debug },
      })
    : null;
  // A saved setting is the owner's own act: look again at once, and ask an account that refused before.
  if (publisher) settings.onChange(() => void publisher.check({ retryRefused: true }));

  /**
   * What a Host may name (boundAddress.ts has the rule and the reasons). It is what this computer would publish
   * under the settings as they stand, whether or not the backend has been reached: a machine may vouch for an
   * address it knows is its own. The public address only with "Public IP" ticked and one known; the Tailscale
   * address only with its tick on and Tailscale connected; nothing while the computer is not shown to its
   * account. The home-network address is published too, and is deliberately not passed on: it is never bound by
   * Host.
   */
  const publishedAddresses = async (): Promise<PublishedAddresses | null> => {
    const now = settings.get();
    if (!now.showOnAccount) return null;
    const told = directoryAddresses(await deps.target(), now);
    return { public: told.public, tailnet: told.tailnet, port: told.port };
  };

  const onRemovedByOwner = createAccountComputerRemovedHandler({ denyList: deps.denyList, warn: deps.warn });

  const createEnroll: MachineAccountWiring['createEnroll'] = (deviceAuth) => createComputerEnroll({
    // "Show this computer to my account" off is the off switch for account computers too.
    offered: () => deps.pairingOffered() && settings.get().showOnAccount,
    mode: () => settings.get().computerEnroll,
    denyList: deps.denyList,
    cloudStatus: () => cloud?.status() ?? null,
    redeem: (ticket) => (cloud
      ? redeemMachineTicket(cloud.client, ticket)
      : Promise.reject(new MachineRedeemError('cloud-failed'))),
    deviceAuth,
    info: deps.info,
  });

  // Made after this wiring (it needs the device records), reached by the connector below once it exists.
  let reconcile: AccountDeviceReconcile | null = null;
  const createReconcile: MachineAccountWiring['createReconcile'] = (deviceAuth) => {
    reconcile = cloud ? createAccountDeviceReconcile({ cloud, deviceAuth, info: deps.info, debug: deps.debug }) : null;
    return reconcile;
  };

  return {
    settings,
    publisher,
    connector: cloud && publisher
      ? withAccountDeviceReconcile(withMachineDirectory(cloud, publisher), () => reconcile)
      : cloud,
    publishedAddresses,
    onRemovedByOwner,
    createEnroll,
    createReconcile,
  };
}
