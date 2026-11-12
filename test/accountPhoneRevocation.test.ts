// Plan 17 review H1: removing an account phone on purpose signs it out of AASC Cloud and keeps it out locally.
import { describe, expect, it, vi } from 'vitest';
import { createAccountPhoneRevokedHandler } from '../server/mobile/accountPhoneRevocation.js';
import type { MobileDeviceRecord } from '../server/mobile/deviceAuth.js';

const PHONE_ID = '00000000-0000-4000-8000-0000000000cc';

function record(over: Partial<MobileDeviceRecord> = {}): MobileDeviceRecord {
  return {
    id: 'dev-1', label: 'Kason iPhone', platform: 'ios', tokenHash: 'h', status: 'revoked', confirmCode: '1234',
    beCodeRef: null, beCodeRefMacBound: false, credentialEpoch: 'e',
    origin: 'account', accountEmail: 'me@example.com', accountPhoneId: PHONE_ID,
    createdAt: 1, approvedAt: 1, lastSeenAt: 2, revokedAt: 3,
    ...over,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(revokeBackendDevice = vi.fn(async () => {})) {
  const denied = new Set<string>();
  const denyList = { has: (id: string) => denied.has(id), add: vi.fn((id: string) => void denied.add(id)) };
  const warn = vi.fn();
  const handler = createAccountPhoneRevokedHandler({ denyList, revokeBackendDevice, warn });
  return { handler, denyList, denied, warn, revokeBackendDevice };
}

describe('createAccountPhoneRevokedHandler', () => {
  it('denies the backend phone id and signs it out of AASC Cloud', async () => {
    const { handler, denied, revokeBackendDevice, warn } = setup();
    handler(record());
    expect(denied.has(PHONE_ID)).toBe(true); // at once, before the cloud answers
    await flush();
    expect(revokeBackendDevice).toHaveBeenCalledWith(PHONE_ID);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves code-paired phones and account rows without a backend id alone', async () => {
    const { handler, denyList, revokeBackendDevice } = setup();
    handler(record({ origin: 'code', accountPhoneId: null }));
    handler(record({ origin: 'code', accountPhoneId: PHONE_ID }));
    handler(record({ accountPhoneId: null }));
    await flush();
    expect(denyList.add).not.toHaveBeenCalled();
    expect(revokeBackendDevice).not.toHaveBeenCalled();
  });

  it('never throws or waits on the cloud: a failed sign-out only warns, without the id', async () => {
    const { handler, denied, warn } = setup(vi.fn(async () => { throw new Error(`cloud down for ${PHONE_ID}`); }));
    expect(() => handler(record())).not.toThrow();
    await flush();
    expect(denied.has(PHONE_ID)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('Kason iPhone');
    expect(warn.mock.calls[0][0]).not.toContain(PHONE_ID);
    expect(warn.mock.calls[0][0]).not.toContain('me@example.com');
  });

  it('a synchronous throw from the cloud client is caught too', async () => {
    const { handler, warn } = setup(vi.fn(() => { throw new Error('boom'); }) as never);
    expect(() => handler(record())).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still asks the cloud when the deny list cannot be written', async () => {
    const revoke = vi.fn(async () => {});
    const warn = vi.fn();
    const handler = createAccountPhoneRevokedHandler({
      denyList: { has: () => false, add: () => { throw new Error('disk full'); } }, revokeBackendDevice: revoke, warn,
    });
    expect(() => handler(record())).not.toThrow();
    await flush();
    expect(revoke).toHaveBeenCalledWith(PHONE_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
  });
});
