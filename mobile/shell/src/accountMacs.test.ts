// @vitest-environment jsdom
// Plan 17: the Macs on the signed-in account (GET /v1/enroll/macs).
import { afterEach, describe, expect, it } from 'vitest';
import { listAccountMacs, unsavedAccountMacs } from './accountMacs';
import { ACCOUNT_VAULT_KEY, currentAccount, signInWithGoogle } from './accountSignIn';
import { createHarness, KASON_MBP, STUDIO } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

async function signedIn(opts: Parameters<typeof createHarness>[0] = {}) {
  const t = createHarness({ authSession: true, ...opts });
  await signInWithGoogle(t.deps, 'Pixel');
  t.mac.calls.length = 0;
  return t;
}

describe('listAccountMacs', () => {
  it('asks nothing when signed out', async () => {
    const t = createHarness();
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    expect(t.mac.calls).toHaveLength(0);
  });

  it('lists the account’s Macs with the account token, and nothing else', async () => {
    const t = await signedIn();
    const out = await listAccountMacs(t.deps);
    expect(out).toEqual({
      status: 'ok',
      macs: [{ deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', tailnet: '100.101.102.103', port: 3333, lastUsedAt: '2026-10-21T00:00:00.000Z' }],
    });
    expect(t.mac.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET https://api.aasc.work/v1/enroll/macs']);
    expect(t.mac.calls[0].headers.Authorization).toMatch(/^Bearer .{20,}/);
  });

  it('reads every entry as untrusted: bad addresses and ports become null, bad ids are dropped, at most 20', async () => {
    const t = await signedIn();
    t.mac.account.setMacs([
      { deviceId: '00000000-0000-4000-8000-000000000001', name: '  Studio‮  ', tailnet: '8.8.8.8', port: 0 },
      { deviceId: 'mac-not-a-uuid', name: 'X', tailnet: '100.64.0.1', port: 3333 },
      { deviceId: '00000000-0000-4000-8000-000000000002', name: '', tailnet: '100.064.0.1', port: 3333.5 },
      ...Array.from({ length: 30 }, (_, i) => ({ deviceId: `00000000-0000-4000-8000-1${String(i).padStart(11, '0')}`, name: `M${i}`, tailnet: null, port: 3333 })),
    ]);
    const out = await listAccountMacs(t.deps);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.macs[0]).toEqual({ deviceId: '00000000-0000-4000-8000-000000000001', name: 'Studio', tailnet: null, port: null, lastUsedAt: null });
    expect(out.macs[1]).toEqual({ deviceId: '00000000-0000-4000-8000-000000000002', name: 'Mac', tailnet: null, port: null, lastUsedAt: null });
    expect(out.macs.some((m) => m.deviceId === 'mac-not-a-uuid')).toBe(false);
    expect(out.macs.length).toBeLessThanOrEqual(20);
  });

  it('a 401 forgets the account: the phone is signed out', async () => {
    const t = await signedIn();
    t.mac.account.revokeDevice(t.mac.account.devices()[0]);
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a cloud that is down is just unavailable: the account stays', async () => {
    const t = await signedIn();
    t.mac.setBackendDown(true);
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'unavailable' });
    expect(await currentAccount(t.deps)).not.toBeNull();
  });
});

describe('unsavedAccountMacs', () => {
  it('leaves out the Macs a saved row already has (by backend device)', () => {
    const listed = [
      { deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', tailnet: null, port: 3333, lastUsedAt: null },
      { deviceId: '00000000-0000-4000-8000-000000000003', name: 'Studio', tailnet: '100.88.1.7', port: 3333, lastUsedAt: null },
    ];
    const saved = [{ ...KASON_MBP, backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f' }, STUDIO];
    expect(unsavedAccountMacs(listed, saved).map((m) => m.deviceId)).toEqual(['00000000-0000-4000-8000-000000000003']);
  });
});
