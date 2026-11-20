// machineAccountSettings.ts — what this computer tells and allows its AASC Cloud account (plan 18, stage 2).
//
//   showOnAccount   "Show this computer to my account": publish its addresses to the account's directory
//                   (machineDirectoryPublisher.ts) and let the account's computers connect (computerEnroll.ts).
//                   On by default; it does nothing until the computer is signed in.
//   addresses       which addresses are published: home network on, Tailscale on, Public IP OFF until ticked
//                   (a public address is plain HTTP across the Internet).
//   computerEnroll  'ask': Allow once on this machine for each computer (the default).
//                   'auto': the account's computers connect without asking.
//
// Where they live:
//   server-config.json  "showOnAccount": false · "accountAddresses": { "lan", "tailnet", "public" } ·
//                       "computerAccountEnroll": "auto"   (the device panel writes these)
//   environment         AASC_SHOW_ON_ACCOUNT=1|0 (or true|false) · AASC_COMPUTER_ACCOUNT_ENROLL=ask|auto
// A variable wins over the file, as AASC_PHONE_PAIRING does, for a headless server. Anything that can't be read
// falls to the careful side: Public IP off, and ask.

import { saveServerConfigKeys } from './accountEnrollSetting.js';
import type { ComputerEnrollMode } from './computerEnroll.js';

export interface MachineAccountSettings {
  showOnAccount: boolean;
  addresses: { lan: boolean; tailnet: boolean; public: boolean };
  computerEnroll: ComputerEnrollMode;
}

/** The keys of server-config.json (ServerConfig). */
export interface MachineAccountConfig {
  showOnAccount?: boolean;
  accountAddresses?: { lan?: boolean; tailnet?: boolean; public?: boolean };
  computerAccountEnroll?: ComputerEnrollMode;
}

/** A setting the environment decides, so the device panel can't. */
export type PinnedSetting = 'showOnAccount' | 'computerEnroll';

type Env = Readonly<Record<string, string | undefined>>;

function showFromEnv(env: Env): boolean | null {
  const raw = (env.AASC_SHOW_ON_ACCOUNT ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function enrollFromEnv(env: Env): ComputerEnrollMode | null {
  const raw = (env.AASC_COMPUTER_ACCOUNT_ENROLL ?? '').trim().toLowerCase();
  return raw === 'ask' || raw === 'auto' ? raw : null;
}

export function resolveMachineAccountSettings(config: MachineAccountConfig, env: Env): MachineAccountSettings {
  const addresses: MachineAccountConfig['accountAddresses'] =
    config.accountAddresses !== null && typeof config.accountAddresses === 'object' ? config.accountAddresses : {};
  return {
    // Only a real `false` turns these off, and only a real `true` or 'auto' turns the careful ones on.
    showOnAccount: showFromEnv(env) ?? config.showOnAccount !== false,
    addresses: {
      lan: addresses.lan !== false,
      tailnet: addresses.tailnet !== false,
      public: addresses.public === true,
    },
    computerEnroll: enrollFromEnv(env) ?? (config.computerAccountEnroll === 'auto' ? 'auto' : 'ask'),
  };
}

export interface MachineAccountSettingsOptions {
  /** server-config.json (serverConfig.ts CONFIG_PATH). */
  configPath: string;
  /** The three keys as server-config.json had them at startup. */
  saved: MachineAccountConfig;
  env: Env;
}

export type SaveOutcome = { ok: true } | { ok: false; pinned: PinnedSetting };

export function createMachineAccountSettings(opts: MachineAccountSettingsOptions) {
  let saved: MachineAccountConfig = { ...opts.saved };
  const listeners = new Set<(settings: MachineAccountSettings) => void>();
  const get = (): MachineAccountSettings => resolveMachineAccountSettings(saved, opts.env);

  return {
    get,
    /** The settings the environment decides, in a fixed order. */
    pinnedByEnv(): PinnedSetting[] {
      return [
        ...(showFromEnv(opts.env) !== null ? ['showOnAccount' as const] : []),
        ...(enrollFromEnv(opts.env) !== null ? ['computerEnroll' as const] : []),
      ];
    },
    /**
     * Save the choice. Refused, with nothing written, when it would change a setting the environment pins;
     * a pinned setting left as it is saves the rest (and is itself never written). Throws when the file
     * can't be updated.
     */
    set(next: MachineAccountSettings): SaveOutcome {
      const show = showFromEnv(opts.env);
      const enroll = enrollFromEnv(opts.env);
      if (show !== null && next.showOnAccount !== show) return { ok: false, pinned: 'showOnAccount' };
      if (enroll !== null && next.computerEnroll !== enroll) return { ok: false, pinned: 'computerEnroll' };
      const patch: MachineAccountConfig = {
        ...(show === null ? { showOnAccount: next.showOnAccount } : {}),
        accountAddresses: { lan: next.addresses.lan, tailnet: next.addresses.tailnet, public: next.addresses.public },
        ...(enroll === null ? { computerAccountEnroll: next.computerEnroll } : {}),
      };
      saveServerConfigKeys(opts.configPath, { ...patch });
      saved = { ...saved, ...patch };
      const now = get();
      for (const listener of listeners) {
        try {
          listener(now);
        } catch {
          // A listener's fault is its own: the choice is saved.
        }
      }
      return { ok: true };
    },
    /** Told after every save. Returns the way to stop. */
    onChange(listener: (settings: MachineAccountSettings) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type MachineAccountSettingsStore = ReturnType<typeof createMachineAccountSettings>;
