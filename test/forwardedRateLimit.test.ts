// test/forwardedRateLimit.test.ts — rate-limit buckets behind a reverse proxy (terminal-editions §7.6).
//
// Behind Caddy every client reaches the remote-only listener from 127.0.0.1, so one bucket for
// everyone meant five bad passwords from anyone locked every device out. The fix trusts the LAST
// X-Forwarded-For entry (the one the proxy appended), but only when the owner says a proxy that
// sets it sits in front (AASC_TRUST_PROXY=1 / trustForwardedFor). Otherwise a local account, or a
// relay that passes headers through (ssh -R, socat, frp), could name a new "client" on every try and
// guess passwords without limit (security review H1). Even when trusted, every proxied bucket
// together has a ceiling, and the bucket map has a size cap.
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));
vi.mock('../server/serverConfig.js', () => ({ config: { passwordHash: 'salt:hash' } }));

import {
  markRemoteOnlyServer, rateLimitAddress, setTrustForwardedFor, resolveTrustForwardedFor, PROXIED_KEY_PREFIX,
} from '../server/requestLocality.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';

/** A socket the remote-only listener accepted. */
function remoteOnlySocket(): Socket {
  const fakeServer = new EventEmitter();
  markRemoteOnlyServer(fakeServer as unknown as http.Server);
  const socket = { remoteAddress: '127.0.0.1' } as unknown as Socket;
  fakeServer.emit('connection', socket);
  return socket;
}

afterEach(() => setTrustForwardedFor(false));

describe('resolveTrustForwardedFor', () => {
  it('is off unless opted in; the environment wins over server-config.json', () => {
    expect(resolveTrustForwardedFor(undefined, undefined)).toBe(false);
    expect(resolveTrustForwardedFor(undefined, true)).toBe(true);
    expect(resolveTrustForwardedFor('1', undefined)).toBe(true);
    expect(resolveTrustForwardedFor('0', true)).toBe(false);
    expect(resolveTrustForwardedFor('yes', undefined)).toBe(false);
    expect(resolveTrustForwardedFor(undefined, 'true' as unknown as boolean)).toBe(false);
  });
});

describe('rateLimitAddress', () => {
  it('ignores X-Forwarded-For on a remote-only socket unless a trusted proxy is configured', () => {
    const socket = remoteOnlySocket();
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('127.0.0.1');
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '10.0.1.1' } })).toBe('127.0.0.1');
  });

  it('keys on the last entry, marked as proxied, once trusted', () => {
    setTrustForwardedFor(true);
    const socket = remoteOnlySocket();
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(`${PROXIED_KEY_PREFIX}203.0.113.7`);
    // A client-supplied entry comes first; the proxy appends the address it saw.
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '10.9.9.9, 198.51.100.4' } })).toBe(`${PROXIED_KEY_PREFIX}198.51.100.4`);
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '2001:db8::1' } })).toBe(`${PROXIED_KEY_PREFIX}2001:db8::1`);
  });

  it('falls back to the peer when the last entry is missing or not an address', () => {
    setTrustForwardedFor(true);
    const socket = remoteOnlySocket();
    expect(rateLimitAddress({ socket, headers: {} })).toBe('127.0.0.1');
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '1.2.3.4, not-an-ip' } })).toBe('127.0.0.1');
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '1.2.3.4,' } })).toBe('127.0.0.1');
  });

  it('ignores the header on the main listener, trusted or not', () => {
    setTrustForwardedFor(true);
    const socket = { remoteAddress: '127.0.0.1' } as unknown as Socket;
    expect(rateLimitAddress({ socket, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('127.0.0.1');
    expect(rateLimitAddress({ ip: '192.168.1.5', socket, headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('192.168.1.5');
  });

  it('is "unknown" with no address at all', () => {
    expect(rateLimitAddress({ headers: {} })).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// authManager's buckets: the proxied ceiling and the size cap
// ---------------------------------------------------------------------------

describe('login buckets', () => {
  let auth: typeof import('../server/authManager.js');
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    auth = await import('../server/authManager.js');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('locks every proxied bucket after 30 failures in 15 minutes, and leaves others alone', () => {
    // 29 failures spread over 10 proxied "clients": none of them is locked on its own.
    for (let i = 0; i < 29; i++) auth.recordLoginAttempt(`${PROXIED_KEY_PREFIX}10.0.${i % 10}.1`);
    expect(auth.checkLoginRateLimit(`${PROXIED_KEY_PREFIX}10.0.99.1`)).toBe(0);
    // The 30th, from a fresh one, locks the remote-only listener's logins and sign-ins.
    const thirtieth = auth.recordLoginAttempt(`${PROXIED_KEY_PREFIX}10.0.50.1`);
    expect(thirtieth.lockedFor).toBe(15 * 60);
    expect(auth.checkLoginRateLimit(`${PROXIED_KEY_PREFIX}10.0.99.1`)).toBe(15 * 60);
    expect(auth.recordLoginAttempt(`${PROXIED_KEY_PREFIX}10.0.98.1`).lockedFor).toBeGreaterThan(0);
    // The main listener's peers keep their own buckets.
    expect(auth.checkLoginRateLimit('192.168.1.5')).toBe(0);
    expect(auth.checkLoginRateLimit('127.0.0.1')).toBe(0);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(auth.checkLoginRateLimit(`${PROXIED_KEY_PREFIX}10.0.99.1`)).toBe(0);
  });

  it('forgets proxied failures older than 15 minutes', () => {
    for (let i = 0; i < 29; i++) auth.recordLoginAttempt(`${PROXIED_KEY_PREFIX}10.1.${i}.1`);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(auth.recordLoginAttempt(`${PROXIED_KEY_PREFIX}10.2.0.1`).lockedFor).toBe(0);
    expect(auth.checkLoginRateLimit(`${PROXIED_KEY_PREFIX}10.2.0.2`)).toBe(0);
  });

  it('caps how many buckets it keeps, keeping locked ones over unlocked ones', () => {
    for (let i = 0; i < 5; i++) auth.recordLoginAttempt('198.51.100.1');
    expect(auth.checkLoginRateLimit('198.51.100.1')).toBeGreaterThan(0);
    for (let i = 0; i < auth.MAX_LOGIN_BUCKETS + 500; i++) auth.recordLoginAttempt(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(auth._loginBucketCount()).toBeLessThanOrEqual(auth.MAX_LOGIN_BUCKETS);
    expect(auth.checkLoginRateLimit('198.51.100.1')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The phone's public routes, served on a main and a remote-only listener
// ---------------------------------------------------------------------------

function memoryStore(): MobileDeviceStore {
  const rows = new Map<string, MobileDeviceRecord>();
  return {
    insert: (rec) => { rows.set(rec.id, { ...rec }); },
    get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
    update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
    listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked'),
    remove: (id) => { rows.delete(id); },
  };
}

let mainServer: http.Server;
let remoteServer: http.Server;
let failures: Map<string, number>;

beforeEach(async () => {
  failures = new Map();
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth: createDeviceAuth({ store: memoryStore() }),
    isPasswordEnabled: () => true,
    requireSession: (_req, _res, next) => next(),
    createSessionToken: () => 'session',
    createComputerSessionToken: () => 'computer-session',
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Box', port: 1, lan: '192.168.1.2', tailnet: null }),
    rateLimit: {
      check: (ip) => ((failures.get(ip) ?? 0) >= 5 ? 900 : 0),
      record: (ip) => { failures.set(ip, (failures.get(ip) ?? 0) + 1); },
      clear: (ip) => { failures.delete(ip); },
    },
  }));
  mainServer = http.createServer(app);
  remoteServer = http.createServer(app);
  markRemoteOnlyServer(remoteServer);
  await Promise.all([mainServer, remoteServer].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
});

afterEach(async () => {
  await Promise.all([mainServer, remoteServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

function pair(server: http.Server, forwardedFor: string): Promise<number> {
  const payload = JSON.stringify({ code: 'WRONG-CODE', label: 'Phone', platform: 'ios' });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'POST', path: '/api/mobile/pair',
      // A fresh connection per request: the listener, not keep-alive, decides the socket.
      agent: false,
      headers: { host: 'box.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-forwarded-for': forwardedFor },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('POST /pair behind a proxy', () => {
  it('without a trusted proxy, a changing header buys no new bucket on the remote-only listener', async () => {
    for (let i = 0; i < 5; i++) expect(await pair(remoteServer, `10.0.${i}.1`)).toBe(401);
    expect(await pair(remoteServer, '10.0.9.1')).toBe(429);
    expect(failures.get('127.0.0.1')).toBe(5);
  });

  it('with a trusted proxy, blocks one client after five wrong codes and leaves the next its own bucket', async () => {
    setTrustForwardedFor(true);
    for (let i = 0; i < 5; i++) expect(await pair(remoteServer, '203.0.113.7')).toBe(401);
    expect(await pair(remoteServer, '203.0.113.7')).toBe(429);
    expect(await pair(remoteServer, '198.51.100.4')).toBe(401);
    expect(failures.get(`${PROXIED_KEY_PREFIX}203.0.113.7`)).toBe(5);
    expect(failures.has('127.0.0.1')).toBe(false);
  });

  it('keeps one loopback bucket on the main listener, whatever the header says', async () => {
    setTrustForwardedFor(true);
    for (let i = 0; i < 5; i++) expect(await pair(mainServer, `203.0.113.${i}`)).toBe(401);
    expect(await pair(mainServer, '198.51.100.4')).toBe(429);
    expect(failures.get('127.0.0.1')).toBe(5);
  });
});
