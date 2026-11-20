// test/mobileEnrollBoundAddress.test.ts — a phone's account enroll (plan 17, POST /api/mobile/enroll) is bound by
// the one address rule (boundAddress.ts): the rule a computer's enroll and /identify use, nothing of its own.
//
// Why it matters: a Mac that runs Tailscale in userspace (a headless `aasc-server` often does) sees a phone that
// dialled its Tailscale address arrive on 127.0.0.1. Sealed over the socket address alone, the answer names
// `127.0.0.1:<port>`, and the phone, which accepts only an answer for the address it dialled, cannot open it.
//
// Everything is wired as server/index.ts wires it (accountEnrollWiring.ts for the enroll, machineAccountWiring.ts
// for what this Mac publishes, the real cloud connection, the real seal), against a fake backend and on real
// loopback sockets. The "phone" opens the seal in WebCrypto with the address it dialled, as the shell does
// (mobile/shell/src/enrollCrypto.ts), so a seal that opens proves its associated data byte for byte.
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
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
import { createAccountEnrollWiring } from '../server/mobile/accountEnrollWiring.js';
import { createDeviceAuth, proofForToken, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMachineAccountWiring } from '../server/mobile/machineAccountWiring.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import { markRemoteOnlyServer } from '../server/requestLocality.js';

const subtle = globalThis.crypto.subtle;
const OWNER = '00000000-0000-4000-8000-000000000001';
const MAC = '00000000-0000-4000-8000-000000000002';
const PHONE = '00000000-0000-4000-8000-000000000003';
const MAC_TOKEN = 't'.repeat(43);
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';
const LAN = '192.168.1.57';

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

interface Answer { macKey: string; iv: string; sealed: string }
interface Opened { deviceId: string; deviceToken: string }

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

/** One JSON POST written to the socket by hand, so a test sends exactly the Host line(s) it means to. */
function post(port: number, path: string, body: unknown, hosts: string | string[]): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `POST ${path} HTTP/1.1`,
        ...[hosts].flat().map((host) => `Host: ${host}`),
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

/** This Mac, as the server builds it. Its main listener's port is the one it publishes. */
async function mac(options: {
  /** This Mac's Tailscale address, when Tailscale is connected. */
  tailnet?: string | null;
  /** "Public IP" ticked under This computer. */
  publicTicked?: boolean;
  /** "Show this computer to my account": off publishes nothing. */
  showOnAccount?: boolean;
  /** Mark the main listener itself remote-only: every socket it accepts is one. */
  remoteOnly?: boolean;
  /** Also start the remote-only listener beside the main one (same app, another loopback port), as the server does. */
  remoteListener?: boolean;
  /** Also listen on a second, ordinary loopback port: something else on this Mac that reaches the same app. */
  secondListener?: boolean;
  /** The lookup of what this Mac publishes throws. */
  lookupFails?: boolean;
  /** Build the router without the rule at all (no `publishedAddresses`). */
  withoutRule?: boolean;
} = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-phone-enroll-bound-')));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  /** The enroll ticket the backend holds: bound to the phone's key, good once. */
  const ticket = { value: randomBytes(32).toString('base64url'), sealSecret: randomBytes(32).toString('base64url'), keyHash: '', used: false };
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/v1/devices/pair') return Response.json({ success: true, data: { token: MAC_TOKEN, ownerId: OWNER, deviceId: MAC, account: { email: 'me@example.com' } } });
    if (url.pathname === '/v1/enroll/tickets/redeem') {
      const fail = (status: number, code: string) => new Response(JSON.stringify({ success: false, error: { code, message: 'x' } }), { status, headers: { 'content-type': 'application/json' } });
      if (body?.ticket !== ticket.value) return fail(404, 'ticket_invalid');
      if (ticket.used) return fail(409, 'ticket_used');
      ticket.used = true;
      return Response.json({ success: true, data: {
        phoneDeviceId: PHONE, phoneName: 'Kason’s iPhone', email: 'me@example.com', phoneKeyHash: ticket.keyHash, sealSecret: ticket.sealSecret,
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
  const denyList = { has: (id: string) => denied.has(id), add: (id: string) => void denied.add(id) };
  const listening = { port: 0 };
  const machineAccount = createMachineAccountWiring({
    cloud,
    configPath: join(dir, 'server-config.json'),
    savedSettings: { showOnAccount: options.showOnAccount !== false, accountAddresses: { public: options.publicTicked === true } },
    env: {},
    pairingOffered: () => true,
    passwordEnabled: () => true,
    target: async () => ({ lan: LAN, tailnet: options.tailnet ?? null, publicAddress: PUBLIC, port: listening.port }),
    denyList,
    rememberedFile: join(dir, 'cloud', 'machine-directory.json'),
    info: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  });
  const accountEnroll = createAccountEnrollWiring({
    cloud,
    phoneCloud: { revokeDevice: async () => undefined },
    configPath: join(dir, 'server-config.json'),
    savedSetting: true,
    env: {},
    pairingOffered: () => true,
    passwordEnabled: () => true,
    denyList,
    info: vi.fn(), warn: vi.fn(),
  });
  const deviceAuth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => 'epoch-1' });
  /** How often this Mac was asked what it publishes. */
  const lookups = { count: 0 };
  const app = express();
  app.use(express.json());
  app.use('/api/mobile', createMobileRouter({
    deviceAuth,
    isPasswordEnabled: () => true,
    requireSession: (_req, _res, n) => n(),
    createSessionToken: (id) => `phone-session-${id}`,
    sessionTtlSeconds: 3600,
    pairingTarget: () => ({ name: 'Mac mini', port: listening.port, lan: LAN, tailnet: null }),
    rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
    accountEnroll: accountEnroll.createEnroll(deviceAuth),
    ...(options.withoutRule ? {} : {
      publishedAddresses: async () => {
        lookups.count += 1;
        if (options.lookupFails) throw new Error('the Tailscale probe fell over');
        return machineAccount.publishedAddresses();
      },
    }),
  }));
  const listen = async (remoteOnly: boolean): Promise<number> => {
    const server = http.createServer(app);
    if (remoteOnly) markRemoteOnlyServer(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    return (server.address() as AddressInfo).port;
  };
  listening.port = await listen(options.remoteOnly === true);
  const remotePort = options.remoteListener ? await listen(true) : 0;
  const secondPort = options.secondListener ? await listen(false) : 0;
  return { port: listening.port, remotePort, secondPort, ticket, deviceAuth, lookups };
}
type Mac = Awaited<ReturnType<typeof mac>>;

/** A box on the network that passes every request on to the Mac, Host and all. */
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

/** The phone's side, in WebCrypto only: an ephemeral key, the enroll call, and opening the seal for an address. */
async function phone(m: Mac) {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  m.ticket.keyHash = createHash('sha256').update(raw).digest('hex'); // the backend bound the ticket to this key
  const nonce = randomBytes(32).toString('hex');

  /** POST /enroll at `port`, with the Host line(s) given. The sealed answer; a refusal fails the test. */
  async function enroll(port: number, hosts: string | string[]): Promise<Answer> {
    const res = await post(port, '/api/mobile/enroll', { macDeviceId: MAC, ticket: m.ticket.value, phoneKey: b64u(raw), nonce, platform: 'ios' }, hosts);
    expect(res.status).toBe(201);
    return res.body.data as Answer;
  }

  /** What the answer holds for a phone that dialled `address`, or null: it does not open ("something else answered"). */
  async function opens(answer: Answer, address: string): Promise<Opened | null> {
    try {
      const macRaw = fromB64u(answer.macKey);
      const macPub = await subtle.importKey('raw', macRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: macPub }, pair.privateKey, 256));
      const hkdf = await subtle.importKey('raw', concat(shared, fromB64u(m.ticket.sealSecret)), 'HKDF', false, ['deriveKey']);
      const key = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: utf8(nonce), info: concat(utf8('aasc-enroll-v1'), raw, macRaw) },
        hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
      );
      const plain = await subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64u(answer.iv), additionalData: utf8(`aasc-enroll-v1:${nonce}:${address}`), tagLength: 128 }, key, fromB64u(answer.sealed),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as Opened;
    } catch {
      return null;
    }
  }

  return { enroll, opens };
}

/** The key the phone opened is this Mac's own for it: it signs in with it. */
function signsIn(m: Mac, device: Opened): boolean {
  const { nonce } = m.deviceAuth.createChallenge(device.deviceId);
  return m.deviceAuth.exchange(device.deviceId, nonce, proofForToken(device.deviceToken, nonce)).ok;
}

describe('a phone whose Host is the address of the socket it arrived on (every phone until now)', () => {
  it('is sealed over that address exactly as before, and this Mac looks nothing up', async () => {
    const m = await mac({ tailnet: TAILNET, publicTicked: true });
    const p = await phone(m);
    const at = `127.0.0.1:${m.port}`;
    const answer = await p.enroll(m.port, at);
    const device = await p.opens(answer, at);
    expect(device).toMatchObject({ deviceId: expect.any(String), deviceToken: expect.any(String) });
    expect(signsIn(m, device!)).toBe(true);
    expect(m.lookups.count).toBe(0);
    expect(m.deviceAuth.list()).toMatchObject([{ id: device!.deviceId, status: 'active', platform: 'ios', origin: 'account', label: 'Kason’s iPhone' }]);
  });
});

describe('the two cases where the Host says which address the phone dialled', () => {
  it('Tailscale in userspace (the socket is 127.0.0.1 on the published port): sealed over the Tailscale pair, and the phone opens it', async () => {
    const m = await mac({ tailnet: TAILNET });
    const p = await phone(m);
    const dialled = `${TAILNET}:${m.port}`;
    const answer = await p.enroll(m.port, dialled);
    const device = await p.opens(answer, dialled);
    expect(device).not.toBeNull();
    expect(signsIn(m, device!)).toBe(true);
    expect(await p.opens(answer, `127.0.0.1:${m.port}`)).toBeNull(); // one address, and it is the one dialled
    expect(m.lookups.count).toBe(1);
  });

  it('a forwarded port: sealed over the public pair this Mac publishes, and the phone opens it', async () => {
    const m = await mac({ publicTicked: true });
    const p = await phone(m);
    const dialled = `${PUBLIC}:${m.port}`;
    const answer = await p.enroll(m.port, dialled);
    const device = await p.opens(answer, dialled);
    expect(device).not.toBeNull();
    expect(signsIn(m, device!)).toBe(true);
    expect(await p.opens(answer, `127.0.0.1:${m.port}`)).toBeNull();
  });
});

describe('any other Host earns an answer for the socket the request arrived on, which a phone that dialled elsewhere cannot open', () => {
  /** Enroll on the main listener with `hosts`; the answer must open for the socket address and for no `claimed` one. */
  async function boundToTheSocket(m: Mac, hosts: string | string[], claimed: string[], arrivedOn = m.port): Promise<void> {
    const p = await phone(m);
    const answer = await p.enroll(arrivedOn, hosts);
    for (const address of claimed) expect(await p.opens(answer, address)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${arrivedOn}`)).not.toBeNull();
  }
  const everything = { tailnet: TAILNET, publicTicked: true } as const;

  it('the home-network address is never taken from Host', async () => {
    const m = await mac(everything);
    await boundToTheSocket(m, `${LAN}:${m.port}`, [`${LAN}:${m.port}`]);
  });

  it.each([
    ['the Tailscale address on another port', (port: number) => `${TAILNET}:${port + 1}`],
    ['the public address on another port', (port: number) => `${PUBLIC}:${port + 1}`],
    ['the bare Tailscale address (port 80 is not the published one)', () => TAILNET],
    ['a name for this Mac', (port: number) => `mac-mini.tail1234.ts.net:${port}`],
    ['another Tailscale address', (port: number) => `100.101.102.104:${port}`],
    ['the Tailscale pair with a digit more', (port: number) => `${TAILNET}:${port}0`],
  ])('%s', async (_label, host) => {
    const m = await mac(everything);
    const named = host(m.port);
    await boundToTheSocket(m, named, [named, `${TAILNET}:${m.port}`, `${PUBLIC}:${m.port}`]);
  });

  it.each([
    ['the Tailscale pair first', (port: number) => [`${TAILNET}:${port}`, `127.0.0.1:${port}`]],
    ['the Tailscale pair second', (port: number) => [`127.0.0.1:${port}`, `${TAILNET}:${port}`]],
    ['the public pair twice', (port: number) => [`${PUBLIC}:${port}`, `${PUBLIC}:${port}`]],
  ])('two Host headers (%s) are read as none', async (_label, hosts) => {
    const m = await mac(everything);
    await boundToTheSocket(m, hosts(m.port), [`${TAILNET}:${m.port}`, `${PUBLIC}:${m.port}`]);
  });

  it('the public pair while "Public IP" is not ticked', async () => {
    const m = await mac({ tailnet: TAILNET });
    await boundToTheSocket(m, `${PUBLIC}:${m.port}`, [`${PUBLIC}:${m.port}`]);
  });

  it('the Tailscale pair while Tailscale is not connected', async () => {
    const m = await mac({ publicTicked: true });
    await boundToTheSocket(m, `${TAILNET}:${m.port}`, [`${TAILNET}:${m.port}`]);
  });

  it.each([
    ['the Tailscale pair', TAILNET],
    ['the public pair', PUBLIC],
  ])('%s while this Mac publishes nothing ("Show this computer to my account" off)', async (_label, address) => {
    const m = await mac({ ...everything, showOnAccount: false });
    await boundToTheSocket(m, `${address}:${m.port}`, [`${address}:${m.port}`]);
  });

  it('a published pair when the lookup fails', async () => {
    const m = await mac({ ...everything, lookupFails: true });
    await boundToTheSocket(m, `${TAILNET}:${m.port}`, [`${TAILNET}:${m.port}`]);
    expect(m.lookups.count).toBe(1);
  });

  it('a published pair on a server wired without the rule', async () => {
    const m = await mac({ ...everything, withoutRule: true });
    await boundToTheSocket(m, `${TAILNET}:${m.port}`, [`${TAILNET}:${m.port}`]);
  });
});

describe('a box that passes the phone\'s request on, on real sockets', () => {
  it('earns an answer for this Mac\'s own address: the phone that dialled the box cannot open it', async () => {
    const m = await mac({ tailnet: TAILNET, publicTicked: true });
    const box = await relay(m.port);
    const p = await phone(m);
    const dialled = `127.0.0.1:${box}`; // the phone dialled the box, believing it the Mac
    const answer = await p.enroll(box, dialled);
    expect(await p.opens(answer, dialled)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${m.port}`)).not.toBeNull(); // sealed for the socket it reached the Mac on
  });

  it('holding this Mac\'s home-network address on another network, it earns nothing either', async () => {
    const m = await mac({ tailnet: TAILNET, publicTicked: true });
    const box = await relay(m.port);
    const p = await phone(m);
    const dialled = `${LAN}:${m.port}`; // what the phone dialled, and what the box passes on as the Host
    const answer = await p.enroll(box, dialled);
    expect(await p.opens(answer, dialled)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${m.port}`)).not.toBeNull();
  });

  it('the tunnel relay: a box at the Tailscale address passes it through a tunnel to the remote-only listener, and earns nothing', async () => {
    // The phone dialled 100.101.102.103:<port> on a carrier-NAT network where a box holds that address. The box
    // passes everything on, Host untouched, through a tunnel that ends on this Mac's remote-only listener.
    const m = await mac({ tailnet: TAILNET, remoteListener: true });
    const box = await relay(m.remotePort);
    const p = await phone(m);
    const dialled = `${TAILNET}:${m.port}`;
    const answer = await p.enroll(box, dialled);
    expect(await p.opens(answer, dialled)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${m.remotePort}`)).not.toBeNull();
  });

  it('a remote-only socket is never userspace Tailscale, even on the published port', async () => {
    const m = await mac({ tailnet: TAILNET, remoteOnly: true });
    const p = await phone(m);
    const dialled = `${TAILNET}:${m.port}`;
    const answer = await p.enroll(m.port, dialled);
    expect(await p.opens(answer, dialled)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${m.port}`)).not.toBeNull();
  });

  it('a loopback port that is not the published one is never userspace Tailscale', async () => {
    const m = await mac({ tailnet: TAILNET, secondListener: true });
    const p = await phone(m);
    const dialled = `${TAILNET}:${m.port}`;
    const answer = await p.enroll(m.secondPort, dialled);
    expect(await p.opens(answer, dialled)).toBeNull();
    expect(await p.opens(answer, `127.0.0.1:${m.secondPort}`)).not.toBeNull();
  });
});
