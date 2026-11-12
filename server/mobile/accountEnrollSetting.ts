// accountEnrollSetting.ts — may phones signed into this Mac's AASC Cloud account connect without a QR? (plan 17)
//
// On by default. Turning it off:
//   server-config.json  "phoneAccountEnroll": false   (the desktop's checkbox writes this)
//   environment         AASC_PHONE_ACCOUNT_ENROLL=0 (or false); 1 / true turns it on
// The variable wins over the file, as AASC_PHONE_PAIRING does (pairingOffer.ts). Phones enrolled before are
// never affected: they list, sign in and revoke like any phone.
//
// The checkbox saves into server-config.json, which also holds the password hash: read, change one key, write
// to a temp file (owner-only) and rename. A file that isn't a JSON object is never overwritten.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export interface AccountEnrollConfig {
  phoneAccountEnroll?: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The environment's say: true, false, or null when it says nothing this understands. */
function fromEnv(env: Env): boolean | null {
  const raw = (env.AASC_PHONE_ACCOUNT_ENROLL ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

export function isPhoneAccountEnrollOn(config: AccountEnrollConfig, env: Env): boolean {
  return fromEnv(env) ?? config.phoneAccountEnroll !== false;
}

export interface AccountEnrollSettingOptions {
  /** server-config.json (serverConfig.ts CONFIG_PATH). */
  configPath: string;
  /** `phoneAccountEnroll` as server-config.json had it at startup. */
  saved: boolean | undefined;
  env: Env;
}

/** Read the config file as an object, `{}` when there is none; throws for anything else, so nothing is overwritten. */
function readConfigObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('server-config.json is not a JSON object; not changing it');
  }
  return value as Record<string, unknown>;
}

export function createAccountEnrollSetting(opts: AccountEnrollSettingOptions) {
  let saved = opts.saved;
  return {
    enabled(): boolean {
      return isPhoneAccountEnrollOn({ phoneAccountEnroll: saved }, opts.env);
    },
    /** True when AASC_PHONE_ACCOUNT_ENROLL decides, so the checkbox can't. */
    pinnedByEnv(): boolean {
      return fromEnv(opts.env) !== null;
    },
    /** Save the choice. False (nothing written) when the environment pins it; throws when the file can't be updated. */
    set(on: boolean): boolean {
      if (fromEnv(opts.env) !== null) return false;
      const next = { ...readConfigObject(opts.configPath), phoneAccountEnroll: on };
      mkdirSync(dirname(opts.configPath), { recursive: true });
      const tmp = `${opts.configPath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, opts.configPath);
      saved = on;
      return true;
    },
  };
}

export type AccountEnrollSetting = ReturnType<typeof createAccountEnrollSetting>;
