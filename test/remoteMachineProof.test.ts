// remoteMachineProof.test.ts — the machine proves itself BEFORE every later sign-in (plan 18, contract C): for a record
// made through the account, what answers must hold this computer's key AND sit at the address this computer dialled,
// or it gets no challenge, no sign-in proof and no session. A box that passes requests on to the machine therefore
// never sees a session token. A record paired by link asks for no proof, as before. The proof here is made by the
// server's own deviceAuth.macProof, so the client can't drift from it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import {
  MAC_PROOF_PREFIX, WHO_TAG_PREFIX, deviceProof, machineProved, signIn, unpair, verifyMachineProof,
  type FetchLike, type RemoteClientDeps,
} from '../electron/remote/remoteClient.js';
import {
  createDeviceAuth, proofForToken, MAC_PROOF_PREFIX as SERVER_MAC_PREFIX, WHO_TAG_PREFIX as SERVER_WHO_PREFIX,
  type MobileDeviceRecord, type MobileDeviceStore,
} from '../server/mobile/deviceAuth.js';

const NONCE = 'c'.repeat(64);
const LAN = 'http://192.168.1.20:3333';
const TS = 'http://100.101.102.103:3333';
const PUB = 'http://45.63.31.79:3333';
const HOSTED = 'https://order-abc123.aasc.work';
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

interface Call { url: string; body: Record<string, unknown> }

/** How a machine answers /identify: with the server's own macProof over `address`, or not at all. */
type Identify = { address: string } | { status: number; body?: unknown } | 'network-error';

let auth: ReturnType<typeof createDeviceAuth>;
let creds: { deviceId: string; deviceToken: string };

beforeEach(() => {
  auth = createDeviceAuth({ store: memoryStore(), credentialEpoch: () => 'epoch-1' });
  const { code } = auth.createPairingCode();
  const redeemed = auth.redeem({ code, label: 'kason-mbp', platform: 'desktop' })!;
  auth.approve(redeemed.device.id);
  creds = { deviceId: redeemed.device.id, deviceToken: redeemed.deviceToken };
});

/**
 * A machine at every address: the real deviceAuth signs sessions in and proves itself. `identify` says what its socket
 * address is at each origin (a relay's box answers with the machine's own).
 */
function machine(identify: Record<string, Identify>, session: { status: number; body?: unknown } | null = null, down: string[] = []) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) as Record<string, string> : {};
    calls.push({ url, body });
    const { origin, pathname } = new URL(url);
    if (down.includes(origin)) throw new TypeError('fetch failed');
    const reply = (status: number, data: unknown) => ({ status, text: async () => JSON.stringify(data) });
    if (pathname === '/api/mobile/challenge') return reply(200, { success: true, data: auth.createChallenge(body.deviceId) });
    if (pathname === '/api/mobile/session') {
      if (session) return reply(session.status, session.body);
      const verified = auth.exchange(body.deviceId, body.nonce, body.proof);
      return verified.ok
        ? reply(200, { success: true, data: { token: SESSION_TOKEN, expiresIn: 3600 } })
        : reply(401, { code: 'DEVICE_UNKNOWN' });
    }
    if (pathname === '/api/mobile/identify') {
      const how = identify[origin] ?? { status: 404, body: { error: 'Not found' } };
      if (how === 'network-error') throw new TypeError('fetch failed');
      if ('address' in how) return reply(200, { success: true, data: { proof: auth.macProof(body.tag, body.nonce, how.address) } });
      return reply(how.status, how.body ?? {});
    }
    if (pathname === '/api/mobile/unpair') return reply(auth.unpair(body.deviceId, body.nonce, body.proof) ? 200 : 401, { success: true });
    return reply(404, { error: 'Not found' });
  };
  return {
    fetch,
    calls,
    identifies: () => calls.filter((c) => c.url.endsWith('/api/mobile/identify')),
    /** The paths one address was asked, in order: what a box there saw of this computer. */
    seenAt: (origin: string) => calls.filter((c) => new URL(c.url).origin === origin).map((c) => new URL(c.url).pathname),
  };
}

const deps = (fetch: FetchLike, extra: Partial<RemoteClientDeps> = {}): RemoteClientDeps => ({ fetch, randomHex: () => NONCE, timeoutMs: 50, ...extra });
const HONEST = { [LAN]: { address: '192.168.1.20:3333' }, [TS]: { address: '100.101.102.103:3333' }, [PUB]: { address: '45.63.31.79:3333' } };

describe('verifyMachineProof', () => {
  it('uses the server’s prefixes', () => {
    expect(WHO_TAG_PREFIX).toBe(SERVER_WHO_PREFIX);
    expect(MAC_PROOF_PREFIX).toBe(SERVER_MAC_PREFIX);
  });

  it('accepts the server’s own proof for the address dialled, naming itself by a tag and never by its id or token', async () => {
    const m = machine(HONEST);
    expect(await verifyMachineProof(deps(m.fetch), LAN, creds)).toBe('verified');
    expect(m.calls).toEqual([{
      url: `${LAN}/api/mobile/identify`,
      body: { tag: proofForToken(creds.deviceToken, `${SERVER_WHO_PREFIX}${NONCE}`), nonce: NONCE },
    }]);
    expect(JSON.stringify(m.calls)).not.toContain(creds.deviceToken);
    expect(JSON.stringify(m.calls)).not.toContain(creds.deviceId);
    expect(deviceProof(creds.deviceToken, 'x')).toBe(proofForToken(creds.deviceToken, 'x'));
  });

  it('says mismatch for a proof made at another address: a box passing the question on', async () => {
    const relayed = machine({ [LAN]: { address: '100.101.102.103:3333' } });
    expect(await verifyMachineProof(deps(relayed.fetch), LAN, creds)).toBe('mismatch');
    const otherPort = machine({ [LAN]: { address: '192.168.1.20:3334' } });
    expect(await verifyMachineProof(deps(otherPort.fetch), LAN, creds)).toBe('mismatch');
  });

  it('says mismatch for a machine that doesn’t know this computer (its decoy)', async () => {
    const m = machine(HONEST);
    expect(await verifyMachineProof(deps(m.fetch), LAN, { ...creds, deviceToken: 'some-other-device-token-0123456789' })).toBe('mismatch');
  });

  it('reads the port a URL leaves out', async () => {
    const m = machine({ 'http://192.168.1.20': { address: '192.168.1.20:80' } });
    expect(await verifyMachineProof(deps(m.fetch), 'http://192.168.1.20:80', creds)).toBe('verified');
  });

  it.each<[string, Identify]>([
    ['a machine from before the proof (404)', { status: 404, body: { error: 'Not found' } }],
    ['a refusal', { status: 429, body: { error: 'Too many' } }],
    ['an answer with no proof', { status: 200, body: { success: true, data: {} } }],
    ['a proof of the wrong shape', { status: 200, body: { success: true, data: { proof: 'yes' } } }],
    ['an answer that is no JSON', { status: 200, body: '<html>router</html>' }],
  ])('says none for %s: something answered, with no proof', async (_name, how) => {
    const m = machine({ [LAN]: how });
    expect(await verifyMachineProof(deps(m.fetch), LAN, creds)).toBe('none');
  });

  it('says silent when nothing answered at all, which is not a wrong answer', async () => {
    const m = machine({ [LAN]: 'network-error' });
    expect(await verifyMachineProof(deps(m.fetch), LAN, creds)).toBe('silent');
  });

  it('asks nothing when the random source gives no nonce', async () => {
    const m = machine(HONEST);
    expect(await verifyMachineProof(deps(m.fetch, { randomHex: () => 'nope' }), LAN, creds)).toBe('silent');
    expect(m.calls).toEqual([]);
  });
});

describe('machineProved', () => {
  it('takes nothing but a verified proof when one is required, on every path', async () => {
    const m = machine({ ...HONEST, 'http://192.168.1.21:3333': { address: '192.168.1.20:3333' } });
    for (const origin of [LAN, TS, PUB]) expect(await machineProved(deps(m.fetch), origin, creds, 'required'), origin).toBe(true);
    // A proof for another address, and no proof at all.
    expect(await machineProved(deps(m.fetch), 'http://192.168.1.21:3333', creds, 'required')).toBe(false);
    expect(await machineProved(deps(m.fetch), 'http://192.168.1.99:3333', creds, 'required')).toBe(false);
    expect(await machineProved(deps(m.fetch), HOSTED, creds, 'required')).toBe(false);
  });

  it('asks nothing at all when the rule is to skip', async () => {
    const m = machine({ [LAN]: { address: '192.168.1.66:3333' } });
    for (const origin of [LAN, TS, PUB, HOSTED]) expect(await machineProved(deps(m.fetch), origin, creds, 'skip'), origin).toBe(true);
    expect(m.calls).toEqual([]);
  });
});

describe('signIn', () => {
  const target = { lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 };

  it('checks nothing unless asked: a caller that passes no rule gets the sign-in as before', async () => {
    const m = machine({});
    expect(await signIn(deps(m.fetch), target, creds)).toMatchObject({ state: 'ok', origin: LAN });
    expect(m.identifies()).toEqual([]);
  });

  describe('for a record made through the account', () => {
    const SIGN_IN = ['/api/mobile/identify', '/api/mobile/challenge', '/api/mobile/session'];
    const lanOnly = { lan: '192.168.1.20', tailnet: null, port: 3333 };

    it('asks the machine to prove itself first, then signs in at that same address', async () => {
      const m = machine(HONEST);
      expect(await signIn(deps(m.fetch), target, creds, 'required')).toEqual({ state: 'ok', token: SESSION_TOKEN, expiresIn: 3600, origin: LAN, via: 'lan' });
      expect(m.seenAt(LAN)).toEqual(SIGN_IN);
      expect(m.seenAt(TS)).toEqual([]);
    });

    it('gives a box that passes everything on to the machine no challenge and no sign-in proof', async () => {
      // At the home-network address, a box that forwards to the machine: its proof names the machine's own socket.
      const m = machine({ [LAN]: { address: '100.101.102.103:3333' } });
      const out = await signIn(deps(m.fetch), lanOnly, creds, 'required');
      expect(out).toEqual({ state: 'unverified', origin: LAN, via: 'lan' });
      // All it ever saw: one question it could not answer for this address. No session was minted for it to keep.
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify']);
      expect(JSON.stringify(m.calls)).not.toContain(creds.deviceId);
    });

    it('moves on from such a box to an address where the machine does prove itself', async () => {
      const m = machine({ ...HONEST, [LAN]: { address: '100.101.102.103:3333' } });
      expect(await signIn(deps(m.fetch), target, creds, 'required')).toMatchObject({ state: 'ok', origin: TS, via: 'tailnet' });
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify']);
      expect(m.seenAt(TS)).toEqual(SIGN_IN);
    });

    it('gives nothing to a machine that offers no proof', async () => {
      const m = machine({});
      expect(await signIn(deps(m.fetch), target, creds, 'required')).toEqual({ state: 'unverified', origin: LAN, via: 'lan' });
      expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/mobile/identify', '/api/mobile/identify']);
    });

    it('needs the proof over Tailscale and a public address too', async () => {
      const m = machine({ [TS]: { address: '127.0.0.1:3333' }, [PUB]: { address: '192.168.1.20:3333' } });
      expect(await signIn(deps(m.fetch), { lan: null, tailnet: '100.101.102.103', port: 3333 }, creds, 'required')).toMatchObject({ state: 'unverified', via: 'tailnet' });
      expect(await signIn(deps(m.fetch), { lan: null, tailnet: null, publicAddress: '45.63.31.79', port: 3333 }, creds, 'required')).toMatchObject({ state: 'unverified', via: 'public' });
      expect(m.identifies()).toHaveLength(m.calls.length);
    });

    it('is offline, not "something else", when nothing answers at all', async () => {
      const m = machine(HONEST, null, [LAN, TS]);
      const out = await signIn(deps(m.fetch), target, creds, 'required');
      expect(out.state).toBe('offline');
      if (out.state === 'offline') expect(out.message).toMatch(/No answer from 192\.168\.1\.20 or 100\.101\.102\.103/);
    });

    it('says something else answered when one address answered wrongly and the others were silent', async () => {
      const m = machine({ [TS]: { address: '127.0.0.1:3333' } }, null, [LAN]);
      expect(await signIn(deps(m.fetch), target, creds, 'required')).toEqual({ state: 'unverified', origin: TS, via: 'tailnet' });
    });

    it('while it waits for Allow, nothing verifies and no challenge is asked; once allowed, it signs in', async () => {
      const { code } = auth.createPairingCode();
      const waiting = auth.redeem({ code, label: 'second-computer', platform: 'desktop' })!;
      const pending = { deviceId: waiting.device.id, deviceToken: waiting.deviceToken };
      const m = machine(HONEST);
      expect(await signIn(deps(m.fetch), lanOnly, pending, 'required')).toEqual({ state: 'unverified', origin: LAN, via: 'lan' });
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify']);
      auth.approve(pending.deviceId);
      expect(await signIn(deps(m.fetch), lanOnly, pending, 'required')).toMatchObject({ state: 'ok', origin: LAN });
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify', ...SIGN_IN]);
    });

    it('after the machine’s owner removes this computer, sends no sign-in proof to find out', async () => {
      auth.revoke(creds.deviceId);
      const m = machine(HONEST);
      expect(await signIn(deps(m.fetch), lanOnly, creds, 'required')).toEqual({ state: 'unverified', origin: LAN, via: 'lan' });
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify']);
    });

    it('goes on to the next address when the one that proved itself falls silent before the challenge', async () => {
      const m = machine(HONEST);
      const flaky: FetchLike = (url, init) => (url === `${LAN}/api/mobile/challenge` ? Promise.reject(new TypeError('fetch failed')) : m.fetch(url, init));
      expect(await signIn(deps(flaky), target, creds, 'required')).toMatchObject({ state: 'ok', origin: TS, via: 'tailnet' });
    });
  });

  describe('unpair', () => {
    it('for a record made through the account, removes itself only where the machine proved itself', async () => {
      const m = machine({ ...HONEST, [LAN]: { address: '100.101.102.103:3333' } });
      expect(await unpair(deps(m.fetch), target, creds, 'required')).toBe(true);
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/identify']);
      expect(m.seenAt(TS)).toEqual(['/api/mobile/identify', '/api/mobile/challenge', '/api/mobile/unpair']);
      expect(auth.list()).toEqual([]);
    });

    it('for such a record, answers no challenge when nothing proves itself', async () => {
      const m = machine({ [LAN]: { address: '100.101.102.103:3333' } });
      expect(await unpair(deps(m.fetch), target, creds, 'required')).toBe(false);
      expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/mobile/identify', '/api/mobile/identify']);
      expect(auth.list()).toHaveLength(1);
    });

    it('for a record paired by link, asks for the challenge at once, as before', async () => {
      const m = machine({});
      expect(await unpair(deps(m.fetch), target, creds)).toBe(true);
      expect(m.seenAt(LAN)).toEqual(['/api/mobile/challenge', '/api/mobile/unpair']);
    });
  });

  describe('for a record paired by link', () => {
    it('keeps today’s behaviour: no proof is asked for on any path', async () => {
      const m = machine({});
      expect(await signIn(deps(m.fetch), target, creds, 'skip')).toMatchObject({ state: 'ok', origin: LAN, via: 'lan' });
      expect(await signIn(deps(m.fetch), { lan: null, tailnet: '100.101.102.103', port: 3333 }, creds, 'skip')).toMatchObject({ state: 'ok', via: 'tailnet' });
      expect(await signIn(deps(m.fetch), { lan: null, tailnet: null, publicAddress: '45.63.31.79', port: 3333 }, creds, 'skip')).toMatchObject({ state: 'ok', via: 'public' });
      expect(await signIn(deps(m.fetch), { lan: null, tailnet: null, httpsOrigin: HOSTED, port: 443 }, creds, 'skip')).toMatchObject({ state: 'ok', via: 'https' });
      expect(m.identifies()).toEqual([]);
    });

    // A released machine binds its proof to its socket address, which is not the one dialled behind a forwarded port
    // or userspace Tailscale: refusing on it would lock out records that work, and stop nobody.
    it('signs in even where the machine’s proof would be for another address', async () => {
      const m = machine({ [LAN]: { address: '192.168.1.66:3333' }, [TS]: { address: '127.0.0.1:3333' } });
      expect(await signIn(deps(m.fetch), target, creds, 'skip')).toEqual({ state: 'ok', token: SESSION_TOKEN, expiresIn: 3600, origin: LAN, via: 'lan' });
      expect(m.identifies()).toEqual([]);
    });
  });
});
