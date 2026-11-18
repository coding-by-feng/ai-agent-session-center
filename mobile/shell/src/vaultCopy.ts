// vaultCopy.ts — the saved Mac list and the Mac used last, also kept in the vault (Nov 17 2026).
//
// Deleting the app wipes Preferences, but on iOS not the Keychain, where each Mac's device token already lives.
// The iPhone 17 was paired again with a QR code after each reinstall (TestFlight and Xcode builds swapped) while
// the Mac still had it: the token was there, the list pointing at it was gone. With a copy of the list in the
// vault, a reinstall finds its Macs and signs in with the kept token through the usual key proof.
//
// Only a WIPED value (null) falls back to the copy; a saved list, even an empty one, is never overridden, so a
// Mac the user forgot stays forgotten. A restored list keeps only the Macs whose device token is still in the
// vault, and loadMacs validates it as it does any list. Android's vault is wiped with the app (its Keystore key
// goes too), so there the copy is gone as well and nothing changes.
import type { DeviceVault } from './native.js';
import type { KeyValueStore } from './pushRegistration.js';
import { LAST_MAC_KEY, MACS_KEY } from './savedMacs.js';

/** Vault keys of the copies: `saved.aasc.macs.v1`, `saved.aasc.lastMac` (native `isVaultKey`: [A-Za-z0-9._-]). */
export const VAULT_COPY_PREFIX = 'saved.';
const COPIED = new Set([MACS_KEY, LAST_MAC_KEY]);
const copyKey = (key: string) => `${VAULT_COPY_PREFIX}${key}`;

/** The vault read, or null when it can't be read (a locked phone, no vault): nothing is restored then. */
async function readCopy(vault: DeviceVault, key: string): Promise<string | null> {
  try {
    return await vault.get(key);
  } catch {
    return null;
  }
}

/** The copied list with only the Macs whose device token is still kept (`mac.<id>`); null when none is left. */
async function restorableMacs(vault: DeviceVault, raw: string): Promise<string | null> {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const kept: unknown[] = [];
  for (const entry of list) {
    const id = entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null;
    if (typeof id === 'string' && (await readCopy(vault, `mac.${id}`)) !== null) kept.push(entry);
  }
  return kept.length ? JSON.stringify(kept) : null;
}

function isEmptyList(raw: string): boolean {
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) && list.length === 0;
  } catch {
    return false;
  }
}

/** `store` with the saved list and the Mac used last copied into `vault`, and given back from it after a wipe. */
export function withVaultCopy(store: KeyValueStore, vault: DeviceVault): KeyValueStore {
  return {
    async get(key) {
      const value = await store.get(key);
      if (value !== null || !COPIED.has(key)) return value;
      const copy = await readCopy(vault, copyKey(key));
      if (copy === null) return null;
      const restored = key === MACS_KEY ? await restorableMacs(vault, copy) : copy;
      if (restored === null) return null;
      await store.set(key, restored).catch(() => undefined);
      return restored;
    },
    async set(key, value) {
      await store.set(key, value);
      if (!COPIED.has(key)) return;
      if (key === MACS_KEY && isEmptyList(value)) {
        // No Macs left: nothing about them stays in the vault (the last forget leaves it empty).
        await Promise.allSettled([vault.delete(copyKey(MACS_KEY)), vault.delete(copyKey(LAST_MAC_KEY))]);
        return;
      }
      await vault.set(copyKey(key), value).catch(() => undefined);
    },
  };
}
