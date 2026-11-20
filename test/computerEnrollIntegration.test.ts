// test/computerEnrollIntegration.test.ts — plan 18, stage 2, end to end on the target machine.
//
// Everything the server builds, wired as server/index.ts wires it (machineAccountWiring.ts, the mobile router
// and the enroll-computer router beside it, the real cloud connection), against a fake backend and on real
// loopback sockets. The "client" here does exactly what CONTRACT.md asks of the Electron client, in WebCrypto
// and plain HMACs: an ephemeral key, POST /api/mobile/enroll-computer, open the seal with the address it
// dialled, sign in, then check the machine's proof for that same address.
//
// What must hold: the client ends up with a working device only at the machine it dialled; a box that passes
// its requests on gets a sealed answer and a proof for the MACHINE's address, which the client refuses; with
// `ask` nothing works until Allow; behind a forwarded port, and with Tailscale in userspace, the pair this machine
// publishes is what is bound.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { createComputerEnrollRouter } from '../server/mobile/computerEnrollRouter.js';
import { createMachineAccountWiring } from '../server/mobile/machineAccountWiring.js';
import { markRemoteOnlyServer } from '../server/requestLocality.js';

const subtle = globalThis.crypto.subtle;
const OWNER = '00000000-0000-4000-8000-000000000001';
const MACHINE = '00000000-0000-4000-8000-000000000002';
const CLIENT = '00000000-0000-4000-8000-000000000003';
const MACHINE_TOKEN = 't'.repeat(43);
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';

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

const b64u = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const hmac = (deviceToken: string, message: string) =>
  createHmac('sha256', createHash('sha256').update(deviceToken).digest()).update(message).digest('hex');

interface Opened { deviceId: string; deviceToken: string; status: 'pending' | 'active'; confirmCode: string | null }

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

/** One JSON POST over a real socket. `host` is the Host header (what the client believes it dialled). */
function post(port: number, path: string, body: unknown, host?: string, bearer?: string): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path, agent: false,
      headers: {
        host: host ?? `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** The target machine, as the server builds it. */
async function machine(options: {
  mode?: 'ask' | 'auto'; publicTicked?: boolean; tailnet?: string | null;
  /** Mark the main listener itself remote-only: every socket it accepts is one. */
  remoteOnly?: boolean;
  /** Also start the remote-only listener beside the main one (same app, another loopback port), as the server does. */
  remoteListener?: boolean;
} = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-enroll-e2e-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  /** The ticket the backend holds: who asked, with which key, and the seal secret both sides get. */
  const ticket = { value: randomBytes(32).toString('base64url'), sealSecret: randomBytes(32).toString('base64url'), keyHash: '', used: false };
  const backendCalls: string[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    backendCalls.push(`${method} ${url.pathname}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/v1/devices/pair') return Response.json({ success: true, data: { token: MACHINE_TOKEN, ownerId: OWNER, deviceId: MACHINE, account: { email: 'me@example.com' } } });
    if (url.pathname === '/v1/machines/self') return Response.json({ success: true, data: method === 'PUT' ? { updatedAt: new Date().toISOString() } : { withdrawn: true } });
    if (url.pathname === '/v1/machines/tickets/redeem') {
      const fail = (status: number, code: string) => new Response(JSON.stringify({ success: false, error: { code, message: 'x' } }), { status, headers: { 'content-type': 'application/json' } });
      if (body?.ticket !== ticket.value) return fail(404, 'ticket_invalid');
      if (ticket.used) return fail(409, 'ticket_used');
      ticket.used = true;
      return Response.json({ success: true, data: {
        clientDeviceId: CLIENT, clientName: 'Kason’s MacBook Pro', clientKind: 'server', clientPlatform: 'macos',
        email: 'me@example.com', clientKeyHash: ticket.keyHash, sealSecret: ticket.sealSecret, relation: 'self',
      } });
    }
    return new Response('{}', { status: 404 });
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'), secrets: createFileSecretStore(join(dir, 'secrets')), fetch: fetcher as unknown as typeof fetch,
  });
  cleanups.push(() => cloud.stop());
  await cloud.connectCloud({ backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac mini' });

  const denied = new Set<string>();
  const listening = { port: 0 };
  /** Sessions this server run has minted, and how often /session was asked at all. */
  const sessions = { minted: 0, asked: 0 };
  const wiring = createMachineAccountWiring({
    cloud,
    configPath: join(dir, 'server-config.json'),
    savedSettings: { computerAccountEnroll: options.mode ?? 'ask', accountAddresses: { public: options.publicTicked === true } },
    env: {},
    pairingOffered: () => true,
    passwordEnabled: () => true,
    target: async () => ({ lan: '192.168.1.57', tailnet: options.tailnet ?? null, publicAddress: PUBLIC, port: listening.port }),
    denyList: { has: (id) => denied.has(id), add: (id) => void denied.add(id) },
    rememberedFile: join(dir, 'cloud', 'machine-directory.json'),
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  });
  const deviceAuth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => 'epoch-1', onRemovedByOwner: wiring.onRemovedByOwner });
  const rateLimit = { check: () => 0, record: () => undefined, clear: () => undefined };
  const app = express();
  app.use(express.json());
  app.use('/api/mobile/session', (_req, _res, next) => { sessions.asked += 1; next(); });
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => true,
    requireSession: (_req, _res, n) => n(),
    createSessionToken: (id) => `phone-session-${id}`,
    createComputerSessionToken: (id) => { sessions.minted += 1; return `computer-session-${id}`; },
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Mac mini', port: listening.port, lan: '192.168.1.57', tailnet: null }),
    rateLimit,
    publishedAddresses: wiring.publishedAddresses,
  }));
  app.use('/api/mobile', createComputerEnrollRouter({
    isPasswordEnabled: () => true,
    rateLimit,
    computerEnroll: wiring.createEnroll(deviceAuth),
    publishedAddresses: wiring.publishedAddresses,
  }));
  const server = http.createServer(app);
  if (options.remoteOnly) markRemoteOnlyServer(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  listening.port = (server.address() as AddressInfo).port;
  let remotePort = 0;
  if (options.remoteListener) {
    const remote = http.createServer(app);
    markRemoteOnlyServer(remote);
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => remote.close(() => r())));
    remotePort = (remote.address() as AddressInfo).port;
  }
  return { port: listening.port, remotePort, ticket, deviceAuth, denied, backendCalls, wiring, sessions };
}

/** A box on the network that passes every request on to the machine, unchanged. */
async function relay(to: number): Promise<number> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const forward = http.request({ host: '127.0.0.1', port: to, method: req.method, path: req.url, headers: req.headers, agent: false }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      forward.end(Buffer.concat(chunks));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as AddressInfo).port;
}

/** The client's whole side: what the Electron main process does (CONTRACT.md sections B, C and F). */
async function client(m: Awaited<ReturnType<typeof machine>>) {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  m.ticket.keyHash = createHash('sha256').update(raw).digest('hex'); // the backend bound the ticket to this key
  const nonce = randomBytes(32).toString('hex');

  /** POST enroll-computer at `port`, believing it dialled `dialled`. The answer, opened, or why not. */
  async function enroll(port: number, dialled: string): Promise<{ status: number; code?: string; opened?: Opened; refused?: true }> {
    const res = await post(port, '/api/mobile/enroll-computer', { machineId: MACHINE, ticket: m.ticket.value, clientKey: b64u(raw), nonce }, dialled);
    if (res.status !== 201) return { status: res.status, code: res.body.code };
    const { machineKey, iv, sealed } = res.body.data as { machineKey: string; iv: string; sealed: string };
    try {
      const machineRaw = fromB64u(machineKey);
      const machinePub = await subtle.importKey('raw', machineRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: machinePub }, pair.privateKey, 256));
      const hkdf = await subtle.importKey('raw', concat(shared, fromB64u(m.ticket.sealSecret)), 'HKDF', false, ['deriveKey']);
      const key = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8('aasc-access-v1'), raw, machineRaw) },
        hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      );
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64u(iv), additionalData: utf8(`aasc-access-v1:${nonce}:${dialled}`), tagLength: 128 }, key, fromB64u(sealed),
      );
      return { status: 201, opened: JSON.parse(new TextDecoder().decode(plain)) as Opened };
    } catch {
      return { status: 201, refused: true }; // "something else answered": nothing is saved
    }
  }

  /** /challenge → /session, as the existing sign-in. */
  async function signIn(port: number, device: Opened, dialled: string) {
    const challenge = await post(port, '/api/mobile/challenge', { deviceId: device.deviceId }, dialled);
    const nonceToSign = challenge.body.data.nonce as string;
    return post(port, '/api/mobile/session', { deviceId: device.deviceId, nonce: nonceToSign, proof: hmac(device.deviceToken, nonceToSign) }, dialled);
  }

  /** The machine's proof for the address dialled (section C). */
  async function machineProves(port: number, device: Opened, dialled: string): Promise<boolean> {
    const mine = randomBytes(32).toString('hex');
    const res = await post(port, '/api/mobile/identify', { tag: hmac(device.deviceToken, `aasc-who:${mine}`), nonce: mine }, dialled);
    return res.status === 200 && res.body.data.proof === hmac(device.deviceToken, `aasc-mac:${mine}:${dialled}`);
  }

  return { enroll, signIn, machineProves };
}

describe('the machine proves itself before any sign-in (the order the client uses for a record made through the account)', () => {
  it('auto: an active account computer gets a real proof from /identify before it has ever called /session', async () => {
    const m = await machine({ mode: 'auto' });
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const device = (await c.enroll(m.port, at)).opened!;
    expect(device.status).toBe('active');
    expect(await c.machineProves(m.port, device, at)).toBe(true);
    // Proving is not signing in: nothing was asked of /session, no session exists, the record has never been seen.
    expect(m.sessions).toEqual({ minted: 0, asked: 0 });
    expect(m.deviceAuth.list()).toEqual([expect.objectContaining({ id: device.deviceId, status: 'active', lastSeenAt: null })]);
    // Only then the sign-in, at the address that proved itself.
    expect((await c.signIn(m.port, device, at)).status).toBe(200);
    expect(m.sessions).toEqual({ minted: 1, asked: 1 });
  });

  it('ask: a pending one gets the decoy and no session; once allowed, the real proof, still before any /session', async () => {
    const m = await machine();
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const device = (await c.enroll(m.port, at)).opened!;
    expect(device.status).toBe('pending');
    expect(await c.machineProves(m.port, device, at)).toBe(false);
    expect(m.deviceAuth.approve(device.deviceId)).not.toBeNull();
    expect(await c.machineProves(m.port, device, at)).toBe(true);
    expect(m.sessions).toEqual({ minted: 0, asked: 0 });
  });

  it('a box that passes requests on fails the proof, so a client that asks for it first never sends that box a sign-in', async () => {
    const m = await machine({ mode: 'auto' });
    const relayPort = await relay(m.port);
    const c = await client(m);
    const device = (await c.enroll(m.port, `127.0.0.1:${m.port}`)).opened!;
    expect(await c.machineProves(relayPort, device, `127.0.0.1:${relayPort}`)).toBe(false); // the client stops here
    expect(m.sessions).toEqual({ minted: 0, asked: 0 });
  });

  it('a revoked one gets the decoy: the client reads it as unverified', async () => {
    const m = await machine({ mode: 'auto' });
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const device = (await c.enroll(m.port, at)).opened!;
    expect(m.deviceAuth.revoke(device.deviceId)).toBe(true);
    expect(await c.machineProves(m.port, device, at)).toBe(false);
  });
});

describe('a computer connects through the account', () => {
  it('ask: waits for Allow with the same code on both sides, then signs in and verifies the machine', async () => {
    const m = await machine();
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const enrolled = await c.enroll(m.port, at);
    const device = enrolled.opened!;
    expect(device.status).toBe('pending');
    const [row] = m.deviceAuth.list();
    expect(row).toMatchObject({ id: device.deviceId, status: 'pending', platform: 'desktop', origin: 'account', accountEmail: 'me@example.com', label: 'Kason’s MacBook Pro' });
    expect(row.confirmCode).toBe(device.confirmCode); // what "Phones & computers" shows is what the client shows

    const early = await c.signIn(m.port, device, at);
    expect([early.status, early.body.code]).toEqual([403, 'DEVICE_PENDING']);
    expect(await c.machineProves(m.port, device, at)).toBe(false); // nothing is vouched for before Allow

    expect(m.deviceAuth.approve(device.deviceId)).not.toBeNull();
    const session = await c.signIn(m.port, device, at);
    expect(session.status).toBe(200);
    expect(session.body.data.token).toBe(`computer-session-${device.deviceId}`); // a computer's session, not a phone's
    expect(await c.machineProves(m.port, device, at)).toBe(true);
    expect(m.backendCalls.filter((call) => call.includes('/tickets/redeem'))).toHaveLength(1);
  });

  it('auto: is in at once', async () => {
    const m = await machine({ mode: 'auto' });
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const device = (await c.enroll(m.port, at)).opened!;
    expect(device).toMatchObject({ status: 'active', confirmCode: null });
    expect((await c.signIn(m.port, device, at)).status).toBe(200);
    expect(await c.machineProves(m.port, device, at)).toBe(true);
  });

  it('a box that passes the requests on earns an answer the client refuses, and a proof for the wrong address', async () => {
    const m = await machine({ mode: 'auto' });
    const relayPort = await relay(m.port);
    const c = await client(m);
    const dialled = `127.0.0.1:${relayPort}`; // the client dialled the relay, believing it the machine
    const viaRelay = await c.enroll(relayPort, dialled);
    expect(viaRelay).toEqual({ status: 201, refused: true }); // sealed for the machine's own address: nothing is saved

    // And a device that already has a record: the relay cannot pass the machine's proof off as its own.
    const direct = await client(m);
    m.ticket.used = false;
    const device = (await direct.enroll(m.port, `127.0.0.1:${m.port}`)).opened!;
    expect((await direct.signIn(relayPort, device, dialled)).status).toBe(200); // the relay gets the sign-in through…
    expect(await direct.machineProves(relayPort, device, dialled)).toBe(false); // …but the client must refuse to use it
    expect(await direct.machineProves(m.port, device, `127.0.0.1:${m.port}`)).toBe(true);
  });

  it('behind a port forward, the answer and the proof are bound to the published public address', async () => {
    const m = await machine({ mode: 'auto', publicTicked: true });
    const c = await client(m);
    const dialled = `${PUBLIC}:${m.port}`; // the router forwards it; the machine's socket sees a private address
    const device = (await c.enroll(m.port, dialled)).opened!;
    expect(device.status).toBe('active');
    expect((await c.signIn(m.port, device, dialled)).status).toBe(200);
    expect(await c.machineProves(m.port, device, dialled)).toBe(true);
  });

  it('with Tailscale in userspace (this socket is 127.0.0.1), the answer and the proof are bound to the Tailscale pair', async () => {
    const m = await machine({ mode: 'auto', tailnet: TAILNET });
    const c = await client(m);
    const dialled = `${TAILNET}:${m.port}`;
    const device = (await c.enroll(m.port, dialled)).opened!;
    expect(device.status).toBe('active');
    expect((await c.signIn(m.port, device, dialled)).status).toBe(200);
    expect(await c.machineProves(m.port, device, dialled)).toBe(true);
  });

  it('the tunnel relay: a box at the Tailscale address passes requests on through a tunnel to the remote-only listener, and earns nothing', async () => {
    // The client dialled 100.101.102.103:<port> on a carrier-NAT network where a box holds that address. The box
    // passes everything on, Host untouched, through a TCP tunnel that ends on this machine's remote-only listener.
    const m = await machine({ mode: 'auto', tailnet: TAILNET, remoteListener: true });
    const dialled = `${TAILNET}:${m.port}`;
    const c = await client(m);
    expect(await c.enroll(m.remotePort, dialled)).toEqual({ status: 201, refused: true }); // the seal does not open
    // A computer that is already in gets no proof for the pair through the tunnel either.
    m.ticket.used = false;
    const direct = await client(m);
    const device = (await direct.enroll(m.port, `127.0.0.1:${m.port}`)).opened!;
    expect(await direct.machineProves(m.remotePort, device, dialled)).toBe(false);
    expect(await direct.machineProves(m.port, device, dialled)).toBe(true); // userspace Tailscale on the main listener still does
  });

  it('a remote-only socket is never userspace Tailscale, even on the published port', async () => {
    const m = await machine({ mode: 'auto', tailnet: TAILNET, remoteOnly: true });
    const dialled = `${TAILNET}:${m.port}`;
    const c = await client(m);
    expect(await c.enroll(m.port, dialled)).toEqual({ status: 201, refused: true });
    m.ticket.used = false;
    const direct = await client(m);
    const device = (await direct.enroll(m.port, `127.0.0.1:${m.port}`)).opened!;
    expect(await direct.machineProves(m.port, device, dialled)).toBe(false);
    expect(await direct.machineProves(m.port, device, `127.0.0.1:${m.port}`)).toBe(true);
  });

  it('a box on another network that holds this machine\'s home-network address earns nothing by passing requests on', async () => {
    // The client dialled 192.168.1.57 on a network that is not this machine's; the box there passes the request on
    // (here straight to the socket) with the Host untouched. A private address is never bound by Host.
    const m = await machine({ mode: 'auto', tailnet: TAILNET, publicTicked: true });
    const c = await client(m);
    expect(await c.enroll(m.port, `192.168.1.57:${m.port}`)).toEqual({ status: 201, refused: true });
  });

  it('a public address this machine does not publish binds nothing: the client that dialled it is refused', async () => {
    const m = await machine({ mode: 'auto' }); // Public IP not ticked
    const c = await client(m);
    expect(await c.enroll(m.port, `${PUBLIC}:${m.port}`)).toEqual({ status: 201, refused: true });
  });

  it('a ticket is good once: a second enroll with it is refused', async () => {
    const m = await machine({ mode: 'auto' });
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    expect((await c.enroll(m.port, at)).opened).toBeTruthy();
    expect(await c.enroll(m.port, at)).toEqual({ status: 401, code: 'INVALID_TICKET' });
    expect(m.deviceAuth.list()).toHaveLength(1);
  });

  it('a computer the owner revoked here is refused when it asks again, and one that removed itself is not', async () => {
    const m = await machine({ mode: 'auto' });
    const c = await client(m);
    const at = `127.0.0.1:${m.port}`;
    const device = (await c.enroll(m.port, at)).opened!;
    expect(m.deviceAuth.revoke(device.deviceId)).toBe(true);
    m.ticket.used = false;
    expect(await c.enroll(m.port, at)).toEqual({ status: 401, code: 'CLIENT_REVOKED' });
    expect((await c.signIn(m.port, device, at)).status).toBe(401);
  });
});
