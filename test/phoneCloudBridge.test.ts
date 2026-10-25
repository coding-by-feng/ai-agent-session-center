// test/phoneCloudBridge.test.ts — AASC-15/16: pairing and push go through the cloud connection when one is
// connected, and nothing breaks when it isn't.
import { describe, it, expect, vi } from 'vitest';
import {
  BACKEND_CODE_EXPIRY_MARGIN_MS, BACKEND_CODE_TTL_SECONDS, createPhoneCloudBridge, PHONE_BACKEND_SCOPES, PUSH_ONLY_SCOPES,
  MAX_BACKEND_CODE_LIFE_MS,
} from '../server/mobile/phoneCloudBridge.js';
import { createCloudClient, createCloudTransport } from '../server/cloud/client.js';
import { CloudError, type ActiveCloudConnection, type CloudConnector } from '../server/cloud/types.js';

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
  it('asks the backend for a phone code, and says which host and Mac it is for', async () => {
    const { cloud, calls } = fakeCloud('connected', () => CODE);
    const warn = vi.fn();
    const minted = Date.parse(CODE.expiresAt) - BACKEND_CODE_TTL_SECONDS * 1000;
    const code = await createPhoneCloudBridge({ cloud, warn, now: () => minted }).mintBackendCode();
    expect(code).toEqual({
      host: 'api.example.test', code: CODE.code, codeRef: CODE.codeRef, macDeviceId: 'mac', expiresAt: Date.parse(CODE.expiresAt),
    });
    expect(calls).toEqual([{ method: 'POST', path: '/v1/devices/pairing-codes', body: { kind: 'phone', scopes: [...PHONE_BACKEND_SCOPES], ttlSeconds: BACKEND_CODE_TTL_SECONDS } }]);
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

// AASC-60 (Remote access): a phone's code also asks for `mac-paths:read`, which is how the phone learns where this Mac
// is on Tailscale. A backend that doesn't have it yet must not cost the phone its push link, so the Mac asks once more,
// for push only. Scopes are fixed when the phone redeems its code, hence one try with the address and one without.
describe('mintBackendCode: the Mac’s address scope (AASC-60)', () => {
  const requestedScopes = (calls: Call[]) => calls.map((c) => (c.body as { scopes: string[] }).scopes);
  /** A backend that answers its requests in order. One past them is a plain Error, which is never retried, so it can't loop. */
  const inOrder = (...answers: unknown[]) => {
    let next = 0;
    return () => (next < answers.length ? answers[next++] : new Error('unexpected extra request'));
  };
  const refusal = (code: string, status: number) => new CloudError(code, 'Refused.', status);
  const WITH_ADDRESS_THEN_PUSH_ONLY = [['push:register', 'mac-paths:read'], ['push:register']];

  it('asks for push:register and mac-paths:read', async () => {
    const warn = vi.fn();
    const { cloud, calls } = fakeCloud('connected', () => CODE);
    expect(await createPhoneCloudBridge({ cloud, warn }).mintBackendCode()).toMatchObject({ code: CODE.code });
    expect(requestedScopes(calls)).toEqual([['push:register', 'mac-paths:read']]);
    expect(PHONE_BACKEND_SCOPES).toEqual(['push:register', 'mac-paths:read']);
    expect(PUSH_ONLY_SCOPES).toEqual(['push:register']);
    // Nothing to say when the phone got everything it asked for.
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to push only when the backend refuses mac-paths:read', async () => {
    const warn = vi.fn();
    const { cloud, calls } = fakeCloud('connected', inOrder(refusal('forbidden', 403), CODE));
    const minted = Date.parse(CODE.expiresAt) - BACKEND_CODE_TTL_SECONDS * 1000;
    const code = await createPhoneCloudBridge({ cloud, warn, now: () => minted }).mintBackendCode();
    // The same code, host and expiry as without the fallback: nothing downstream (the ledger, the phone) can tell.
    expect(code).toEqual({
      host: 'api.example.test', code: CODE.code, codeRef: CODE.codeRef, macDeviceId: 'mac', expiresAt: Date.parse(CODE.expiresAt),
    });
    expect(requestedScopes(calls)).toEqual(WITH_ADDRESS_THEN_PUSH_ONLY);
    // Only the scopes change between the two requests.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/devices/pairing-codes', 'POST /v1/devices/pairing-codes']);
    expect(calls[1].body).toEqual({ kind: 'phone', scopes: ['push:register'], ttlSeconds: BACKEND_CODE_TTL_SECONDS });
    // Said once, after the retry worked: the phone is linked for push but can't read this Mac's address.
    expect(warn.mock.calls).toEqual([["The backend refused the Mac-address scope (forbidden): this phone's backend code is push only."]]);
  });

  // Review ruling R15: a backend from before mac-paths validates the body first and has never heard of the scope.
  it('falls back to push only when an older backend rejects the scope name (400)', async () => {
    const warn = vi.fn();
    const { cloud, calls } = fakeCloud('connected', inOrder(refusal('invalid_request', 400), CODE));
    const code = await createPhoneCloudBridge({ cloud, warn }).mintBackendCode();
    expect(code).toMatchObject({ host: 'api.example.test', code: CODE.code, codeRef: CODE.codeRef, macDeviceId: 'mac' });
    expect(requestedScopes(calls)).toEqual(WITH_ADDRESS_THEN_PUSH_ONLY);
    expect(warn.mock.calls).toEqual([["The backend refused the Mac-address scope (invalid_request): this phone's backend code is push only."]]);
  });

  it('counts the code’s life from the answer that made it, not from the refusal before it', async () => {
    let clock = 1_000_000;
    const answer = inOrder(refusal('forbidden', 403), { ...CODE, expiresAt: new Date(0).toISOString() });
    const { cloud } = fakeCloud('connected', () => {
      clock += 45_000; // each round trip
      return answer();
    });
    const code = await createPhoneCloudBridge({ cloud, warn: vi.fn(), now: () => clock }).mintBackendCode();
    expect(code?.expiresAt).toBe(1_090_000 + BACKEND_CODE_TTL_SECONDS * 1000);
  });

  it.each([
    ['a network error', new CloudError('offline', 'Cloud is offline.'), 'offline'],
    ['a timeout', new CloudError('cancelled', 'Cloud request cancelled or timed out.'), 'cancelled'],
    ['a 500', new CloudError('backend_error', 'Cloud request failed.'), 'backend_error'],
    ['a revoked token (401)', refusal('revoked', 401), 'revoked'],
    ['too many unused codes (409)', refusal('pairing_codes_outstanding', 409), 'pairing_codes_outstanding'],
    ['a rate limit (429)', refusal('rate_limited', 429), 'rate_limited'],
    // Not the backend's invalid_request: this Mac refusing to send a request it found invalid itself.
    ['a request this Mac refused to send', refusal('invalid_input', 400), 'invalid_input'],
    ['an answer it could not read', new CloudError('invalid_response', 'Cloud returned an invalid response.'), 'invalid_response'],
    ['an unexpected error', new Error('boom'), 'boom'],
  ])('does not retry on other failures: %s', async (_what, failure, logged) => {
    const warn = vi.fn();
    const { cloud, calls } = fakeCloud('connected', inOrder(failure, CODE));
    expect(await createPhoneCloudBridge({ cloud, warn }).mintBackendCode()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(warn.mock.calls).toEqual([[`No backend code for the phone: ${logged}`]]);
  });

  it('gives up (null) when both are refused, after two requests and no more', async () => {
    const warn = vi.fn();
    // The push-only retry is refused too (here: this Mac's device may not make phone codes at all), and so would a third be.
    const { cloud, calls } = fakeCloud('connected', inOrder(refusal('invalid_request', 400), refusal('forbidden', 403)));
    expect(await createPhoneCloudBridge({ cloud, warn }).mintBackendCode()).toBeNull();
    expect(requestedScopes(calls)).toEqual(WITH_ADDRESS_THEN_PUSH_ONLY);
    // Said once, with the answer that settled it. The push-only warning is for a retry that worked, so not here.
    expect(warn.mock.calls).toEqual([['No backend code for the phone: forbidden']]);
  });

  // R15 hangs on how this Mac's own transport words a backend's refusal, so run the real transport against a fake fetch.
  // What the log names is the transport's word for it (forbidden), not the backend's own code (pairing_scope_forbidden).
  it.each([
    ['an older backend answers 400 invalid_request', 400, 'invalid_request', 'invalid_request'],
    ['a backend that knows the scope but not for phones answers 403 pairing_scope_forbidden', 403, 'pairing_scope_forbidden', 'forbidden'],
  ] as const)('through the real transport: %s, and the phone still gets a push code', async (_backend, status, remote, logged) => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const { scopes } = JSON.parse(String(init?.body)) as { scopes: string[] };
      return scopes.includes('mac-paths:read')
        ? Response.json({ success: false, error: { code: remote, message: 'Refused.' } }, { status })
        : Response.json({ success: true, data: CODE });
    });
    const active = { connection: { backendOrigin: 'https://api.example.test' }, token: 't'.repeat(43), secretRef: 'ref' } as unknown as ActiveCloudConnection;
    const client = createCloudClient({
      active: () => active, revision: () => 1, outcome: () => {},
      transport: createCloudTransport({ fetch: fetcher as unknown as typeof fetch }),
    });
    const cloud = { ...fakeCloud('connected', () => ({})).cloud, client } as CloudConnector;
    const warn = vi.fn();
    expect(await createPhoneCloudBridge({ cloud, warn }).mintBackendCode()).toMatchObject({ code: CODE.code, codeRef: CODE.codeRef });
    expect(fetcher.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { scopes: string[] }).scopes)).toEqual(WITH_ADDRESS_THEN_PUSH_ONLY);
    expect(warn.mock.calls).toEqual([[`The backend refused the Mac-address scope (${logged}): this phone's backend code is push only.`]]);
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
