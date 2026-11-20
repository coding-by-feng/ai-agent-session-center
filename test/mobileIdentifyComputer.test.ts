// test/mobileIdentifyComputer.test.ts — plan 18, stage 2 (CONTRACT.md section C): this machine proves itself to
// a paired computer on every sign-in.
//
// The client computer uses the proof a phone's LAN rescan uses (POST /api/mobile/identify):
//   tag   = HMAC-SHA256(key = SHA-256(deviceToken), "aasc-who:" + nonce)        (nonce: 64 hex the client chose)
//   proof = HMAC-SHA256(key = SHA-256(deviceToken), "aasc-mac:" + nonce + ":" + boundAddress)
// It verifies only for the `host:port` the client dialled. That is this machine's own address on the request's
// socket, as it always was, except in two cases where the socket's address is not the one dialled and the
// request's one Host header says which address was: (a) a forwarded port, Host exactly the public pair this
// machine publishes; (b) Tailscale in userspace, Host exactly the Tailscale pair it publishes AND a loopback
// socket. The home-network address is never taken from Host. Only an approved record with the current password
// is vouched for; anything else gets a decoy. Computed the way the Electron client does, with plain HMACs.
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { createHmac, createHash } from 'node:crypto';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';
import type { PublishedAddresses } from '../server/mobile/boundAddress.js';
import { markRemoteOnlyServer } from '../server/requestLocality.js';

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

function hmac(deviceToken: string, message: string): string {
  const key = createHash('sha256').update(deviceToken).digest();
  return createHmac('sha256', key).update(message).digest('hex');
}
const tagFor = (deviceToken: string, nonce: string) => hmac(deviceToken, `aasc-who:${nonce}`);
const proofFor = (deviceToken: string, nonce: string, dialled: string) => hmac(deviceToken, `aasc-mac:${nonce}:${dialled}`);

const NONCE = 'c3'.repeat(32);
const PUBLIC = '45.63.31.79';
const TAILNET = '100.101.102.103';
const CLIENT = '00000000-0000-4000-8000-0000000000c1';
/** An IPv4 address of this very computer that is not loopback, when it has one: a socket that is not loopback. */
const OWN_ADDRESS = Object.values(networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? null;

describe('POST /api/mobile/identify for a paired computer', () => {
  let server: http.Server;
  let port: number;
  let auth: ReturnType<typeof createDeviceAuth>;
  /** What this machine publishes that a Host may name (null: nothing, "Show this computer" off); the lookup is counted. */
  let published: PublishedAddresses | null;
  let lookups: number;
  /** The address the test connects to, and so the socket's own address on the server. */
  let connectTo: string;
  /** The dashboard password's fingerprint in force: a record made under another one is not vouched for. */
  let epoch: string;

  async function start(withPublished = true, listenOn = '127.0.0.1', remoteOnly = false): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use('/api/mobile', createMobileRouter({
      deviceAuth: auth,
      isPasswordEnabled: () => true,
      requireSession: (_req, _res, n) => n(),
      createSessionToken: (id) => `session-for-${id}`,
      sessionTtlSeconds: 3600,
      pairingTarget: () => ({ name: 'Test-Mac', port: 3333, lan: '192.168.1.20', tailnet: null }),
      rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
      ...(withPublished ? { publishedAddresses: async () => { lookups += 1; return published; } } : {}),
    }));
    server = http.createServer(app);
    if (remoteOnly) markRemoteOnlyServer(server); // every connection it accepts is a remote-only socket
    await new Promise<void>((r) => server.listen(0, listenOn, r));
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    epoch = 'epoch-1';
    auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => epoch });
    published = null;
    lookups = 0;
    connectTo = '127.0.0.1';
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  /** One identify, written to the socket by hand so a test can send the Host header(s) it means to. */
  function identify(deviceToken: string, hosts: string | string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ tag: tagFor(deviceToken, NONCE), nonce: NONCE });
      const socket = net.connect(port, connectTo, () => {
        socket.write([
          'POST /api/mobile/identify HTTP/1.1',
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
          expect(raw.startsWith('HTTP/1.1 200')).toBe(true);
          const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
          resolve((JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as { data: { proof: string } }).data.proof);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  const linked = () => {
    const { code } = auth.createPairingCode();
    const out = auth.redeem({ code, label: 'Old NUC', platform: 'desktop' })!;
    auth.approve(out.device.id);
    return out;
  };
  const viaAccount = (approve: 'ask' | 'auto') =>
    auth.enrollComputer({ label: 'MacBook Pro', accountEmail: 'me@example.com', backendDeviceId: CLIENT, approve });

  it.each([
    ['a computer paired by link', () => linked()],
    ['a computer that connected through the account without asking', () => viaAccount('auto')],
    ['a computer that connected through the account and was allowed', () => {
      const out = viaAccount('ask');
      auth.approve(out.device.id);
      return out;
    }],
  ])('proves this machine to %s, for the address it reached and no other', async (_label, make) => {
    await start();
    const { deviceToken } = make();
    const proof = await identify(deviceToken, `192.168.1.20:${port}`);
    expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    expect(proof).not.toBe(proofFor(deviceToken, NONCE, `192.168.1.20:${port}`)); // a Host it does not publish is never signed
  });

  it('gives a computer still waiting for Allow a decoy: nothing verifies until the owner allows it', async () => {
    await start();
    const { device, deviceToken } = viaAccount('ask');
    const before = await identify(deviceToken, `127.0.0.1:${port}`);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(before).not.toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    auth.approve(device.id);
    expect(await identify(deviceToken, `127.0.0.1:${port}`)).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
  });

  it('gives a revoked computer a decoy', async () => {
    await start();
    const { device, deviceToken } = viaAccount('auto');
    auth.revoke(device.id);
    expect(await identify(deviceToken, `127.0.0.1:${port}`)).not.toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
  });

  describe('a caller this machine does not vouch for learns nothing about the addresses it publishes', () => {
    // The decoy used to be computed over the bound address, so the same tag and nonce sent with two Hosts came back
    // different exactly when one of them named a published pair. It is over the socket address now, with no lookup.
    const hostsOf = (p: number): Array<string | string[]> => [
      `127.0.0.1:${p}`, `${PUBLIC}:${p}`, `${TAILNET}:${p}`, `192.168.1.20:${p}`, `${PUBLIC}:${p + 1}`, 'mac-mini.example',
      [`${PUBLIC}:${p}`, `${TAILNET}:${p}`],
    ];

    it.each([
      ['a key no record holds', () => 'k'.repeat(43)],
      ['a computer still waiting for Allow', () => viaAccount('ask').deviceToken],
      ['a phone paired and not yet allowed', () => {
        const { code } = auth.createPairingCode();
        return auth.redeem({ code, label: 'Pixel', platform: 'android' })!.deviceToken;
      }],
      ['a revoked computer', () => {
        const out = viaAccount('auto');
        auth.revoke(out.device.id);
        return out.deviceToken;
      }],
      ['a device paired under an earlier password', () => {
        const out = linked();
        epoch = 'epoch-2';
        return out.deviceToken;
      }],
    ])('%s gets the same bytes whatever the Host, and nothing is looked up', async (_label, make) => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const deviceToken = make();
      const answers: string[] = [];
      for (const hosts of hostsOf(port)) answers.push(await identify(deviceToken, hosts));
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toMatch(/^[0-9a-f]{64}$/);
      // The decoy for the socket address, as before plan 18; and no proof this device would accept.
      expect(answers[0]).toBe(auth.macProof(tagFor(deviceToken, NONCE), NONCE, `127.0.0.1:${port}`));
      for (const address of [`127.0.0.1:${port}`, `${PUBLIC}:${port}`, `${TAILNET}:${port}`]) {
        expect(answers[0]).not.toBe(proofFor(deviceToken, NONCE, address));
      }
      expect(lookups).toBe(0);
    });

    it('only a device this machine vouches for gets an answer that follows the Host', async () => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const answers = new Set<string>();
      for (const hosts of hostsOf(port)) answers.add(await identify(deviceToken, hosts));
      expect(answers).toEqual(new Set([
        proofFor(deviceToken, NONCE, `127.0.0.1:${port}`), proofFor(deviceToken, NONCE, `${PUBLIC}:${port}`), proofFor(deviceToken, NONCE, `${TAILNET}:${port}`),
      ]));
      expect(lookups).toBeGreaterThan(0);
    });
  });

  describe('when the Host is the socket address (every released phone, and a computer on the home network)', () => {
    it('gives the very proof it gave before this rule, and looks nothing up', async () => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { code } = auth.createPairingCode();
      const phone = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
      auth.approve(phone.device.id);
      const proof = await identify(phone.deviceToken, `127.0.0.1:${port}`);
      // deviceAuth.macProof over reachedAt, as the route called it before plan 18.
      expect(proof).toBe(auth.macProof(tagFor(phone.deviceToken, NONCE), NONCE, `127.0.0.1:${port}`));
      expect(proof).toBe(proofFor(phone.deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(lookups).toBe(0);
    });
  });

  describe('the two cases where the Host says which address was dialled', () => {
    it('(a) a forwarded port: proves the public pair when the Host is exactly that', async () => {
      await start();
      published = { public: PUBLIC, tailnet: null, port };
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${PUBLIC}:${port}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `${PUBLIC}:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    });

    it('(b) Tailscale in userspace: proves the Tailscale pair when the Host is exactly that and the socket is loopback', async () => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${TAILNET}:${port}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `${TAILNET}:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    });

    it.skipIf(OWN_ADDRESS === null)('the carrier-NAT relay: the Tailscale pair in the Host of a request that arrived on a socket that is not loopback proves the socket address', async () => {
      await start(true, '0.0.0.0');
      connectTo = OWN_ADDRESS!; // the server's socket is now this computer's own network address, not loopback
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${TAILNET}:${port}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `${OWN_ADDRESS}:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `${TAILNET}:${port}`));
      // (a) does not: the public pair is bound on any socket.
      expect(await identify(deviceToken, `${PUBLIC}:${port}`)).toBe(proofFor(deviceToken, NONCE, `${PUBLIC}:${port}`));
    });

    it('the tunnel relay: the Tailscale pair in the Host of a request that arrived on a remote-only listener proves the socket address', async () => {
      await start(true, '127.0.0.1', true);
      published = { public: null, tailnet: TAILNET, port }; // the port matches: only "remote-only" stands in the way
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${TAILNET}:${port}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `${TAILNET}:${port}`)); // it does not verify for the pair dialled
    });

    it('the tunnel relay: the Tailscale pair in the Host of a request on a loopback port that is not the published one proves the socket address', async () => {
      await start();
      published = { public: null, tailnet: TAILNET, port: port + 1 }; // this listener is not the one others dial
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${TAILNET}:${port + 1}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `${TAILNET}:${port + 1}`));
    });

    it('for a phone too: the rule is one rule', async () => {
      await start();
      published = { public: null, tailnet: TAILNET, port };
      const { code } = auth.createPairingCode();
      const phone = auth.redeem({ code, label: 'Pixel', platform: 'android' })!;
      auth.approve(phone.device.id);
      expect(await identify(phone.deviceToken, `${TAILNET}:${port}`)).toBe(proofFor(phone.deviceToken, NONCE, `${TAILNET}:${port}`));
    });
  });

  describe('the relay case: the home-network address is never taken from Host', () => {
    it('a box holding this machine\'s home-network address on another network passes the request on: the proof names the socket it arrived on', async () => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const dialled = `192.168.1.20:${port}`; // this machine's home-network address and port, as the client dialled it
      const proof = await identify(deviceToken, dialled);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, dialled));
    });
  });

  describe('when a setting is off, its address is not published and its Host binds nothing', () => {
    it.each([
      ['Public IP not ticked', (p: number): PublishedAddresses => ({ public: null, tailnet: TAILNET, port: p }), PUBLIC],
      ['Tailscale not ticked, or not connected', (p: number): PublishedAddresses => ({ public: PUBLIC, tailnet: null, port: p }), TAILNET],
      ['"Show this computer to my account" off', (): null => null, PUBLIC],
      ['"Show this computer to my account" off (Tailscale)', (): null => null, TAILNET],
    ])('%s', async (_label, publishes, address) => {
      await start();
      published = publishes(port);
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, `${address}:${port}`);
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `${address}:${port}`));
    });
  });

  describe('when the Host is anything else, the proof is for the socket address', () => {
    it.each([
      ['an address this machine does not publish', (p: number) => `45.63.31.80:${p}`],
      ['the public address with the wrong port', (p: number) => `${PUBLIC}:${p + 1}`],
      ['the Tailscale address with the wrong port', (p: number) => `${TAILNET}:${p + 1}`],
      ['a published address with no port', () => PUBLIC],
      ['a relay\'s address', (p: number) => `192.168.1.66:${p}`],
      ['a host name', (p: number) => `mac-mini.example:${p}`],
      ['two values on one Host line', (p: number) => `${PUBLIC}:${p}, 192.168.1.66:${p}`],
    ])('%s', async (_label, host) => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, host(port));
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, host(port)));
    });

    it.each([
      ['the published pair first', (p: number) => [`${PUBLIC}:${p}`, `192.168.1.66:${p}`]],
      ['the published pair second', (p: number) => [`192.168.1.66:${p}`, `${PUBLIC}:${p}`]],
    ])('a second Host header, %s', async (_label, hosts) => {
      await start();
      published = { public: PUBLIC, tailnet: TAILNET, port };
      const { deviceToken } = viaAccount('auto');
      const proof = await identify(deviceToken, hosts(port));
      expect(proof).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
      expect(proof).not.toBe(proofFor(deviceToken, NONCE, `${PUBLIC}:${port}`));
    });

    it('a published pair while nothing is published', async () => {
      await start();
      const { deviceToken } = viaAccount('auto');
      expect(await identify(deviceToken, `${PUBLIC}:${port}`)).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    });

    it('any Host on a server wired without the rule', async () => {
      await start(false);
      const { deviceToken } = linked();
      expect(await identify(deviceToken, `${PUBLIC}:${port}`)).toBe(proofFor(deviceToken, NONCE, `127.0.0.1:${port}`));
    });
  });
});
