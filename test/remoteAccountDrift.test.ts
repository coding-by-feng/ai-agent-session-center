// remoteAccountDrift.test.ts — the client desktop and the target machine must agree byte for byte (plan 18, stage 2).
// Here the machine is the SERVER's own code: computerEnroll.ts (which seals with enrollSeal.ts), deviceAuth.ts (the
// record, the sign-in and the machine proof) and boundAddress.ts (which address an answer names). The client is the
// Electron one, run whole. If either side changes the seal, the plaintext, the proof or the address rule, this fails.
import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { ACCESS_SEAL_INFO, newClientKey, openSealedAccess } from '../electron/remote/accessSeal.js';
import { connectThroughAccount } from '../electron/remote/accountDirectory.js';
import { dialledAddress, signIn, verifyMachineProof, type RemoteClientDeps } from '../electron/remote/remoteClient.js';
import { MACHINE_KEY_RE, MACHINE_TICKET_RE } from '../server/cloud/machines.js';
import { boundAddress, type PublishedAddresses } from '../server/mobile/boundAddress.js';
import { ACCESS_SEAL_INFO as SERVER_SEAL_INFO, createComputerEnroll, type ComputerEnrollMode } from '../server/mobile/computerEnroll.js';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { isLocalRequest } from '../server/requestLocality.js';
import {
  fakeAccount, fakeNetwork, localServerBox, machine, LOCAL_ORIGIN, MACHINE_ID, type Box, type FakeAccount, type FakeNetwork,
} from './remoteAccountFixture.js';

const CLIENT_DEVICE_ID = '2c5ea4c0-4067-11e9-8bad-9b1deb4d3b7d';
const LAN = 'http://192.168.1.20:3333';
const TS = 'http://100.101.102.103:3333';
const PUB = 'http://45.63.31.79:3333';
/** What the machine publishes to the directory beside its home-network address. */
const PUBLISHED: PublishedAddresses = { public: '45.63.31.79', tailnet: '100.101.102.103', port: 3333 };
const SESSION_TOKEN = 'a'.repeat(64);

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

interface Server {
  auth: ReturnType<typeof createDeviceAuth>;
  /** The machine as a box at one of its sockets: `reachedAt` is its own address there. */
  at(reachedAt: string, published?: PublishedAddresses | null): Box;
}

/** The target machine, made of the server's own modules. Only the backend's redeem is the fixture's. */
function server(account: FakeAccount, mode: ComputerEnrollMode): Server {
  const auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => 'epoch-1' });
  const enroll = createComputerEnroll({
    offered: () => true,
    mode: () => mode,
    cloudStatus: () => ({ connection: { deviceId: MACHINE_ID } }),
    redeem: async (ticket) => {
      const redeemed = account.redeem(ticket, MACHINE_ID);
      if (redeemed.ok === false) throw new Error(redeemed.code);
      return {
        clientDeviceId: CLIENT_DEVICE_ID, clientName: 'kason-mbp', clientKind: 'server', email: 'someone@example.com',
        clientKeyHash: redeemed.clientKeyHash, sealSecret: redeemed.sealSecret,
      };
    },
    deviceAuth: auth,
  });
  return {
    auth,
    at: (reachedAt, published = null) => async (req) => {
      const body = (req.body ?? {}) as Record<string, string>;
      // The probe anyone may make (GET /api/auth/status), as server/index.ts answers it with a password set.
      if (req.method === 'GET' && req.path === '/api/auth/status') return { status: 200, body: { passwordRequired: true, authenticated: false } };
      // What the routes do with a request: the address the answer is bound to is the server's rule, fed this socket's
      // own address and the Host a client's fetch sends for the URL it dialled.
      // (The main listener's socket: its own port, and never the remote-only listener's. This fake network has no
      // peer address: not known, which changes nothing; and no proxy in front, so no forwarding header.)
      const bound = boundAddress({
        reachedAt, localAddress: reachedAt.slice(0, reachedAt.lastIndexOf(':')),
        localPort: Number(reachedAt.slice(reachedAt.lastIndexOf(':') + 1)), remoteAddress: undefined, remoteOnly: false,
        forwardingHeaders: false, host: new URL(req.url).host, published,
      });
      if (req.path === '/api/mobile/enroll-computer') {
        const out = await enroll.enroll({ machineId: body.machineId, ticket: body.ticket, clientKey: body.clientKey, nonce: body.nonce, boundAddress: bound });
        if (out.ok) return { status: 201, body: { success: true, data: out.answer } };
        return out.reason === 'not-this-machine'
          ? { status: 409, body: { error: 'x', code: 'NOT_THIS_MACHINE' } }
          : { status: 401, body: { error: 'x', code: 'INVALID_TICKET' } };
      }
      if (req.path === '/api/mobile/challenge') return { status: 200, body: { success: true, data: auth.createChallenge(body.deviceId) } };
      if (req.path === '/api/mobile/session') {
        const out = auth.exchange(body.deviceId, body.nonce, body.proof);
        if (out.ok) return { status: 200, body: { success: true, data: { token: SESSION_TOKEN, expiresIn: 3600 } } };
        return out.reason === 'pending' ? { status: 403, body: { code: 'DEVICE_PENDING' } } : { status: 401, body: { code: 'DEVICE_UNKNOWN' } };
      }
      if (req.path === '/api/mobile/identify') {
        // As the route: only a record the machine vouches for is proved over the bound address; a decoy is over the socket's.
        const prover = auth.macProver(body.tag, body.nonce);
        return { status: 200, body: { success: true, data: { proof: prover.over(prover.vouched ? bound : reachedAt) } } };
      }
      return { status: 404, body: { error: 'Not found' } };
    },
  };
}

let net: FakeNetwork;
let account: FakeAccount;
let nonces: number;
const deps = (): RemoteClientDeps => ({ fetch: net.fetch, randomHex: () => (++nonces).toString(16).padStart(64, '0'), timeoutMs: 50 });
const local = { port: 3333 };

beforeEach(() => {
  nonces = 0;
  net = fakeNetwork();
  account = fakeAccount([machine({ paths: { lan: '192.168.1.20', tailnet: '100.101.102.103', public: '45.63.31.79', port: 3333, updatedAt: 'x' } })]);
  net.at(LOCAL_ORIGIN, localServerBox(account));
});

describe('the client and the server agree', () => {
  it('on the seal’s domain string and on the shapes the route checks', async () => {
    expect(ACCESS_SEAL_INFO).toBe(SERVER_SEAL_INFO);
    expect(newClientKey().clientKey).toMatch(MACHINE_KEY_RE);
    net.at(LAN, server(account, 'ask').at('192.168.1.20:3333'));
    await connectThroughAccount(deps(), local, MACHINE_ID);
    const sent = net.calls.find((c) => c.path === '/api/mobile/enroll-computer')!.body as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['clientKey', 'machineId', 'nonce', 'ticket']);
    expect(sent.ticket).toMatch(MACHINE_TICKET_RE);
    expect(sent.clientKey).toMatch(MACHINE_KEY_RE);
    expect(sent.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it('on the local gate: what the client sends its own server passes as a request from this machine', async () => {
    net.at(LAN, server(account, 'ask').at('192.168.1.20:3333'));
    await connectThroughAccount(deps(), { port: 3333, sessionToken: 'f'.repeat(64) }, MACHINE_ID);
    const toLocal = net.calls.filter((c) => new URL(c.url).origin === LOCAL_ORIGIN);
    expect(toLocal.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/resources/cloud/machines', `POST /api/resources/cloud/machines/${MACHINE_ID}/ticket`,
    ]);
    // And the probe it makes of a machine is the question the server answers anyone.
    expect(net.calls.find((c) => c.path === '/api/auth/status')).toMatchObject({ method: 'GET', url: `${LAN}/api/auth/status`, headers: { Accept: 'application/json' } });
    for (const call of toLocal) {
      // As the server sees it: lower-case names, and the Host a fetch sends for that URL.
      const headers: Record<string, string> = {
        host: new URL(call.url).host, ...Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v])),
      };
      // The RESOURCES gate (requestLocality.ts): a loopback peer, a loopback Host and Origin, not cross-site.
      expect(isLocalRequest({ socket: { remoteAddress: '127.0.0.1' }, headers })).toBe(true);
      expect(isLocalRequest({ socket: { remoteAddress: '192.168.1.5' }, headers })).toBe(false);
      // The routes' own rule (machinesRouter.ts): no Sec-Fetch-Site from a non-browser, and an Origin naming the Host.
      expect(headers).not.toHaveProperty('sec-fetch-site');
      expect(new URL(headers.origin).host).toBe(headers.host);
      // No forwarding header, which would make it a relayed request.
      expect(Object.keys(headers).sort()).toEqual(call.method === 'GET' ? ['accept', 'cookie', 'host', 'origin'] : ['accept', 'content-type', 'cookie', 'host', 'origin']);
    }
    // A write there has to carry JSON; the ticket request does, with the key and nothing else.
    expect(toLocal[1].headers['Content-Type']).toBe('application/json');
    expect(Object.keys(toLocal[1].body as object)).toEqual(['clientKey']);
  });

  it('on a pending record: the client opens what the server’s own enroll sealed, code and all', async () => {
    const machineAt = server(account, 'ask');
    net.at(LAN, machineAt.at('192.168.1.20:3333'));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    const [record] = machineAt.auth.list();
    expect(record).toMatchObject({ status: 'pending', platform: 'desktop', label: 'kason-mbp' });
    expect(out).toMatchObject({ ok: true, via: 'lan', access: { deviceId: record.id, status: 'pending', confirmCode: expect.stringMatching(/^\d{6}$/) } });
    // The code the client shows is the one the machine's Allow prompt shows.
    expect(out.ok && out.access.confirmCode).toBe((record as unknown as { confirmCode: string }).confirmCode);
  });

  it('on an active record, the sign-in with the token it opened, and the machine’s proof', async () => {
    const machineAt = server(account, 'auto');
    net.at(LAN, machineAt.at('192.168.1.20:3333'));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    expect(out).toMatchObject({ ok: true, access: { status: 'active', confirmCode: null } });
    if (out.ok === false) return;
    const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
    expect(await verifyMachineProof(deps(), LAN, creds)).toBe('verified');
    expect(await signIn(deps(), out.target, creds, 'required')).toEqual({ state: 'ok', token: SESSION_TOKEN, expiresIn: 3600, origin: LAN, via: 'lan' });
  });

  it('on Allow: the server vouches for nothing until the owner allows it, then a proved sign-in', async () => {
    const machineAt = server(account, 'ask');
    net.at(LAN, machineAt.at('192.168.1.20:3333'));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    if (out.ok === false) throw new Error(out.error);
    const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
    net.calls.length = 0;
    // macProof gives a waiting record a decoy, so the client asks for no challenge (the handler reads this as waiting).
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'unverified', origin: LAN });
    expect(net.calls.map((c) => c.path)).toEqual(Array(3).fill('/api/mobile/identify')); // one per address listed
    machineAt.auth.approve(creds.deviceId);
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'ok', origin: LAN });
    // And once the owner removes it there, the proof stops: the same silence a box in its place would give.
    machineAt.auth.revoke(creds.deviceId);
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'unverified', origin: LAN });
  });

  it('on the address: a seal and a proof made at another socket do not pass here', async () => {
    const machineAt = server(account, 'auto');
    // A box at the home-network address hands everything to the machine, which answers from its Tailscale socket.
    net.at(LAN, machineAt.at('100.101.102.103:3333', PUBLISHED));
    expect(await connectThroughAccount(deps(), local, MACHINE_ID)).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    // The machine did make a record through that box; its token never opened here.
    expect(machineAt.auth.list()).toHaveLength(1);
  });

  it('on the home network: bound to the socket address, which is the one dialled', async () => {
    const machineAt = server(account, 'auto');
    net.at(LAN, machineAt.at('192.168.1.20:3333', PUBLISHED));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    expect(out).toMatchObject({ ok: true, via: 'lan', origin: LAN });
    if (out.ok === false) return;
    const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'ok', origin: LAN });
  });

  it('on a port forward: bound to the public address the machine publishes, when that is what the Host names', async () => {
    const machineAt = server(account, 'auto');
    // Reached through the router: the machine's socket is its private address, the client dialled the public one.
    net.at(PUB, machineAt.at('192.168.1.20:3333', PUBLISHED));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    expect(out).toMatchObject({ ok: true, via: 'public', origin: PUB });
    if (out.ok === false) return;
    expect(dialledAddress(PUB)).toBe('45.63.31.79:3333');
    const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
    expect(await verifyMachineProof(deps(), PUB, creds)).toBe('verified');
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'ok', origin: PUB, via: 'public' });
  });

  it('on Tailscale in userspace: bound to the Tailscale address the machine publishes, though its socket is loopback', async () => {
    const machineAt = server(account, 'auto');
    net.at(TS, machineAt.at('127.0.0.1:3333', PUBLISHED));
    const out = await connectThroughAccount(deps(), local, MACHINE_ID);
    expect(out).toMatchObject({ ok: true, via: 'tailnet', origin: TS });
    if (out.ok === false) return;
    const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
    expect(await signIn(deps(), out.target, creds, 'required')).toMatchObject({ state: 'ok', origin: TS, via: 'tailnet' });
  });

  // A private address is the one kind a box on ANOTHER network can hold too. The Host such a box passes on still names
  // the home-network pair, which the server never takes from a Host, whichever of its sockets the box reaches.
  it.each([
    ['Tailscale in userspace (a loopback socket)', '127.0.0.1:3333'],
    ['Tailscale in the kernel (the Tailscale socket)', '100.101.102.103:3333'],
  ])('on a box holding the same private address elsewhere, relaying over %s: refused', async (_name, socket) => {
    const machineAt = server(account, 'auto');
    net.at(LAN, machineAt.at(socket, PUBLISHED));
    expect(await connectThroughAccount(deps(), local, MACHINE_ID)).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    // And the sign-in of a record this computer already holds gets no challenge from it either.
    const { code } = machineAt.auth.createPairingCode();
    const held = machineAt.auth.redeem({ code, label: 'kason-mbp', platform: 'desktop' })!;
    machineAt.auth.approve(held.device.id);
    net.calls.length = 0;
    const out = await signIn(deps(), { lan: '192.168.1.20', tailnet: null, port: 3333 }, { deviceId: held.device.id, deviceToken: held.deviceToken }, 'required');
    expect(out).toEqual({ state: 'unverified', origin: LAN, via: 'lan' });
    expect(net.calls.map((c) => c.path)).toEqual(['/api/mobile/identify']);
  });

  it('on the Tailscale pair: taken from the Host only on a loopback socket, so a box at that address relaying to another socket is refused', async () => {
    const machineAt = server(account, 'auto');
    // The client dials the Tailscale address; what answers passes the request, Host untouched, to the machine's home-network socket.
    net.at(TS, machineAt.at('192.168.1.20:3333', PUBLISHED));
    expect(await connectThroughAccount(deps(), local, MACHINE_ID)).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
  });

  it('on kinds: the server binds a Host only to an address of its own kind, as the client only dials one', () => {
    const at = { reachedAt: '127.0.0.1:3333', localAddress: '127.0.0.1', localPort: 3333, remoteAddress: undefined, remoteOnly: false, forwardingHeaders: false };
    // A private address handed over as "public" or "Tailscale" is never bound.
    expect(boundAddress({ ...at, host: '192.168.1.20:3333', published: { public: '192.168.1.20', tailnet: null, port: 3333 } })).toBe(at.reachedAt);
    expect(boundAddress({ ...at, host: '192.168.1.20:3333', published: { public: null, tailnet: '192.168.1.20', port: 3333 } })).toBe(at.reachedAt);
    // The real kinds are, each as the pair this client opens with.
    expect(boundAddress({ ...at, host: '45.63.31.79:3333', published: PUBLISHED })).toBe(dialledAddress(PUB));
    expect(boundAddress({ ...at, host: '100.101.102.103:3333', published: PUBLISHED })).toBe(dialledAddress(TS));
    expect(boundAddress({ ...at, reachedAt: '192.168.1.20:3333', localAddress: '192.168.1.20', host: '192.168.1.20:3333', published: PUBLISHED })).toBe(dialledAddress(LAN));
  });

  it('on a port forward the machine does not publish: nothing opens, as the contract says', async () => {
    const machineAt = server(account, 'auto');
    net.at(PUB, machineAt.at('192.168.1.20:3333', null));
    expect((await connectThroughAccount(deps(), local, MACHINE_ID)).ok).toBe(false);
    const quiet = server(account, 'auto');
    net.at(PUB, quiet.at('192.168.1.20:3333', { ...PUBLISHED, public: null }));
    expect((await connectThroughAccount(deps(), local, MACHINE_ID)).ok).toBe(false);
  });

  it('on port 80: the machine reads the bare address a fetch sends as Host for the pair this client opens with', () => {
    const published: PublishedAddresses = { public: '45.63.31.79', tailnet: null, port: 80 };
    const host = new URL('http://45.63.31.79:80').host;
    expect(host).toBe('45.63.31.79');
    expect(boundAddress({
      reachedAt: '192.168.1.20:80', localAddress: '192.168.1.20', localPort: 80, remoteAddress: undefined, remoteOnly: false,
      forwardingHeaders: false, host, published,
    })).toBe(dialledAddress('http://45.63.31.79:80'));
  });

  it('on the key hash: the server takes the key the client sent as the one the ticket was made for', async () => {
    const key = newClientKey();
    const hash = createHash('sha256').update(Buffer.from(key.clientKey, 'base64url')).digest('hex');
    const { ticket, sealSecret } = account.issue(MACHINE_ID, key.clientKey);
    expect(account.tickets.get(ticket)?.clientKeyHash).toBe(hash);
    // And a seal made by the server for this key opens with the client's code directly.
    const machineAt = server(account, 'ask');
    const nonce = 'c'.repeat(64);
    const answer = await machineAt.at('192.168.1.20:3333')({
      url: `${LAN}/api/mobile/enroll-computer`, path: '/api/mobile/enroll-computer', method: 'POST', headers: {},
      body: { machineId: MACHINE_ID, ticket, clientKey: key.clientKey, nonce },
    });
    const data = typeof answer === 'object' ? (answer.body as { data: unknown }).data : null;
    expect(openSealedAccess(key, data, nonce, '192.168.1.20:3333', sealSecret)).toMatchObject({ status: 'pending' });
    expect(openSealedAccess(key, data, nonce, '192.168.1.21:3333', sealSecret)).toBeNull();
  });
});
