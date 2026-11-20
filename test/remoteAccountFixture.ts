// remoteAccountFixture.ts — a pretend account, local server and target machines for the "one account, all devices"
// client tests (plan 18, stage 2). Nothing here touches the network: `fetch` routes a URL to the box at that origin.
//
// The machine seals exactly as the contract says (section B), with real Node crypto, so a test really unseals what a
// machine really sealed. The seal is written out here on purpose, apart from the client's code: a client that drifts
// from the contract stops opening it.
import { createCipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'crypto';
import type { FetchLike } from '../electron/remote/remoteClient.js';

export const ACCESS_INFO = 'aasc-access-v1';

export interface SealInput {
  /** The client's public point, base64url (87 characters). */
  clientKey: string;
  /** The ticket's seal secret, base64url (43 characters). */
  sealSecret: string;
  nonce: string;
  /** `host:port` the answer is bound to: the machine's own address as the request reached it. */
  boundAddress: string;
  plaintext: unknown;
  /** Another domain string, to seal as plan 17's phone enroll does. */
  info?: string;
}

/** Contract B's seal: ECDH, HKDF-SHA256 over shared ‖ sealSecret, AES-256-GCM with the address in the AAD. */
export function sealAsMachine(input: SealInput): { machineKey: string; iv: string; sealed: string } {
  const info = input.info ?? ACCESS_INFO;
  const clientKeyRaw = Buffer.from(input.clientKey, 'base64url');
  const ecdh = createECDH('prime256v1');
  const machineKeyRaw = ecdh.generateKeys();
  const shared = ecdh.computeSecret(clientKeyRaw);
  const ikm = Buffer.concat([shared, Buffer.from(input.sealSecret, 'base64url')]);
  const key = Buffer.from(hkdfSync(
    'sha256', ikm, Buffer.from(input.nonce, 'utf8'), Buffer.concat([Buffer.from(info, 'utf8'), clientKeyRaw, machineKeyRaw]), 32,
  ));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${info}:${input.nonce}:${input.boundAddress}`, 'utf8'));
  const text = typeof input.plaintext === 'string' ? input.plaintext : JSON.stringify(input.plaintext);
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    machineKey: machineKeyRaw.toString('base64url'),
    iv: iv.toString('base64url'),
    sealed: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64url'),
  };
}

export interface FakeRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type FakeAnswer = { status: number; body?: unknown } | 'network-error' | 'hang';
export type Box = (req: FakeRequest) => FakeAnswer | Promise<FakeAnswer>;

export interface FakeNetwork {
  fetch: FetchLike;
  calls: FakeRequest[];
  /** Put a box at an origin (`http://192.168.1.20:3333`); null takes it away. */
  at(origin: string, box: Box | null): void;
}

/** A network of boxes by origin. An origin with no box refuses the connection. */
export function fakeNetwork(): FakeNetwork {
  const boxes = new Map<string, Box>();
  const calls: FakeRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: FakeRequest = {
      url, path: u.pathname, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const box = boxes.get(u.origin);
    // Like a real fetch, a request whose caller gives up (its deadline passed) rejects, however late the box answers.
    const givenUp = new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    givenUp.catch(() => undefined); // only the race reads it
    const out = await Promise.race([Promise.resolve(box ? box(req) : 'network-error'), givenUp]);
    if (out === 'network-error') throw new TypeError('fetch failed');
    if (out === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const text = out.body === undefined ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    return { status: out.status, text: async () => text };
  };
  return {
    fetch,
    calls,
    at(origin, box) {
      if (box) boxes.set(new URL(origin).origin, box);
      else boxes.delete(new URL(origin).origin);
    },
  };
}

export interface DirectoryMachine {
  deviceId: string;
  name: string;
  platform: string | null;
  edition: string | null;
  appVersion: string | null;
  lastUsedAt: string | null;
  current: boolean;
  connectable: boolean;
  relation: string;
  paths: { lan: string | null; tailnet: string | null; public: string | null; port: number; updatedAt: string } | null;
}

interface Ticket {
  machineId: string;
  clientKeyHash: string;
  sealSecret: string;
  used: boolean;
}

/** The backend's side of tickets, as contract A describes it. */
export interface FakeAccount {
  machines: DirectoryMachine[];
  tickets: Map<string, Ticket>;
  /** Every ticket and seal secret ever issued: a test greps answers and logs for them. */
  secrets: string[];
  issue(machineId: string, clientKey: string): { ticket: string; sealSecret: string; expiresAt: string };
  redeem(ticket: string, machineId: string): { ok: true; clientKeyHash: string; sealSecret: string } | { ok: false; code: string };
}

export function fakeAccount(machines: DirectoryMachine[]): FakeAccount {
  const tickets = new Map<string, Ticket>();
  const secrets: string[] = [];
  return {
    machines,
    tickets,
    secrets,
    issue(machineId, clientKey) {
      const ticket = randomBytes(32).toString('base64url');
      const sealSecret = randomBytes(32).toString('base64url');
      tickets.set(ticket, {
        machineId, sealSecret, used: false,
        clientKeyHash: createHash('sha256').update(Buffer.from(clientKey, 'base64url')).digest('hex'),
      });
      secrets.push(ticket, sealSecret);
      return { ticket, sealSecret, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    },
    redeem(ticket, machineId) {
      const t = tickets.get(ticket);
      // Unknown, or it names another machine: not consumed.
      if (!t || t.machineId !== machineId) return { ok: false, code: 'ticket_invalid' };
      if (t.used) return { ok: false, code: 'ticket_used' };
      t.used = true;
      return { ok: true, clientKeyHash: t.clientKeyHash, sealSecret: t.sealSecret };
    },
  };
}

export const LOCAL_ORIGIN = 'http://127.0.0.1:3333';

export interface LocalServerOptions {
  /** Answer GET /machines with this instead of the list. */
  machines?: FakeAnswer;
  /** Answer POST /machines/:id/ticket with this instead of a ticket. */
  ticket?: FakeAnswer;
}

/** This computer's own server: contract E under /api/resources/cloud. */
export function localServerBox(account: FakeAccount, options: LocalServerOptions = {}): Box {
  return (req) => {
    if (req.method === 'GET' && req.path === '/api/resources/cloud/machines') {
      return options.machines ?? { status: 200, body: { success: true, data: { machines: account.machines } } };
    }
    const ticket = /^\/api\/resources\/cloud\/machines\/([^/]+)\/ticket$/.exec(req.path);
    if (req.method === 'POST' && ticket) {
      if (options.ticket) return options.ticket;
      const clientKey = (req.body as { clientKey?: unknown } | undefined)?.clientKey;
      if (typeof clientKey !== 'string') return { status: 400, body: { success: false, error: { code: 'invalid_input', message: 'Bad key' } } };
      if (!account.machines.some((m) => m.deviceId === ticket[1] && !m.current)) {
        return { status: 404, body: { success: false, error: { code: 'machine_not_found', message: 'No such computer' } } };
      }
      return { status: 200, body: { success: true, data: account.issue(ticket[1], clientKey) } };
    }
    return { status: 404, body: { success: false, error: 'Not found' } };
  };
}

/** What an AASC with a dashboard password answers the unauthenticated probe, GET /api/auth/status. */
export const PROBE_OK: FakeAnswer = { status: 200, body: { passwordRequired: true, authenticated: false } };

const isProbe = (req: FakeRequest): boolean => req.method === 'GET' && req.path === '/api/auth/status';

/** An AASC that answers the probe, and everything else with `rest` (one answer, or a box of its own). */
export function aascBox(rest: Box | FakeAnswer): Box {
  return (req) => (isProbe(req) ? PROBE_OK : typeof rest === 'function' ? rest(req) : rest);
}

export interface FakeDevice {
  deviceId: string;
  deviceToken: string;
  status: 'pending' | 'active' | 'revoked';
  confirmCode: string | null;
}

export interface TargetOptions {
  /** `host:port` this machine sees its own socket at: what its seal and its proof are bound to, unless it publishes the Host. */
  address: string;
  /**
   * The `address:port` pairs this machine answers for when a request's Host names exactly one of them (contract B):
   * its public pair behind a forwarded port, its Tailscale pair when its socket is loopback (Tailscale in userspace).
   * Any other Host changes nothing. The server's own rule is run in remoteAccountDrift.test.ts.
   */
  publishes?: string[];
  /** The machine's device id on the account. */
  machineId: string;
  /** `ask`: a pending record with a confirm code; `auto`: active at once. */
  enroll?: 'ask' | 'auto';
  /** Answer the enroll route with this, whatever is asked. */
  refuse?: FakeAnswer;
  /** False: an AASC from before the machine proof (no /identify route). */
  proves?: boolean;
  /** False: no dashboard password, so it accepts no remote device (it says everyone is signed in, then refuses). */
  password?: boolean;
  /** The same machine at another of its addresses: this socket knows that one's devices. */
  sameMachineAs?: FakeTarget;
}

export interface FakeTarget {
  box: Box;
  devices: FakeDevice[];
  /** Every device token it ever made. */
  tokens: string[];
  enrollCalls: number;
  sessionsMinted: number;
}

const tokenKey = (deviceToken: string): Buffer => createHash('sha256').update(deviceToken).digest();
const hmac = (deviceToken: string, message: string): string => createHmac('sha256', tokenKey(deviceToken)).update(message).digest('hex');

/** A target machine: contract B's enroll route, the sign-in routes and the machine proof (C). */
export function fakeTarget(account: FakeAccount, options: TargetOptions): FakeTarget {
  const devices: FakeDevice[] = options.sameMachineAs?.devices ?? [];
  const tokens: string[] = options.sameMachineAs?.tokens ?? [];
  const nonces = new Map<string, string>();
  const sessions = new Set<string>();
  const state: FakeTarget = {
    devices, tokens, enrollCalls: 0, sessionsMinted: 0,
    box: (req) => {
      const body = (req.body ?? {}) as Record<string, string>;
      // The Host a fetch sends is the URL's authority, unless the caller set the header itself.
      const host = Object.entries(req.headers).find(([name]) => name.toLowerCase() === 'host')?.[1] ?? new URL(req.url).host;
      const bound = options.publishes?.includes(host) ? host : options.address;
      if (isProbe(req)) return options.password === false ? { status: 200, body: { passwordRequired: false, authenticated: true } } : PROBE_OK;
      if (options.password === false) return { status: 403, body: { error: 'No password', code: 'REMOTE_PASSWORD_REQUIRED' } };
      if (req.method === 'POST' && req.path === '/api/mobile/enroll-computer') {
        state.enrollCalls += 1;
        if (options.refuse) return options.refuse;
        if (body.machineId !== options.machineId) return { status: 409, body: { error: 'Not this machine', code: 'NOT_THIS_MACHINE' } };
        const redeemed = account.redeem(body.ticket, options.machineId);
        if (redeemed.ok === false) return { status: 401, body: { error: 'Invalid ticket', code: 'INVALID_TICKET' } };
        const keyHash = createHash('sha256').update(Buffer.from(body.clientKey, 'base64url')).digest('hex');
        if (keyHash !== redeemed.clientKeyHash) return { status: 401, body: { error: 'Invalid ticket', code: 'INVALID_TICKET' } };
        const active = options.enroll === 'auto';
        const device: FakeDevice = {
          deviceId: randomUUID(), deviceToken: randomBytes(32).toString('base64url'),
          status: active ? 'active' : 'pending', confirmCode: active ? null : '482913',
        };
        devices.push(device);
        tokens.push(device.deviceToken);
        const data = sealAsMachine({
          clientKey: body.clientKey, sealSecret: redeemed.sealSecret, nonce: body.nonce, boundAddress: bound,
          plaintext: { deviceId: device.deviceId, deviceToken: device.deviceToken, status: device.status, confirmCode: device.confirmCode },
        });
        return { status: 201, body: { success: true, data } };
      }
      if (req.method === 'POST' && req.path === '/api/mobile/challenge') {
        const nonce = randomBytes(24).toString('base64url');
        nonces.set(body.deviceId, nonce);
        return { status: 200, body: { success: true, data: { nonce, expiresAt: 0 } } };
      }
      if (req.method === 'POST' && req.path === '/api/mobile/session') {
        const device = devices.find((d) => d.deviceId === body.deviceId);
        if (!device || nonces.get(body.deviceId) !== body.nonce || body.proof !== hmac(device.deviceToken, body.nonce)) {
          return { status: 401, body: { error: 'Unknown device', code: 'DEVICE_UNKNOWN' } };
        }
        nonces.delete(body.deviceId);
        if (device.status === 'revoked') return { status: 401, body: { error: 'Revoked', code: 'DEVICE_REVOKED' } };
        if (device.status === 'pending') return { status: 403, body: { error: 'Pending', code: 'DEVICE_PENDING' } };
        const token = randomBytes(32).toString('hex');
        sessions.add(token);
        state.sessionsMinted += 1;
        return { status: 200, body: { success: true, data: { token, expiresIn: 3600 } } };
      }
      if (req.method === 'POST' && req.path === '/api/mobile/identify') {
        if (options.proves === false) return { status: 404, body: { error: 'Not found' } };
        const device = devices.find((d) => d.status === 'active' && hmac(d.deviceToken, `aasc-who:${body.nonce}`) === body.tag);
        const proof = device
          ? hmac(device.deviceToken, `aasc-mac:${body.nonce}:${bound}`)
          : createHmac('sha256', 'decoy').update(`${body.tag}:${body.nonce}:${bound}`).digest('hex');
        return { status: 200, body: { success: true, data: { proof } } };
      }
      if (req.method === 'POST' && req.path === '/api/mobile/unpair') {
        const at = devices.findIndex((d) => d.deviceId === body.deviceId && body.proof === hmac(d.deviceToken, body.nonce));
        if (at < 0) return { status: 401, body: { error: 'Unknown device', code: 'DEVICE_UNKNOWN' } };
        devices.splice(at, 1);
        return { status: 200, body: { success: true } };
      }
      return { status: 404, body: { error: 'Not found' } };
    },
  };
  return state;
}

/** The same box, sharing `sessions` (what GET /api/sessions answers a paired computer); a string is sent as it is. */
export function sharing(box: Box, sessions: unknown): Box {
  return (req) => (req.method === 'GET' && req.path === '/api/sessions' ? { status: 200, body: sessions } : box(req));
}

/** A box that passes every request on to another origin's box, as a relay on the home network would. */
export function relayTo(network: FakeNetwork, origin: string): Box {
  return async (req) => {
    const res = await network.fetch(`${origin}${req.path}`, {
      method: req.method, headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body),
      redirect: 'manual', signal: new AbortController().signal,
    }).catch(() => null);
    if (!res) return 'network-error';
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

export const MACHINE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
export const OTHER_MACHINE_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
export const THIS_MACHINE_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

export function machine(over: Partial<DirectoryMachine> = {}): DirectoryMachine {
  return {
    deviceId: MACHINE_ID, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0',
    lastUsedAt: '2026-11-19T20:15:00.000Z', current: false, connectable: true, relation: 'self',
    paths: { lan: '192.168.1.20', tailnet: '100.101.102.103', public: null, port: 3333, updatedAt: '2026-11-19T20:15:00.000Z' },
    ...over,
  };
}
