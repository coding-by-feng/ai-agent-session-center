// test/mobileEnrollComputerRoute.test.ts — plan 18, stage 2: POST /api/mobile/enroll-computer.
//
// A computer signed into the account connects without a link. The route sits in the public group with /pair and
// /enroll (plan 17) and passes the very same gates: JSON only, never cross-site, refused without a dashboard
// password, closed to a locked-out address, one enroll at a time per address, and a bad ticket costs a login
// strike recorded BEFORE the backend is asked. Its router is mounted beside the mobile router, as index.ts does.
// Real sockets: the answer is bound to the address the request reached, or, when the Host header is exactly that,
// to the public pair this machine publishes (a forwarded port) or its Tailscale pair on a loopback socket
// (Tailscale in userspace). Never to its home-network address by Host.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter, MAX_ENROLLS_TOTAL } from '../server/mobile/mobileRouter.js';
import { createComputerEnrollRouter } from '../server/mobile/computerEnrollRouter.js';
import type { ComputerEnrollHooks, ComputerEnrollInput, ComputerEnrollOutcome } from '../server/mobile/computerEnroll.js';

function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
    remove: (id) => { rows.delete(id); },
  };
}

const BODY = {
  machineId: '00000000-0000-4000-8000-0000000000aa',
  ticket: 'k'.repeat(43),
  clientKey: `B${'p'.repeat(86)}`,
  nonce: 'a1'.repeat(32),
};
const ANSWER = { machineKey: `B${'m'.repeat(86)}`, iv: 'i'.repeat(16), sealed: 's'.repeat(80) };
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';

interface Res { status: number; body: Record<string, any> }

/** Outcomes that never reach the backend, so cost no login strike (computerEnroll.ts steps 1–3). */
const LOCAL_REFUSALS = new Set(['off', 'not-this-machine', 'busy']);

describe('POST /api/mobile/enroll-computer', () => {
  let server: http.Server;
  let port: number;
  let passwordEnabled: boolean;
  let failures: Map<string, number>;
  let strikesAtRedeem: number[];
  let outcome: ComputerEnrollOutcome;
  let enrollCalls: ComputerEnrollInput[];
  let publishedPublic: boolean;
  /** When set, each enroll waits on its own promise until the test lets it go. */
  let hold: null | Array<() => void>;
  let throwIt: boolean;

  async function start(withEnroll = true): Promise<void> {
    const auth = createDeviceAuth({ store: memoryStore() });
    const rateLimit = {
      check: (ip: string) => ((failures.get(ip) ?? 0) >= 5 ? 900 : 0),
      record: (ip: string) => { failures.set(ip, (failures.get(ip) ?? 0) + 1); },
      clear: (ip: string) => { failures.delete(ip); },
    };
    const app = express();
    app.set('trust proxy', true); // lets a test speak for several client addresses with X-Forwarded-For
    app.use(express.json());
    // The same two mounts, in the same order, as server/index.ts.
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth,
      isPasswordEnabled: () => passwordEnabled,
      pairingOffered: () => true,
      requireSession: (_req, _res, n) => n(),
      createSessionToken: (id) => `session-for-${id}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit,
    }));
    app.use('/api/mobile', createComputerEnrollRouter({
      isPasswordEnabled: () => passwordEnabled,
      rateLimit,
      publishedAddresses: async () => (publishedPublic ? { public: PUBLIC, tailnet: TAILNET, port } : null),
      ...(withEnroll ? {
        computerEnroll: {
          enroll: async (input: ComputerEnrollInput, hooks: ComputerEnrollHooks = {}) => {
            enrollCalls.push(input);
            const current = outcome;
            if (current.ok || !LOCAL_REFUSALS.has(current.reason)) {
              hooks.beforeRedeem?.();
              strikesAtRedeem.push(failures.get('127.0.0.1') ?? 0);
            }
            if (hold) await new Promise<void>((release) => hold!.push(release));
            if (throwIt) throw new Error('enroll blew up');
            return current;
          },
        },
      } : {}),
    }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    passwordEnabled = true;
    failures = new Map();
    strikesAtRedeem = [];
    enrollCalls = [];
    publishedPublic = false;
    hold = null;
    throwIt = false;
    const auth = createDeviceAuth({ store: memoryStore() });
    const { device } = auth.enrollComputer({ label: 'MacBook Pro', accountEmail: 'me@example.com', backendDeviceId: 'c1', approve: 'ask' });
    outcome = { ok: true, answer: ANSWER, device: { ...device, access: 'sessions-only' } as never };
  });

  afterEach(async () => {
    if (hold) for (const release of hold.splice(0)) release();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  function post(body: unknown, headers: Record<string, string> = {}, path = '/api/mobile/enroll-computer'): Promise<Res> {
    return new Promise((resolve, reject) => {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path, agent: false,
        headers: { host: `192.168.1.20:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let parsed: Record<string, any> = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* Express's own HTML error page */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async function heldUntil(count: number): Promise<void> {
    for (let i = 0; i < 200 && (hold?.length ?? 0) < count; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold?.length).toBe(count);
  }

  it('answers 201 with the sealed answer, bound to the address the request reached', async () => {
    await start();
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: ANSWER });
    expect(enrollCalls).toEqual([{ ...BODY, boundAddress: `127.0.0.1:${port}` }]);
  });

  it.each([
    ['the public pair (a forwarded port)', PUBLIC],
    ['the Tailscale pair (Tailscale in userspace: this socket is 127.0.0.1)', TAILNET],
  ])('binds the answer to a pair this machine publishes when the Host is exactly %s', async (_label, address) => {
    await start();
    publishedPublic = true;
    expect((await post(BODY, { host: `${address}:${port}` })).status).toBe(201);
    expect(enrollCalls[0].boundAddress).toBe(`${address}:${port}`);
  });

  it.each([
    ['names an address this machine does not publish', (p: number) => `45.63.31.80:${p}`],
    ['names a published address on another port', (p: number) => `${PUBLIC}:${p + 1}`],
    ['names a relay\'s address', (p: number) => `192.168.1.66:${p}`],
    ['names a host', (p: number) => `mac-mini.example:${p}`],
    ['names this machine\'s home-network address (a relay on another network)', (p: number) => `192.168.1.20:${p}`],
  ])('keeps the address reached when the Host %s', async (_label, host) => {
    await start();
    publishedPublic = true;
    expect((await post(BODY, { host: host(port) })).status).toBe(201);
    expect(enrollCalls[0].boundAddress).toBe(`127.0.0.1:${port}`);
  });

  it('keeps the address reached for a Host naming the public address while none is published', async () => {
    await start();
    expect((await post(BODY, { host: `${PUBLIC}:${port}` })).status).toBe(201);
    expect(enrollCalls[0].boundAddress).toBe(`127.0.0.1:${port}`);
  });

  it('records the login strike before the backend is asked, and clears it on success', async () => {
    await start();
    expect((await post(BODY)).status).toBe(201);
    expect(strikesAtRedeem).toEqual([1]); // already counted while the backend call was in flight
    expect(failures.size).toBe(0);
  });

  it.each([
    ['off', 403, 'ACCOUNT_ENROLL_OFF'],
    ['not-this-machine', 409, 'NOT_THIS_MACHINE'],
  ] as const)('answers %s as %i %s, with no login strike (no backend call)', async (reason, status, code) => {
    await start();
    outcome = { ok: false, reason };
    const res = await post(BODY);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(res.body.data).toBeUndefined();
    expect(failures.size).toBe(0);
  });

  it('answers too many waiting devices as 429 BUSY with a retryAfter, no strike', async () => {
    await start();
    outcome = { ok: false, reason: 'busy' };
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'BUSY', retryAfter: 120 });
    expect(failures.size).toBe(0);
  });

  it.each([
    ['client-revoked', 401, 'CLIENT_REVOKED'],
    ['cloud-failed', 502, 'CLOUD_UNAVAILABLE'],
    ['invalid', 401, 'INVALID_TICKET'],
    ['expired', 401, 'INVALID_TICKET'],
    ['used', 401, 'INVALID_TICKET'],
  ] as const)('answers %s as %i %s and keeps the strike it cost', async (reason, status, code) => {
    await start();
    outcome = { ok: false, reason };
    const res = await post(BODY);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(failures.get('127.0.0.1')).toBe(1);
  });

  it('answers ACCOUNT_ENROLL_OFF on a server built without it', async () => {
    await start(false);
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_ENROLL_OFF');
  });

  it.each([
    ['a machine id that is no uuid', { ...BODY, machineId: 'mac-1' }],
    ['an upper-case machine id', { ...BODY, machineId: BODY.machineId.replace(/a/g, 'A') }],
    ['a short ticket', { ...BODY, ticket: 'k'.repeat(42) }],
    ['a padded ticket', { ...BODY, ticket: `${'k'.repeat(42)}=` }],
    ['a short client key', { ...BODY, clientKey: 'p'.repeat(86) }],
    ['a nonce that is not hex', { ...BODY, nonce: 'z'.repeat(64) }],
    ['an upper-case nonce', { ...BODY, nonce: 'A1'.repeat(32) }],
    ['a label', { ...BODY, label: 'Totally the admin' }],
    ['a platform', { ...BODY, platform: 'desktop' }],
    ['a status', { ...BODY, status: 'active' }],
    ['an address from the client', { ...BODY, boundAddress: '10.0.0.1:1' }],
    ['a reachedAt from the client', { ...BODY, reachedAt: '10.0.0.1:1' }],
    ['plan 17\'s field names', { macDeviceId: BODY.machineId, ticket: BODY.ticket, phoneKey: BODY.clientKey, nonce: BODY.nonce, platform: 'ios' }],
    ['a missing field', { ...BODY, nonce: undefined }],
  ])('refuses %s (400) before enrolling', async (_label, body) => {
    await start();
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(enrollCalls).toEqual([]);
  });

  it('is refused when no dashboard password is set', async () => {
    await start();
    passwordEnabled = false;
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('REMOTE_PASSWORD_REQUIRED');
    expect(enrollCalls).toEqual([]);
  });

  it('refuses cross-site browser requests and non-JSON bodies', async () => {
    await start();
    expect((await post(BODY, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post('ticket=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect(enrollCalls).toEqual([]);
  });

  it('is closed to an address the login limiter locked out', async () => {
    await start();
    failures.set('127.0.0.1', 5);
    const res = await post(BODY);
    expect(res.status).toBe(429);
    expect(enrollCalls).toEqual([]);
  });

  it('locks a guesser out after five bad tickets', async () => {
    await start();
    outcome = { ok: false, reason: 'invalid' };
    for (let i = 0; i < 5; i++) expect((await post(BODY)).status).toBe(401);
    expect((await post(BODY)).status).toBe(429);
    expect(enrollCalls).toHaveLength(5);
  });

  it('runs one enroll at a time per address: a second one waits its turn with 429 ENROLL_BUSY', async () => {
    await start();
    hold = [];
    const first = post(BODY);
    await heldUntil(1);
    const second = await post(BODY);
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ code: 'ENROLL_BUSY', retryAfter: expect.any(Number) });
    expect(enrollCalls).toHaveLength(1);
    hold.shift()!();
    expect((await first).status).toBe(201);
    hold = null;
    expect((await post(BODY)).status).toBe(201); // the slot is free again
  });

  it(`runs at most ${MAX_ENROLLS_TOTAL} enrolls at once from all addresses`, async () => {
    await start();
    hold = [];
    const running = Array.from({ length: MAX_ENROLLS_TOTAL }, (_, i) => post(BODY, { 'x-forwarded-for': `10.0.0.${i + 1}` }));
    await heldUntil(MAX_ENROLLS_TOTAL);
    const extra = await post(BODY, { 'x-forwarded-for': '10.0.0.99' });
    expect(extra.status).toBe(429);
    expect(extra.body.code).toBe('ENROLL_BUSY');
    expect(enrollCalls).toHaveLength(MAX_ENROLLS_TOTAL);
    for (const release of hold.splice(0)) release();
    expect((await Promise.all(running)).map((r) => r.status)).toEqual(Array(MAX_ENROLLS_TOTAL).fill(201));
  });

  it('frees the slot when the enroll throws', async () => {
    await start();
    throwIt = true;
    hold = [];
    const failing = post(BODY);
    await heldUntil(1);
    hold.shift()!();
    expect((await failing).status).toBe(500);
    hold = null;
    throwIt = false;
    expect((await post(BODY)).status).toBe(201); // not ENROLL_BUSY
  });

  it('leaves the mobile router\'s own routes to it: a phone\'s /enroll still answers, and nothing else is added', async () => {
    await start();
    const phone = await post(
      { macDeviceId: BODY.machineId, ticket: BODY.ticket, phoneKey: BODY.clientKey, nonce: BODY.nonce, platform: 'ios' },
      {}, '/api/mobile/enroll',
    );
    expect(phone.status).toBe(403); // the mobile router of this test was built without account enroll
    expect(phone.body.code).toBe('ACCOUNT_ENROLL_OFF');
    expect((await post(BODY, {}, '/api/mobile/enroll-computer/extra')).status).toBe(404);
    expect(enrollCalls).toEqual([]);
  });
});
