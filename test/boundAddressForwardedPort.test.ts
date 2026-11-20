// test/boundAddressForwardedPort.test.ts — the address rule's three users, when a request did not come the way
// its Host says: POST /api/mobile/enroll (a phone), POST /api/mobile/enroll-computer (a computer) and
// POST /api/mobile/identify (this machine's proof of itself).
//
// The hole this closes: a request on a PRIVATE socket address from a PUBLIC peer came through the router's
// forwarded port. A hostile network the client is on can answer at this machine's home-network address and pass
// the request on to that forwarded port: the socket's own address is then the very address the client dialled,
// so an answer bound to it opens for the client. Such a request now earns the published public pair when its
// Host names exactly that, and otherwise UNBOUND, which no client dialled. And a request with a proxy's
// forwarding header is never userspace Tailscale.
//
// Wired as server/index.ts wires it (both routers, accountEnrollWiring.ts, machineAccountWiring.ts, the real
// cloud connection and seals) against a fake backend. Sockets:
//   - "socket fields stubbed": a real loopback connection whose `localAddress` / `remoteAddress` a middleware
//     replaces before the routers see it. A public peer cannot be had on this computer any other way.
//   - "real sockets": nothing stubbed. A listener on every interface, reached at this computer's own network
//     address, so both ends of the socket are that address (a private peer, when the address is private).
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createCloudConnection } from '../server/cloud/connection.js';
import { createFileSecretStore } from '../server/cloud/secretStore.js';
import { createAccountEnrollWiring } from '../server/mobile/accountEnrollWiring.js';
import { UNBOUND } from '../server/mobile/boundAddress.js';
import { createComputerEnrollRouter } from '../server/mobile/computerEnrollRouter.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMachineAccountWiring } from '../server/mobile/machineAccountWiring.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';

const subtle = globalThis.crypto.subtle;
const OWNER = '00000000-0000-4000-8000-000000000001';
const MACHINE = '00000000-0000-4000-8000-000000000002';
const PHONE = '00000000-0000-4000-8000-000000000003';
const COMPUTER = '00000000-0000-4000-8000-000000000004';
const MACHINE_TOKEN = 't'.repeat(43);
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';
const LAN = '192.168.1.57';
const INTERNET = '203.0.113.9';
/** An IPv4 address of this very computer that is not loopback, when it has one. */
const OWN_ADDRESS = Object.values(networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? null;

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

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

interface Sent { connectTo?: string; headers?: Record<string, string> }

/** One JSON POST written to the socket by hand: exactly the Host line given, and any other header. */
function post(port: number, path: string, body: unknown, host: string, sent: Sent = {}): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const socket = net.connect(port, sent.connectTo ?? '127.0.0.1', () => {
      socket.write([
        `POST ${path} HTTP/1.1`,
        `Host: ${host}`,
        ...Object.entries(sent.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        '',
        payload,
      ].join('\r\n'));
    });
    let raw = '';
    socket.on('data', (c) => { raw += c; });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
        const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
        const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
        resolve({ status, body: json ? JSON.parse(json) : {} });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** This machine, as the server builds it: a phone's enroll, a computer's, and /identify, on one listener. */
async function machine(options: {
  tailnet?: string | null;
  publicTicked?: boolean;
  /** What the routers are to read as the socket's two addresses ("socket fields stubbed"). Omitted: the real ones. */
  socket?: { local: string; remote: string };
  /** Listen on every interface instead of loopback only. */
  everyInterface?: boolean;
} = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-forwarded-port-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const newTicket = () => ({ value: randomBytes(32).toString('base64url'), sealSecret: randomBytes(32).toString('base64url'), keyHash: '', used: false });
  const tickets = { phone: newTicket(), computer: newTicket() };
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const fail = (status: number, code: string) => new Response(JSON.stringify({ success: false, error: { code, message: 'x' } }), { status, headers: { 'content-type': 'application/json' } });
    const redeem = (ticket: typeof tickets.phone, data: Record<string, unknown>) => {
      if (body?.ticket !== ticket.value) return fail(404, 'ticket_invalid');
      if (ticket.used) return fail(409, 'ticket_used');
      ticket.used = true;
      return Response.json({ success: true, data: { ...data, email: 'me@example.com', sealSecret: ticket.sealSecret } });
    };
    if (url.pathname === '/v1/devices/pair') return Response.json({ success: true, data: { token: MACHINE_TOKEN, ownerId: OWNER, deviceId: MACHINE, account: { email: 'me@example.com' } } });
    if (url.pathname === '/v1/enroll/tickets/redeem') return redeem(tickets.phone, { phoneDeviceId: PHONE, phoneName: 'Kason’s iPhone', phoneKeyHash: tickets.phone.keyHash });
    if (url.pathname === '/v1/machines/tickets/redeem') {
      return redeem(tickets.computer, {
        clientDeviceId: COMPUTER, clientName: 'Kason’s MacBook Pro', clientKind: 'server', clientPlatform: 'macos',
        clientKeyHash: tickets.computer.keyHash, relation: 'self',
      });
    }
    return new Response('{}', { status: 404 });
  });
  const cloud = await createCloudConnection({
    directory: join(dir, 'cloud'), secrets: createFileSecretStore(join(dir, 'secrets')), fetch: fetcher as unknown as typeof fetch,
  });
  cleanups.push(() => cloud.stop());
  await cloud.connectCloud({ backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac mini' });

  const denied = new Set<string>();
  const denyList = { has: (id: string) => denied.has(id), add: (id: string) => void denied.add(id) };
  const listening = { port: 0 };
  const shared = { configPath: join(dir, 'server-config.json'), env: {}, pairingOffered: () => true, passwordEnabled: () => true, denyList };
  const machineAccount = createMachineAccountWiring({
    ...shared, cloud,
    savedSettings: { computerAccountEnroll: 'auto', accountAddresses: { public: options.publicTicked === true } },
    target: async () => ({ lan: LAN, tailnet: options.tailnet ?? null, publicAddress: PUBLIC, port: listening.port }),
    rememberedFile: join(dir, 'cloud', 'machine-directory.json'),
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  });
  const accountEnroll = createAccountEnrollWiring({
    ...shared, cloud, phoneCloud: { revokeDevice: async () => undefined }, savedSetting: true, info: vi.fn(), warn: vi.fn(),
  });
  const deviceAuth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => 'epoch-1', onRemovedByOwner: machineAccount.onRemovedByOwner });
  const rateLimit = { check: () => 0, record: () => undefined, clear: () => undefined };
  const app = express();
  // "Socket fields stubbed": what the routers read as this machine's own address and the peer's on the socket.
  app.use((req, _res, next) => {
    if (options.socket) {
      Object.defineProperty(req.socket, 'localAddress', { value: options.socket.local, configurable: true });
      Object.defineProperty(req.socket, 'remoteAddress', { value: options.socket.remote, configurable: true });
    }
    next();
  });
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => true,
    requireSession: (_req, _res, n) => n(),
    createSessionToken: (id) => `phone-session-${id}`,
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Mac mini', port: listening.port, lan: LAN, tailnet: null }),
    rateLimit,
    accountEnroll: accountEnroll.createEnroll(deviceAuth),
    publishedAddresses: machineAccount.publishedAddresses,
  }));
  app.use('/api/mobile', createComputerEnrollRouter({
    isPasswordEnabled: () => true,
    rateLimit,
    computerEnroll: machineAccount.createEnroll(deviceAuth),
    publishedAddresses: machineAccount.publishedAddresses,
  }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, options.everyInterface ? '0.0.0.0' : '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  listening.port = (server.address() as AddressInfo).port;
  return { port: listening.port, tickets, deviceAuth };
}
type Machine = Awaited<ReturnType<typeof machine>>;

/** A sealed answer and the key that opens it, for one device: what it holds if it dialled `address`, or null. */
type Opens = (address: string) => Promise<{ deviceId: string; deviceToken: string } | null>;

/** A device's side of a sealed enroll, in WebCrypto only. `kind` picks the route, the body and the seal's domain. */
async function enroll(m: Machine, kind: 'phone' | 'computer', host: string, sent: Sent = {}): Promise<Opens> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const ticket = m.tickets[kind];
  ticket.keyHash = createHash('sha256').update(raw).digest('hex'); // the backend bound the ticket to this key
  ticket.used = false;
  const nonce = randomBytes(32).toString('hex');
  const res = kind === 'phone'
    ? await post(m.port, '/api/mobile/enroll', { macDeviceId: MACHINE, ticket: ticket.value, phoneKey: b64u(raw), nonce, platform: 'ios' }, host, sent)
    : await post(m.port, '/api/mobile/enroll-computer', { machineId: MACHINE, ticket: ticket.value, clientKey: b64u(raw), nonce }, host, sent);
  expect(res.status).toBe(201);
  const domain = kind === 'phone' ? 'aasc-enroll-v1' : 'aasc-access-v1';
  const theirKey = fromB64u((kind === 'phone' ? res.body.data.macKey : res.body.data.machineKey) as string);
  return async (address) => {
    try {
      const theirs = await subtle.importKey('raw', theirKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const sharedBits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256));
      const hkdf = await subtle.importKey('raw', concat(sharedBits, fromB64u(ticket.sealSecret)), 'HKDF', false, ['deriveKey']);
      const key = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8(domain), raw, theirKey) },
        hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      );
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64u(res.body.data.iv as string), additionalData: utf8(`${domain}:${nonce}:${address}`), tagLength: 128 },
        key, fromB64u(res.body.data.sealed as string),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as { deviceId: string; deviceToken: string };
    } catch {
      return null; // "something else answered"
    }
  };
}

/** A device this machine vouches for already (paired by link and allowed), asking it to prove itself. */
function paired(m: Machine) {
  const { code } = m.deviceAuth.createPairingCode();
  const out = m.deviceAuth.redeem({ code, label: 'Old NUC', platform: 'desktop' })!;
  m.deviceAuth.approve(out.device.id);
  const nonce = randomBytes(32).toString('hex');
  return {
    /** The proof this machine gives for a request with `host`. */
    async proof(host: string, sent: Sent = {}): Promise<string> {
      const res = await post(m.port, '/api/mobile/identify', { tag: hmac(out.deviceToken, `aasc-who:${nonce}`), nonce }, host, sent);
      expect(res.status).toBe(200);
      return res.body.data.proof as string;
    },
    /** The proof the device accepts when it dialled `address`. */
    for: (address: string) => hmac(out.deviceToken, `aasc-mac:${nonce}:${address}`),
  };
}

describe('the relay through this machine\'s forwarded port (socket fields stubbed: a private socket address, a public peer)', () => {
  const forwarded = { socket: { local: LAN, remote: INTERNET } } as const;
  const everything = { ...forwarded, tailnet: TAILNET, publicTicked: true } as const;

  it.each(['phone', 'computer'] as const)('a %s that dialled the home-network address gets a seal that does not open for it', async (kind) => {
    const m = await machine(everything);
    const dialled = `${LAN}:${m.port}`; // the Host the box passes on, and this machine's own address on the socket
    const opens = await enroll(m, kind, dialled);
    expect(await opens(dialled)).toBeNull();
    expect(await opens(`${PUBLIC}:${m.port}`)).toBeNull();
    expect(await opens(`127.0.0.1:${m.port}`)).toBeNull();
    expect(await opens(UNBOUND)).not.toBeNull(); // bound to the one value no device dials
  });

  it('a device that dialled the home-network address gets a proof that does not verify for it', async () => {
    const m = await machine(everything);
    const device = paired(m);
    const dialled = `${LAN}:${m.port}`;
    const proof = await device.proof(dialled);
    expect(proof).not.toBe(device.for(dialled));
    expect(proof).not.toBe(device.for(`${PUBLIC}:${m.port}`));
    expect(proof).toBe(device.for(UNBOUND));
  });

  it.each(['phone', 'computer'] as const)('a %s that dialled the published public pair still connects', async (kind) => {
    const m = await machine(everything);
    const dialled = `${PUBLIC}:${m.port}`;
    const opens = await enroll(m, kind, dialled);
    expect(await opens(dialled)).not.toBeNull();
    expect(await opens(`${LAN}:${m.port}`)).toBeNull();
  });

  it('a device that dialled the published public pair still gets a proof for it', async () => {
    const m = await machine(everything);
    const device = paired(m);
    const dialled = `${PUBLIC}:${m.port}`;
    expect(await device.proof(dialled)).toBe(device.for(dialled));
  });

  it('with "Public IP" not ticked nothing is bound through the forward, whatever the Host', async () => {
    const m = await machine({ ...forwarded, tailnet: TAILNET });
    const device = paired(m);
    for (const host of [`${PUBLIC}:${m.port}`, `${LAN}:${m.port}`, `${TAILNET}:${m.port}`]) {
      expect(await device.proof(host)).toBe(device.for(UNBOUND));
      const opens = await enroll(m, 'phone', host);
      expect(await opens(host)).toBeNull();
      expect(await opens(UNBOUND)).not.toBeNull();
    }
  });
});

describe('a client on the home network is answered as before (socket fields stubbed: a private socket address, a private peer)', () => {
  it.each([
    ['another device on the network', '192.168.1.20'],
    ['the router, when it rewrites the source', '192.168.1.1'],
    ['a Docker bridge', '172.17.0.1'],
  ])('%s', async (_label, remote) => {
    const m = await machine({ socket: { local: LAN, remote }, tailnet: TAILNET, publicTicked: true });
    const dialled = `${LAN}:${m.port}`;
    expect(await (await enroll(m, 'phone', dialled))(dialled)).not.toBeNull();
    expect(await (await enroll(m, 'computer', dialled))(dialled)).not.toBeNull();
    const device = paired(m);
    expect(await device.proof(dialled)).toBe(device.for(dialled));
  });
});

describe.skipIf(OWN_ADDRESS === null)('real sockets, nothing stubbed: a listener reached at this computer\'s own network address', () => {
  it('answers for that address, as before: seals open and the proof verifies', async () => {
    const m = await machine({ everyInterface: true, tailnet: TAILNET, publicTicked: true });
    const dialled = `${OWN_ADDRESS}:${m.port}`;
    const sent = { connectTo: OWN_ADDRESS! };
    expect(await (await enroll(m, 'phone', dialled, sent))(dialled)).not.toBeNull();
    expect(await (await enroll(m, 'computer', dialled, sent))(dialled)).not.toBeNull();
    const device = paired(m);
    expect(await device.proof(dialled, sent)).toBe(device.for(dialled));
  });
});

describe('a proxy\'s forwarding header on the main port (real loopback sockets): never userspace Tailscale', () => {
  const proxied = { headers: { 'X-Forwarded-For': INTERNET } };

  it.each(['phone', 'computer'] as const)('a %s that dialled the Tailscale pair gets a seal for the socket, which it cannot open', async (kind) => {
    const m = await machine({ tailnet: TAILNET });
    const dialled = `${TAILNET}:${m.port}`;
    const opens = await enroll(m, kind, dialled, proxied);
    expect(await opens(dialled)).toBeNull();
    expect(await opens(`127.0.0.1:${m.port}`)).not.toBeNull();
    // Without the header the same request is userspace Tailscale.
    expect(await (await enroll(m, kind, dialled))(dialled)).not.toBeNull();
  });

  it('the proof names the socket, not the Tailscale pair', async () => {
    const m = await machine({ tailnet: TAILNET });
    const device = paired(m);
    const dialled = `${TAILNET}:${m.port}`;
    expect(await device.proof(dialled, proxied)).toBe(device.for(`127.0.0.1:${m.port}`));
    expect(await device.proof(dialled, { headers: { Via: '1.1 proxy' } })).toBe(device.for(`127.0.0.1:${m.port}`));
    expect(await device.proof(dialled)).toBe(device.for(dialled));
  });

  it('the published public pair is still bound behind a proxy that adds one', async () => {
    const m = await machine({ publicTicked: true });
    const device = paired(m);
    const dialled = `${PUBLIC}:${m.port}`;
    expect(await device.proof(dialled, proxied)).toBe(device.for(dialled));
  });
});
