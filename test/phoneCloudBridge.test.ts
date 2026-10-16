// test/phoneCloudBridge.test.ts — AASC-15/16: pairing and push go through the cloud connection when one is
// connected, and nothing breaks when it isn't.
import { describe, it, expect, vi } from 'vitest';
import {
  BACKEND_CODE_EXPIRY_MARGIN_MS, BACKEND_CODE_TTL_SECONDS, createPhoneCloudBridge, PHONE_BACKEND_SCOPES, MAX_BACKEND_CODE_LIFE_MS } from '../server/mobile/phoneCloudBridge.js';
import { CloudError, type CloudConnector } from '../server/cloud/types.js';

type Call = { method: string; path: string; body?: unknown };

function fakeCloud(state: 'connected' | 'offline' | 'disconnected' | 'revoked', answer: (c: Call) => unknown) {
  const calls: Call[] = [];
  const cloud = {
    client: {
      request: vi.fn(async (method: string, path: string, body?: unknown) => {
        const call = { method, path, body };
        calls.push(call);
        const out = answer(call);
        if (out instanceof Error) throw out;
        return out;
      }),
    },
    status: () => ({
      state,
      lastError: null,
      connection: state === 'disconnected' ? null : { backendOrigin: 'https://api.example.test', accountId: 'a', deviceId: 'mac', deviceName: 'Mac', generation: 1 },
    }),
  } as unknown as CloudConnector;
  return { cloud, calls };
}

const CODE = { code: 'A'.repeat(22), codeRef: '3f2c1d5e-8a4b-4c6d-9e1f-0a2b3c4d5e6f', expiresAt: '2026-10-15T00:10:00.000Z' };
const MESSAGE = {
  mutationId: '0d9f6c8e-5b4a-4f3e-8d2c-1b0a9f8e7d6c', kind: 'approval' as const, sessionRef: 's1',
  title: 'Fix login bug', toolName: 'Bash', collapseKey: 's1', ttlSeconds: 600,
};

describe('mintBackendCode', () => {
  it('asks the backend for a phone code with push only, and says which host and Mac it is for', async () => {
    const { cloud, calls } = fakeCloud('connected', () => CODE);
    const warn = vi.fn();
    const minted = Date.parse(CODE.expiresAt) - BACKEND_CODE_TTL_SECONDS * 1000;
    const code = await createPhoneCloudBridge({ cloud, warn, now: () => minted }).mintBackendCode();
    expect(code).toEqual({
      host: 'api.example.test', code: CODE.code, codeRef: CODE.codeRef, macDeviceId: 'mac', expiresAt: Date.parse(CODE.expiresAt),
    });
    expect(calls).toEqual([{ method: 'POST', path: '/v1/devices/pairing-codes', body: { kind: 'phone', scopes: [...PHONE_BACKEND_SCOPES], ttlSeconds: BACKEND_CODE_TTL_SECONDS } }]);
    expect(PHONE_BACKEND_SCOPES).toEqual(['push:register']);
    // Issued just in time to a signed-in phone that redeems it at once (AASC-52): the backend's shortest life.
    expect(BACKEND_CODE_TTL_SECONDS).toBe(60);
  });

  // AASC-52 review: a code's expiry is never earlier than a full life after the backend's answer reached the Mac,
  // so neither a slow round trip nor a backend clock running behind makes a live code look gone.
  it('says when the code expires: the backend’s expiry, or a full life after its answer if that is later', async () => {
    const backendExpiry = Date.parse(CODE.expiresAt);
    const late = fakeCloud('connected', () => CODE);
    const answeredLate = backendExpiry - 30_000; // the answer took 30 s to arrive, or the clocks differ
    const slow = await createPhoneCloudBridge({ cloud: late.cloud, warn: vi.fn(), now: () => answeredLate }).mintBackendCode();
    expect(slow?.expiresAt).toBe(answeredLate + BACKEND_CODE_TTL_SECONDS * 1000);
    const ahead = fakeCloud('connected', () => CODE);
    const backendAhead = await createPhoneCloudBridge({ cloud: ahead.cloud, warn: vi.fn(), now: () => backendExpiry - 120_000 }).mintBackendCode();
    expect(backendAhead?.expiresAt).toBe(backendExpiry);
  });

  it('never trusts an expiry past the backend’s own 600 s maximum (a clock running ahead cannot block a phone for hours)', async () => {
    const answered = Date.parse(CODE.expiresAt) - 60_000;
    const farAhead = fakeCloud('connected', () => ({ ...CODE, expiresAt: new Date(answered + 30 * 24 * 3600_000).toISOString() }));
    const code = await createPhoneCloudBridge({ cloud: farAhead.cloud, warn: vi.fn(), now: () => answered }).mintBackendCode();
    expect(code?.expiresAt).toBe(answered + MAX_BACKEND_CODE_LIFE_MS);
  });

  it('reads the clock after the backend answered, not before it was asked', async () => {
    let clock = 1_000_000;
    const { cloud } = fakeCloud('connected', () => {
      clock += 45_000; // the mint round trip
      return { ...CODE, expiresAt: new Date(0).toISOString() };
    });
    const code = await createPhoneCloudBridge({ cloud, warn: vi.fn(), now: () => clock }).mintBackendCode();
    expect(code?.expiresAt).toBe(1_045_000 + BACKEND_CODE_TTL_SECONDS * 1000);
  });

  it('gives nothing without a cloud connection, and when the backend refuses (said once, without codes)', async () => {
    expect(await createPhoneCloudBridge({ cloud: null, warn: vi.fn() }).mintBackendCode()).toBeNull();
    for (const state of ['disconnected', 'revoked'] as const) {
      const gone = fakeCloud(state, () => CODE);
      expect(await createPhoneCloudBridge({ cloud: gone.cloud, warn: vi.fn() }).mintBackendCode()).toBeNull();
      expect(gone.calls).toEqual([]);
    }
    const warn = vi.fn();
    const refusing = fakeCloud('connected', () => new CloudError('pairing_codes_outstanding', 'Too many', 409));
    expect(await createPhoneCloudBridge({ cloud: refusing.cloud, warn }).mintBackendCode()).toBeNull();
    expect(warn).toHaveBeenCalledWith('No backend code for the phone: pairing_codes_outstanding');
  });

  it('tries a saved connection nobody has checked yet (offline right after the Mac restarts): the phone asked', async () => {
    const offline = fakeCloud('offline', () => CODE);
    expect(await createPhoneCloudBridge({ cloud: offline.cloud, warn: vi.fn() }).mintBackendCode()).toMatchObject({ code: CODE.code });
  });
});

describe('cloudAvailable (AASC-52)', () => {
  it('is true for a saved connection that isn’t revoked, checked or not', () => {
    expect(createPhoneCloudBridge({ cloud: null, warn: vi.fn() }).cloudAvailable()).toBe(false);
    expect(createPhoneCloudBridge({ cloud: fakeCloud('connected', () => ({})).cloud, warn: vi.fn() }).cloudAvailable()).toBe(true);
    expect(createPhoneCloudBridge({ cloud: fakeCloud('offline', () => ({})).cloud, warn: vi.fn() }).cloudAvailable()).toBe(true);
    expect(createPhoneCloudBridge({ cloud: fakeCloud('disconnected', () => ({})).cloud, warn: vi.fn() }).cloudAvailable()).toBe(false);
    expect(createPhoneCloudBridge({ cloud: fakeCloud('revoked', () => ({})).cloud, warn: vi.fn() }).cloudAvailable()).toBe(false);
  });
});

describe('retireBackendCode (AASC-52: before a phone gets a new code)', () => {
  const page = (devices: unknown[]) => ({ devices, nextCursor: null });

  it('revokes the backend device the last code made, so one phone never holds two', async () => {
    const { cloud, calls } = fakeCloud('connected', (c) => (c.method === 'DELETE'
      ? { revoked: true }
      : page([{ id: 'phone-dev', kind: 'phone', createdByCode: CODE.codeRef, revokedAt: null }])));
    expect(await createPhoneCloudBridge({ cloud, warn: vi.fn() }).retireBackendCode(CODE.codeRef)).toBe('revoked');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/devices', 'DELETE /v1/devices/phone-dev']);
  });

  it('says when the last code was never used, or its device is already revoked', async () => {
    const unused = fakeCloud('connected', () => page([]));
    expect(await createPhoneCloudBridge({ cloud: unused.cloud, warn: vi.fn() }).retireBackendCode(CODE.codeRef)).toBe('unredeemed');
    const done = fakeCloud('connected', () => page([{ id: 'p', kind: 'phone', createdByCode: CODE.codeRef, revokedAt: '2026-10-01T00:00:00Z' }]));
    expect(await createPhoneCloudBridge({ cloud: done.cloud, warn: vi.fn() }).retireBackendCode(CODE.codeRef)).toBe('already-revoked');
    expect(done.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('throws when the backend can’t be asked, so no second code is minted', async () => {
    const failing = fakeCloud('connected', () => new CloudError('offline', 'down', 502));
    await expect(createPhoneCloudBridge({ cloud: failing.cloud, warn: vi.fn() }).retireBackendCode(CODE.codeRef)).rejects.toMatchObject({ code: 'offline' });
    const gone = fakeCloud('disconnected', () => page([]));
    await expect(createPhoneCloudBridge({ cloud: gone.cloud, warn: vi.fn() }).retireBackendCode(CODE.codeRef)).rejects.toMatchObject({ code: 'disconnected' });
    expect(gone.calls).toEqual([]);
  });
});

describe('listPhoneDevices / revokeDevice (AASC-52)', () => {
  it('lists the account’s live phone devices across pages: never the Mac itself, a server device or a revoked one', async () => {
    const { cloud, calls } = fakeCloud('connected', (c) => (!c.path.includes('cursor')
      ? { devices: [
        { id: 'mac', kind: 'server', createdByCode: null, revokedAt: null },
        { id: 'cli', kind: 'server', createdByCode: null, revokedAt: null },
        { id: 'p1', kind: 'phone', createdByCode: 'ref-1', revokedAt: null },
      ], nextCursor: 'p1' }
      : { devices: [
        { id: 'p2', kind: 'phone', createdByCode: 'ref-2', revokedAt: '2026-10-01T00:00:00Z' },
        { id: 'p3', kind: 'phone', createdByCode: 'ref-3', revokedAt: null },
        { id: 'odd', kind: null, createdByCode: 'ref-4', revokedAt: null },
      ], nextCursor: null }));
    const devices = await createPhoneCloudBridge({ cloud, warn: vi.fn() }).listPhoneDevices();
    expect(devices.map((d) => d.id)).toEqual(['p1', 'p3']);
    expect(calls.map((c) => c.path)).toEqual(['/v1/devices', '/v1/devices?cursor=p1']);
  });

  it('never lists the Mac’s own device, even if the backend called it a phone', async () => {
    const { cloud } = fakeCloud('connected', () => ({ devices: [{ id: 'mac', kind: 'phone', createdByCode: 'r', revokedAt: null }], nextCursor: null }));
    expect(await createPhoneCloudBridge({ cloud, warn: vi.fn() }).listPhoneDevices()).toEqual([]);
  });

  it('revokes one device by id, and refuses the Mac’s own', async () => {
    const { cloud, calls } = fakeCloud('connected', () => ({ revoked: true }));
    const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn() });
    await bridge.revokeDevice('p1');
    await expect(bridge.revokeDevice('mac')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/devices/p1']);
  });

  it('needs a cloud connection', async () => {
    const { cloud, calls } = fakeCloud('disconnected', () => ({}));
    const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn() });
    await expect(bridge.listPhoneDevices()).rejects.toMatchObject({ code: 'disconnected' });
    await expect(bridge.revokeDevice('p1')).rejects.toMatchObject({ code: 'disconnected' });
    expect(calls).toEqual([]);
  });
});

describe('revokeBackendPhone', () => {
  it('finds the device the phone created from its code, across pages, and revokes it', async () => {
    const { cloud, calls } = fakeCloud('connected', (c) => {
      if (c.method === 'DELETE') return { revoked: true };
      if (!c.path.includes('cursor')) return { devices: [{ id: 'd1', createdByCode: null, revokedAt: null }], nextCursor: 'd1' };
      return { devices: [{ id: 'phone-dev', kind: 'phone', createdByCode: CODE.codeRef, revokedAt: null }], nextCursor: null };
    });
    await createPhoneCloudBridge({ cloud, warn: vi.fn() }).revokeBackendPhone(CODE.codeRef);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/devices', 'GET /v1/devices?cursor=d1', 'DELETE /v1/devices/phone-dev']);
  });

  it('does nothing for a phone paired without a backend code, or one already revoked', async () => {
    const { cloud, calls } = fakeCloud('connected', () => ({ devices: [{ id: 'p', createdByCode: CODE.codeRef, revokedAt: '2026-10-01T00:00:00Z' }], nextCursor: null }));
    const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn() });
    await bridge.revokeBackendPhone(null);
    expect(calls).toEqual([]);
    await bridge.revokeBackendPhone(CODE.codeRef);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('says what to do when the backend can’t be reached, and never throws', async () => {
    const warn = vi.fn();
    const disconnected = fakeCloud('disconnected', () => ({}));
    await createPhoneCloudBridge({ cloud: disconnected.cloud, warn }).revokeBackendPhone(CODE.codeRef);
    expect(disconnected.calls).toEqual([]);
    expect(warn.mock.calls[0][0]).toMatch(/owner revoke/);
    const failing = fakeCloud('connected', () => new CloudError('offline', 'down', 502));
    await expect(createPhoneCloudBridge({ cloud: failing.cloud, warn }).revokeBackendPhone(CODE.codeRef)).resolves.toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(
      "Could not revoke the phone's backend device (offline): revoke its backend device there (owner CLI: owner devices / owner revoke).",
    );
  });

  it('a code not redeemed yet is looked at once more after it expires, so a revoked phone can’t redeem it later (AASC-52)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const devices: Array<{ id: string; kind: string; createdByCode: string; revokedAt: string | null }> = [];
      const { cloud, calls } = fakeCloud('connected', (c) => (c.method === 'DELETE' ? { revoked: true } : { devices, nextCursor: null }));
      // Expires 50 s after the revoke (the ledger's expiry, not a life counted from when the phone asked).
      const expiresAt = vi.fn(() => 1_000_000 + BACKEND_CODE_TTL_SECONDS * 1000 - 10_000);
      const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn(), expiresAt });
      await bridge.revokeBackendPhone(CODE.codeRef);
      expect(calls.map((c) => c.method)).toEqual(['GET']);
      // The revoked phone redeems its code anyway, before the backend lets it expire.
      devices.push({ id: 'late-dev', kind: 'phone', createdByCode: CODE.codeRef, revokedAt: null });
      await vi.advanceTimersByTimeAsync(BACKEND_CODE_TTL_SECONDS * 1000 - 10_000 + BACKEND_CODE_EXPIRY_MARGIN_MS - 1);
      expect(calls.map((c) => c.method)).toEqual(['GET']);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/devices', 'GET /v1/devices', 'DELETE /v1/devices/late-dev']);
      // Once: nothing else is scheduled.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toHaveLength(3);
      expect(expiresAt).toHaveBeenCalledWith(CODE.codeRef);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the ledger’s expiry, however long the code lives (a 600 s code from before AASC-52)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { cloud, calls } = fakeCloud('connected', () => ({ devices: [], nextCursor: null }));
      const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn(), expiresAt: () => 1_000_000 + 500_000 });
      await bridge.revokeBackendPhone(CODE.codeRef);
      await vi.advanceTimersByTimeAsync(500_000 + BACKEND_CODE_EXPIRY_MARGIN_MS - 1);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never waits longer than the backend’s maximum life, whatever the ledger says (no timer overflow)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { cloud, calls } = fakeCloud('connected', () => ({ devices: [], nextCursor: null }));
      const bridge = createPhoneCloudBridge({ cloud, warn: vi.fn(), expiresAt: () => 1_000_000 + 40 * 24 * 3600_000 });
      await bridge.revokeBackendPhone(CODE.codeRef);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(MAX_BACKEND_CODE_LIFE_MS + BACKEND_CODE_EXPIRY_MARGIN_MS);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules nothing for a code long expired, or one it has no record of', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { cloud, calls } = fakeCloud('connected', () => ({ devices: [], nextCursor: null }));
      await createPhoneCloudBridge({ cloud, warn: vi.fn(), expiresAt: () => 0 }).revokeBackendPhone(CODE.codeRef);
      await createPhoneCloudBridge({ cloud, warn: vi.fn(), expiresAt: () => null }).revokeBackendPhone(CODE.codeRef);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries a saved connection nobody has checked yet (offline right after the Mac restarts)', async () => {
    const { cloud, calls } = fakeCloud('offline', (c) => (c.method === 'DELETE'
      ? { revoked: true }
      : { devices: [{ id: 'phone-dev', createdByCode: CODE.codeRef, revokedAt: null }], nextCursor: null }));
    await createPhoneCloudBridge({ cloud, warn: vi.fn() }).revokeBackendPhone(CODE.codeRef);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/devices', 'DELETE /v1/devices/phone-dev']);
  });
});

describe('pushSink', () => {
  it('exists only while connected and posts the Mac’s message as-is', async () => {
    const { cloud, calls } = fakeCloud('connected', () => ({ sent: 1, failed: 0, disabled: 0 }));
    const sink = createPhoneCloudBridge({ cloud, warn: vi.fn() }).pushSink();
    expect(sink).not.toBeNull();
    await sink!.notify(MESSAGE);
    expect(calls).toEqual([{ method: 'POST', path: '/v1/push/notify', body: MESSAGE }]);
    expect(createPhoneCloudBridge({ cloud: fakeCloud('offline', () => ({})).cloud, warn: vi.fn() }).pushSink()).toBeNull();
    expect(createPhoneCloudBridge({ cloud: null, warn: vi.fn() }).pushSink()).toBeNull();
  });
});
