// test/phoneCloudBridge.test.ts — AASC-15/16: pairing and push go through the cloud connection when one is
// connected, and nothing breaks when it isn't.
import { describe, it, expect, vi } from 'vitest';
import { createPhoneCloudBridge, PHONE_BACKEND_SCOPES } from '../server/mobile/phoneCloudBridge.js';
import { CloudError, type CloudConnector } from '../server/cloud/types.js';

type Call = { method: string; path: string; body?: unknown };

function fakeCloud(state: 'connected' | 'offline' | 'disconnected', answer: (c: Call) => unknown) {
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
  it('asks the backend for a phone code with push only, and puts its host in the QR', async () => {
    const { cloud, calls } = fakeCloud('connected', () => CODE);
    const warn = vi.fn();
    const code = await createPhoneCloudBridge({ cloud, warn }).mintBackendCode();
    expect(code).toEqual({ host: 'api.example.test', code: CODE.code, codeRef: CODE.codeRef, macDeviceId: 'mac' });
    expect(calls).toEqual([{ method: 'POST', path: '/v1/devices/pairing-codes', body: { kind: 'phone', scopes: [...PHONE_BACKEND_SCOPES], ttlSeconds: 600 } }]);
    expect(PHONE_BACKEND_SCOPES).toEqual(['push:register']);
  });

  it('pairs Mac-only when not connected, and when the backend refuses (said once, without codes)', async () => {
    expect(await createPhoneCloudBridge({ cloud: null, warn: vi.fn() }).mintBackendCode()).toBeNull();
    const offline = fakeCloud('offline', () => CODE);
    expect(await createPhoneCloudBridge({ cloud: offline.cloud, warn: vi.fn() }).mintBackendCode()).toBeNull();
    expect(offline.calls).toEqual([]);
    const warn = vi.fn();
    const refusing = fakeCloud('connected', () => new CloudError('pairing_codes_outstanding', 'Too many', 409));
    expect(await createPhoneCloudBridge({ cloud: refusing.cloud, warn }).mintBackendCode()).toBeNull();
    expect(warn).toHaveBeenCalledWith('Phone pairing continues without a backend code: pairing_codes_outstanding');
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
