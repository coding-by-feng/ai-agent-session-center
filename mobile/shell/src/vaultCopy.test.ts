// vaultCopy.test.ts — the saved Mac list and the Mac used last, copied into the vault (Nov 17 2026): an app
// delete wipes Preferences but not the iOS Keychain, so a reinstall gets the list back instead of a QR scan.
import { describe, expect, it } from 'vitest';
import type { DeviceVault } from './native';
import type { KeyValueStore } from './pushRegistration';
import { LAST_MAC_KEY, MACS_KEY } from './savedMacs';
import { VAULT_COPY_PREFIX, withVaultCopy } from './vaultCopy';

const MAC_A = { id: '6f1c2a10-0000-4000-8000-00000000000a', name: 'A' };
const MAC_B = { id: '6f1c2a10-0000-4000-8000-00000000000b', name: 'B' };

function fakes(opts: { vaultGetFails?: boolean; vaultSetFails?: boolean } = {}) {
  const prefs = new Map<string, string>();
  const vault = new Map<string, string>();
  const store: KeyValueStore = {
    get: async (k) => prefs.get(k) ?? null,
    set: async (k, v) => void prefs.set(k, v),
  };
  const deviceVault: DeviceVault = {
    get: async (k) => {
      if (opts.vaultGetFails) throw new Error('locked');
      return vault.get(k) ?? null;
    },
    set: async (k, v) => {
      if (opts.vaultSetFails) throw new Error('locked');
      vault.set(k, v);
    },
    delete: async (k) => void vault.delete(k),
  };
  return { prefs, vault, wrapped: withVaultCopy(store, deviceVault) };
}

const copyKey = (key: string) => `${VAULT_COPY_PREFIX}${key}`;
const withToken = (vault: Map<string, string>, id: string) => vault.set(`mac.${id}`, '{"deviceId":"d","deviceToken":"t"}');

describe('withVaultCopy', () => {
  it('writes the saved list and the Mac used last to both, and nothing else to the vault', async () => {
    const { prefs, vault, wrapped } = fakes();
    await wrapped.set(MACS_KEY, JSON.stringify([MAC_A]));
    await wrapped.set(LAST_MAC_KEY, MAC_A.id);
    await wrapped.set('aasc.lock.settings', '{"enabled":true}');
    expect(prefs.get(MACS_KEY)).toBe(JSON.stringify([MAC_A]));
    expect(vault.get(copyKey(MACS_KEY))).toBe(JSON.stringify([MAC_A]));
    expect(vault.get(copyKey(LAST_MAC_KEY))).toBe(MAC_A.id);
    expect(prefs.get('aasc.lock.settings')).toBe('{"enabled":true}');
    expect([...vault.keys()].some((k) => k.includes('lock'))).toBe(false);
  });

  it('gives back the copy when Preferences was wiped, keeping only Macs whose token is still there, and writes it back', async () => {
    const { prefs, vault, wrapped } = fakes();
    vault.set(copyKey(MACS_KEY), JSON.stringify([MAC_A, MAC_B]));
    vault.set(copyKey(LAST_MAC_KEY), MAC_B.id);
    withToken(vault, MAC_B.id); // A was forgotten while the vault couldn't be written: its token is gone
    expect(JSON.parse((await wrapped.get(MACS_KEY)) ?? 'null')).toEqual([MAC_B]);
    expect(await wrapped.get(LAST_MAC_KEY)).toBe(MAC_B.id);
    expect(JSON.parse(prefs.get(MACS_KEY) ?? 'null')).toEqual([MAC_B]);
    expect(prefs.get(LAST_MAC_KEY)).toBe(MAC_B.id);
  });

  it('never brings back Macs over a list that is saved, even an empty one', async () => {
    const { prefs, vault, wrapped } = fakes();
    prefs.set(MACS_KEY, '[]');
    vault.set(copyKey(MACS_KEY), JSON.stringify([MAC_A]));
    withToken(vault, MAC_A.id);
    expect(await wrapped.get(MACS_KEY)).toBe('[]');
  });

  it('reads as nothing saved, and wipes nothing, when the vault can’t be read (a locked phone)', async () => {
    const { prefs, wrapped } = fakes({ vaultGetFails: true });
    expect(await wrapped.get(MACS_KEY)).toBeNull();
    expect(await wrapped.get(LAST_MAC_KEY)).toBeNull();
    expect(prefs.size).toBe(0);
  });

  it('leaves nothing in the vault once the last Mac is forgotten', async () => {
    const { prefs, vault, wrapped } = fakes();
    await wrapped.set(MACS_KEY, JSON.stringify([MAC_A]));
    await wrapped.set(LAST_MAC_KEY, MAC_A.id);
    await wrapped.set(MACS_KEY, '[]');
    expect(vault.size).toBe(0);
    expect(prefs.get(MACS_KEY)).toBe('[]');
  });

  it('still saves to Preferences when the vault refuses the copy', async () => {
    const { prefs, wrapped } = fakes({ vaultSetFails: true });
    await expect(wrapped.set(MACS_KEY, JSON.stringify([MAC_A]))).resolves.toBeUndefined();
    expect(prefs.get(MACS_KEY)).toBe(JSON.stringify([MAC_A]));
  });

  it('ignores a copy that isn’t a list', async () => {
    const { vault, wrapped } = fakes();
    vault.set(copyKey(MACS_KEY), '{"not":"a list"}');
    expect(await wrapped.get(MACS_KEY)).toBeNull();
  });
});
