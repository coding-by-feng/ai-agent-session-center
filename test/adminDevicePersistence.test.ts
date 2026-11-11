import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceAuth, proofForToken } from '../server/mobile/deviceAuth.js';
it('SQLite restart preserves admin identity and corrupt binding cannot fall back to customer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-device-'));
  vi.stubEnv('APP_USER_DATA', dir);
  vi.resetModules();
  let db = await import('../server/db.js');
  try {
    const { sqliteMobileDeviceStore: store } = await import('../server/mobile/deviceStore.js');
    const devices = createDeviceAuth({ store });
    const identity = {
      sub: 'staff:one',
      ownerEpoch: 0,
      accessMode: 'admin' as const,
      adminGrant: randomUUID(),
    };
    const code = devices.createPairingCode({
      platform: 'desktop',
      autoApprove: true,
      hostedIdentity: identity,
    });
    const paired = devices.redeem({ code: code.code, label: 'Admin', platform: 'desktop' })!;
    expect(store.get(paired.device.id)?.hostedIdentity).toEqual(identity);
    // Close the SQLite handle and reload the store as a restarted process would.
    db.dbHandle().close();
    vi.resetModules();
    db = await import('../server/db.js');
    const { sqliteMobileDeviceStore: reopened } = await import('../server/mobile/deviceStore.js');
    const restarted = createDeviceAuth({ store: reopened });
    const challenge = restarted.createChallenge(paired.device.id);
    const result = restarted.exchange(
      paired.device.id,
      challenge.nonce,
      proofForToken(paired.deviceToken, challenge.nonce),
    );
    expect(result.ok).toBe(true);
    expect(restarted.hostedIdentity(paired.device.id)).toEqual(identity);
    db.dbHandle()
      .prepare('UPDATE mobile_devices SET hosted_identity=? WHERE id=?')
      .run('{broken', paired.device.id);
    expect(restarted.hostedIdentity(paired.device.id)).toBeNull();
  } finally {
    db.dbHandle().close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
