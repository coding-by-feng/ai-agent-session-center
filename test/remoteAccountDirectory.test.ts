// remoteAccountDirectory.test.ts — "one account, all devices" on the client desktop (plan 18, stage 2, contract F):
// reading the account's computers from THIS computer's own server, and connecting to one with a ticket instead of a
// pairing link. The local server, the backend's tickets and the target machines are the fixture's; the seal is real.
import { describe, it, expect } from 'vitest';
import {
  connectThroughAccount, readAccountDirectory, ENROLL_TIMEOUT_MS, type AccountClientDeps, type LocalServer,
} from '../electron/remote/accountDirectory.js';
import { dialledAddress, signIn, TRY_TIMEOUT_MS } from '../electron/remote/remoteClient.js';
import {
  aascBox, fakeAccount, fakeNetwork, fakeTarget, localServerBox, machine, relayTo, sealAsMachine,
  LOCAL_ORIGIN, MACHINE_ID, OTHER_MACHINE_ID, THIS_MACHINE_ID,
  type Box, type DirectoryMachine, type FakeAnswer, type FakeNetwork, type LocalServerOptions, type TargetOptions,
} from './remoteAccountFixture.js';

const LAN = 'http://192.168.1.20:3333';
const TS = 'http://100.101.102.103:3333';
const PUB = 'http://45.63.31.79:3333';
const local: LocalServer = { port: 3333 };
const ENROLL = '/api/mobile/enroll-computer';
const PROBE = '/api/auth/status';
const MACHINES = '/api/resources/cloud/machines';
const COULD_NOT_FINISH = 'Couldn’t finish connecting to Mac mini. Try again.';

let nonces = 0;
function deps(net: FakeNetwork, extra: Partial<AccountClientDeps> = {}): AccountClientDeps {
  return { fetch: net.fetch, randomHex: () => (++nonces).toString(16).padStart(64, '0'), timeoutMs: 50, enrollTimeoutMs: 50, ...extra };
}

interface World {
  net: FakeNetwork;
  account: ReturnType<typeof fakeAccount>;
  lan: ReturnType<typeof fakeTarget>;
  tailnet: ReturnType<typeof fakeTarget>;
}

/** This computer's server, and the Mac mini answering at its home-network and Tailscale addresses. */
function world(options: { machines?: DirectoryMachine[]; local?: LocalServerOptions; target?: Partial<TargetOptions> } = {}): World {
  const net = fakeNetwork();
  const account = fakeAccount(options.machines ?? [machine({ deviceId: THIS_MACHINE_ID, name: 'MacBook Pro', current: true, paths: null }), machine()]);
  net.at(LOCAL_ORIGIN, localServerBox(account, options.local));
  const lan = fakeTarget(account, { address: '192.168.1.20:3333', machineId: MACHINE_ID, ...options.target });
  const tailnet = fakeTarget(account, { address: '100.101.102.103:3333', machineId: MACHINE_ID, ...options.target });
  net.at(LAN, lan.box);
  net.at(TS, tailnet.box);
  return { net, account, lan, tailnet };
}

const enrollCalls = (net: FakeNetwork) => net.calls.filter((c) => c.path === ENROLL);
const probeCalls = (net: FakeNetwork) => net.calls.filter((c) => c.path === PROBE);
const ticketCalls = (net: FakeNetwork) => net.calls.filter((c) => c.path.endsWith('/ticket'));

describe('readAccountDirectory', () => {
  it('lists the account’s computers with what the UI shows of each', async () => {
    const { net } = world();
    const out = await readAccountDirectory(deps(net), local);
    expect(out).toEqual({
      state: 'ok',
      machines: [
        {
          deviceId: THIS_MACHINE_ID, name: 'MacBook Pro', platform: 'macos', edition: 'full', appVersion: '2.11.0',
          lastUsedAt: Date.parse('2026-11-19T20:15:00.000Z'), current: true, connectable: true, relation: 'self', addresses: null,
        },
        {
          deviceId: MACHINE_ID, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0',
          lastUsedAt: Date.parse('2026-11-19T20:15:00.000Z'), current: false, connectable: true, relation: 'self',
          addresses: { lan: '192.168.1.20', tailnet: '100.101.102.103', publicAddress: null, port: 3333 },
        },
      ],
    });
  });

  it('asks this computer’s own server on loopback, as its own page would', async () => {
    const { net } = world();
    await readAccountDirectory(deps(net), local);
    expect(net.calls).toHaveLength(1);
    const [call] = net.calls;
    expect(call.url).toBe(`${LOCAL_ORIGIN}${MACHINES}`);
    expect(call.method).toBe('GET');
    expect(call.body).toBeUndefined();
    expect(call.headers).toEqual({ Accept: 'application/json', Origin: LOCAL_ORIGIN });
  });

  it('carries the dashboard window’s session when this computer has a password, and only then', async () => {
    const { net } = world();
    await readAccountDirectory(deps(net), { port: 3333, sessionToken: 'a'.repeat(64) });
    expect(net.calls[0].headers.Cookie).toBe(`auth_token=${'a'.repeat(64)}`);
    await readAccountDirectory(deps(net), { port: 3333, sessionToken: null });
    expect(net.calls[1].headers).not.toHaveProperty('Cookie');
    // A cookie value that could add a second header or a second cookie is not sent at all.
    await readAccountDirectory(deps(net), { port: 3333, sessionToken: 'abc; other=1\r\nX-Evil: 1' });
    expect(net.calls[2].headers).not.toHaveProperty('Cookie');
  });

  it.each([0, -1, 70_000, 3333.5, Number.NaN])('asks nothing for a port that is none (%s)', async (port) => {
    const { net } = world();
    expect(await readAccountDirectory(deps(net), { port })).toEqual({ state: 'unreachable' });
    expect(net.calls).toEqual([]);
  });

  it.each<[string, FakeAnswer, string]>([
    ['no usable connection (409)', { status: 409, body: { success: false, error: { code: 'not_connected', message: 'Sign in first' } } }, 'signed-out'],
    ['a sign-in from before this release', { status: 403, body: { success: false, error: { code: 'needs_sign_in', message: 'Sign in again' } } }, 'needs-sign-in'],
    ['needs_sign_in named at the top level', { status: 403, body: { code: 'needs_sign_in' } }, 'needs-sign-in'],
    ['the backend not answering', { status: 502, body: { success: false, error: { code: 'cloud_unavailable', message: 'x' } } }, 'unreachable'],
    ['a dashboard that wants a sign-in', { status: 401, body: { error: 'Unauthorized' } }, 'unreachable'],
    ['a server from before plan 18', { status: 404, body: { error: 'Not found' } }, 'unreachable'],
    // The cloud answers, but its backend predates the machines service: Retry can't change that, a deploy can.
    ['a backend with no machines service', { status: 404, body: { success: false, error: { code: 'unsupported', message: 'x' } } }, 'unsupported'],
    ['an answer that is no JSON', { status: 200, body: '<html>' }, 'unreachable'],
    ['a list of the wrong shape', { status: 200, body: { success: true, data: { machines: 'none' } } }, 'unreachable'],
    ['no answer at all', 'network-error', 'unreachable'],
    ['an answer that never comes', 'hang', 'unreachable'],
  ])('says %s as a state the UI can show, never an error', async (_name, answer, state) => {
    const { net } = world({ local: { machines: answer } });
    expect(await readAccountDirectory(deps(net), local)).toEqual({ state });
  });

  // The main process dials plain HTTP to whatever passes, and (plan 18) a record's addresses are replaced by these.
  // One address of the wrong kind means the entry is not to be trusted for any of them.
  it('shows no address at all for a computer that lists one of the wrong kind', async () => {
    const paths = (p: Partial<NonNullable<DirectoryMachine['paths']>>) => ({ lan: null, tailnet: null, public: null, port: 3333, updatedAt: 'x', ...p });
    const good = { lan: '192.168.1.20', tailnet: '100.64.0.9', public: '45.63.31.79' };
    const bad: Array<Partial<NonNullable<DirectoryMachine['paths']>>> = [
      { ...good, lan: '8.8.8.8' }, { ...good, lan: '169.254.169.254' }, { ...good, lan: '010.1.1.1' }, { ...good, lan: 'mac-mini.local' },
      { ...good, tailnet: '192.168.1.5' }, { ...good, tailnet: 'evil.example' },
      { ...good, public: '10.0.0.1' }, { ...good, public: '127.0.0.1' }, { ...good, public: '100.74.194.86' },
      { ...good, lan: 7 as unknown as string },
    ];
    const { net } = world({
      machines: [
        machine({ deviceId: MACHINE_ID, paths: paths(good) }),
        machine({ deviceId: OTHER_MACHINE_ID, paths: paths({ tailnet: '100.64.0.9' }) }),
        ...bad.map((p, i) => machine({ deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, paths: paths(p) })),
      ],
    });
    const out = await readAccountDirectory(deps(net), local);
    expect(out.state === 'ok' && out.machines.map((m) => m.addresses)).toEqual([
      { lan: '192.168.1.20', tailnet: '100.64.0.9', publicAddress: '45.63.31.79', port: 3333 },
      { lan: null, tailnet: '100.64.0.9', publicAddress: null, port: 3333 },
      ...bad.map(() => null),
    ]);
  });

  it('shows no address for a port that is none', async () => {
    const { net } = world({ machines: [machine({ paths: { lan: '192.168.1.20', tailnet: null, public: null, port: 0, updatedAt: 'x' } })] });
    const out = await readAccountDirectory(deps(net), local);
    expect(out.state === 'ok' && out.machines[0].addresses).toBeNull();
  });

  it('tolerates values it doesn’t know, and drops an entry it can’t name', async () => {
    const { net } = world({
      machines: [
        machine({ platform: 'haiku', edition: 'tablet', relation: 'group', appVersion: null, lastUsedAt: null }),
        machine({ deviceId: 'NOT-A-UUID' }),
        machine({ deviceId: OTHER_MACHINE_ID, name: 'Linux‮box\u0007', platform: '<script>', appVersion: 'x'.repeat(200), lastUsedAt: 'yesterday' }),
        { deviceId: THIS_MACHINE_ID } as DirectoryMachine,
        null as unknown as DirectoryMachine,
      ],
    });
    const out = await readAccountDirectory(deps(net), local);
    expect(out.state === 'ok' && out.machines).toMatchObject([
      { deviceId: MACHINE_ID, platform: 'haiku', edition: 'tablet', relation: 'other', appVersion: null, lastUsedAt: null },
      { deviceId: OTHER_MACHINE_ID, name: 'Linuxbox', platform: null, appVersion: null, lastUsedAt: null },
    ]);
    expect(out.state === 'ok' && out.machines).toHaveLength(2);
  });

  it('reads at most 64 computers', async () => {
    const many = Array.from({ length: 80 }, (_, i) => machine({ deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    const { net } = world({ machines: many });
    const out = await readAccountDirectory(deps(net), local);
    expect(out.state === 'ok' && out.machines).toHaveLength(64);
  });
});

describe('connectThroughAccount', () => {
  it('probes the address, gets a ticket, enrolls there and opens the sealed answer', async () => {
    const { net, account, lan, tailnet } = world();
    const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
    expect(out).toEqual({
      ok: true, via: 'lan', origin: LAN, name: 'Mac mini',
      target: { lan: '192.168.1.20', tailnet: '100.101.102.103', publicAddress: null, port: 3333 },
      access: { deviceId: lan.devices[0].deviceId, deviceToken: lan.devices[0].deviceToken, status: 'pending', confirmCode: '482913' },
    });
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${LOCAL_ORIGIN}${MACHINES}`,
      `GET ${LAN}${PROBE}`,
      `POST ${LOCAL_ORIGIN}${MACHINES}/${MACHINE_ID}/ticket`,
      `POST ${LAN}${ENROLL}`,
    ]);
    // The probe is the question anyone may ask: no body, nothing of this computer's in it.
    const [probe] = probeCalls(net);
    expect(probe.body).toBeUndefined();
    expect(probe.headers).toEqual({ Accept: 'application/json' });
    const [ticket] = ticketCalls(net);
    expect(Object.keys(ticket.body as object)).toEqual(['clientKey']);
    expect((ticket.body as { clientKey: string }).clientKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(ticket.headers).toMatchObject({ Origin: LOCAL_ORIGIN, 'Content-Type': 'application/json' });
    const [enroll] = enrollCalls(net);
    expect(enroll.body).toEqual({
      machineId: MACHINE_ID, ticket: account.secrets[0], clientKey: (ticket.body as { clientKey: string }).clientKey,
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The machine never sees this computer's dashboard session, and no request names another origin.
    expect(enroll.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(tailnet.enrollCalls).toBe(0);
  });

  it('opens an active record when the machine connects its account’s computers without asking', async () => {
    const { net } = world({ target: { enroll: 'auto' } });
    const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
    expect(out).toMatchObject({ ok: true, access: { status: 'active', confirmCode: null } });
  });

  it('makes a new key pair for every connection', async () => {
    const { net } = world();
    await connectThroughAccount(deps(net), local, MACHINE_ID);
    await connectThroughAccount(deps(net), local, MACHINE_ID);
    const keys = ticketCalls(net).map((c) => (c.body as { clientKey: string }).clientKey);
    expect(new Set(keys).size).toBe(2);
  });

  // The enroll waits on the machine's round trip to the backend, so it gets a budget of its own; a quick probe first
  // keeps a dead address from costing that long, and keeps the ticket away from an address where nothing answers.
  describe('the probe, before the ticket is spent at an address', () => {
    it('gives a probe 3 seconds and the enroll 15', () => {
      expect(TRY_TIMEOUT_MS).toBe(3_000);
      expect(ENROLL_TIMEOUT_MS).toBe(15_000);
    });

    it.each<[string, Box | null]>([
      ['nothing answers there', null],
      ['it never answers', () => 'hang'],
      ['a web page answers', () => ({ status: 200, body: '<html>router</html>' })],
      ['a JSON list answers', () => ({ status: 200, body: [1, 2] })],
      ['a bare redirect answers', () => ({ status: 302 })],
      ['something answers the probe with an error', () => ({ status: 500, body: { error: 'boom' } })],
    ])('moves on without sending the ticket when %s', async (_name, atLan) => {
      const { net, account, tailnet } = world();
      net.at(LAN, atLan);
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'tailnet', origin: TS });
      expect(probeCalls(net).map((c) => new URL(c.url).origin)).toEqual([LAN, TS]);
      // The home-network address saw the probe and nothing else: no ticket, no key.
      expect(net.calls.filter((c) => new URL(c.url).origin === LAN).map((c) => c.path)).toEqual([PROBE]);
      expect(enrollCalls(net).map((c) => new URL(c.url).origin)).toEqual([TS]);
      expect(ticketCalls(net)).toHaveLength(1);
      expect(account.secrets).toHaveLength(2);
      expect(tailnet.devices).toHaveLength(1);
    });

    it('asks for no ticket at all when no address answers, and says where it looked', async () => {
      const { net } = world();
      net.at(LAN, null);
      net.at(TS, null);
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(/Can’t reach Mac mini\..*192\.168\.1\.20.*100\.101\.102\.103/);
      expect(ticketCalls(net)).toEqual([]);
      expect(enrollCalls(net)).toEqual([]);
    });

    it('tries a public address last', async () => {
      const { net, account } = world({
        machines: [machine({ paths: { lan: '192.168.1.20', tailnet: '100.101.102.103', public: '45.63.31.79', port: 3333, updatedAt: 'x' } })],
      });
      net.at(LAN, null);
      net.at(TS, null);
      net.at(PUB, fakeTarget(account, { address: '45.63.31.79:3333', machineId: MACHINE_ID }).box);
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'public', origin: PUB });
      expect(probeCalls(net).map((c) => new URL(c.url).origin)).toEqual([LAN, TS, PUB]);
      expect(enrollCalls(net).map((c) => new URL(c.url).origin)).toEqual([PUB]);
    });

    it('does not send the ticket to an AASC with no dashboard password, and says so when nothing else answers', async () => {
      const { net, account } = world();
      const open = fakeTarget(account, { address: '192.168.1.20:3333', machineId: MACHINE_ID, password: false });
      net.at(LAN, open.box);
      expect(await connectThroughAccount(deps(net), local, MACHINE_ID)).toMatchObject({ ok: true, via: 'tailnet' });
      expect(open.enrollCalls).toBe(0);
      // With nothing else to try, the reason is the one worth reading.
      const alone = world();
      alone.net.at(LAN, fakeTarget(alone.account, { address: '192.168.1.20:3333', machineId: MACHINE_ID, password: false }).box);
      alone.net.at(TS, null);
      const out = await connectThroughAccount(deps(alone.net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(/no dashboard password/);
      expect(ticketCalls(alone.net)).toEqual([]);
    });

    it('lets the enroll take longer than a probe may', async () => {
      const { net, lan } = world();
      // Slower than the probe's budget, as a machine waiting on the backend is; well inside the enroll's own.
      net.at(LAN, async (req) => {
        if (req.path === ENROLL) await new Promise((resolve) => setTimeout(resolve, 120));
        return lan.box(req);
      });
      const out = await connectThroughAccount(deps(net, { timeoutMs: 40, enrollTimeoutMs: 2_000 }), local, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'lan' });
    });
  });

  describe('the same ticket at the next address', () => {
    it.each<[string, (other: Box) => Box]>([
      ['another AASC holds the home-network address (NOT_THIS_MACHINE)', (other) => other],
      ['the connection fails outright on the enroll itself', () => aascBox(() => 'network-error')],
    ])('moves on when %s', async (_name, atLan) => {
      const { net, account, tailnet } = world();
      // Another of the account's computers, which took over that home-network address.
      const other = fakeTarget(account, { address: '192.168.1.20:3333', machineId: OTHER_MACHINE_ID });
      net.at(LAN, atLan(other.box));
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'tailnet', origin: TS });
      expect(ticketCalls(net)).toHaveLength(1);
      const sent = enrollCalls(net).map((c) => (c.body as { ticket: string }).ticket);
      expect(sent).toEqual([account.secrets[0], account.secrets[0]]);
      expect(tailnet.devices).toHaveLength(1);
      // The box that was not the machine redeemed nothing.
      expect(other.devices).toEqual([]);
    });

    it('uses a fresh nonce at each address', async () => {
      const { net, account } = world();
      net.at(LAN, fakeTarget(account, { address: '192.168.1.20:3333', machineId: OTHER_MACHINE_ID }).box);
      await connectThroughAccount(deps(net), local, MACHINE_ID);
      const sent = enrollCalls(net).map((c) => (c.body as { nonce: string }).nonce);
      expect(sent).toHaveLength(2);
      expect(sent[0]).not.toBe(sent[1]);
    });
  });

  describe('once the probe succeeded, anything else stops the plan: the ticket is never sent again', () => {
    it.each<[string, FakeAnswer, RegExp]>([
      ['INVALID_TICKET', { status: 401, body: { error: 'x', code: 'INVALID_TICKET' } }, /Mac mini refused the sign-in/],
      ['CLIENT_REVOKED', { status: 401, body: { error: 'x', code: 'CLIENT_REVOKED' } }, /Mac mini removed this computer/],
      // Device pairing off there, or "Show this computer to my account" off: the one code covers both.
      ['ACCOUNT_ENROLL_OFF', { status: 403, body: { error: 'x', code: 'ACCOUNT_ENROLL_OFF' } },
        /^Mac mini isn’t accepting connections through your account\. On that computer, turn on device pairing and “Show this computer to my account”\.$/],
      ['REMOTE_PASSWORD_REQUIRED', { status: 403, body: { error: 'x', code: 'REMOTE_PASSWORD_REQUIRED' } }, /no dashboard password/],
      ['BUSY', { status: 429, body: { error: 'x', code: 'BUSY' } }, /too many computers waiting/],
      ['ENROLL_BUSY', { status: 429, body: { error: 'x', code: 'ENROLL_BUSY', retryAfter: 5 } }, /busy connecting another device/],
      ['a rate limit', { status: 429, body: { error: 'Too many attempts' } }, /too many attempts/i],
      ['CLOUD_UNAVAILABLE', { status: 502, body: { error: 'x', code: 'CLOUD_UNAVAILABLE' } }, /couldn’t reach AASC Cloud/],
      ['an AASC from before plan 18 (404)', { status: 404, body: { error: 'Not found' } }, /Update AASC on Mac mini/],
      ['a body it calls invalid (400)', { status: 400, body: { error: 'Invalid enroll request' } }, /Update AASC on Mac mini/],
      ['a redirect', { status: 302, body: { error: 'Moved' } }, /redirect/],
      ['anything else', { status: 500, body: { error: 'boom' } }, /Connecting to Mac mini failed \(500\)/],
      ['a 201 with nothing sealed', { status: 201, body: { success: true, data: {} } }, /Something else answered at Mac mini’s address/],
      // The ticket may be spent: the machine can have redeemed it and still be answering.
      ['an enroll that gets no answer in time', 'hang', /^Couldn’t finish connecting to Mac mini\. Try again\.$/],
      ['an enroll answered by something that isn’t AASC', { status: 502, body: '<html>Bad gateway</html>' }, /^Couldn’t finish connecting to Mac mini\. Try again\.$/],
    ])('%s', async (_name, answer, message) => {
      const { net, tailnet } = world();
      net.at(LAN, aascBox(answer));
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(message);
      expect(enrollCalls(net)).toHaveLength(1);
      expect(tailnet.enrollCalls).toBe(0);
      // Tailscale was not even probed: the plan stopped at the address that took the ticket.
      expect(probeCalls(net).map((c) => new URL(c.url).origin)).toEqual([LAN]);
    });

    it('says the same sentence whether the enroll timed out or was cut short, and never the ticket', async () => {
      const { net, account } = world();
      net.at(LAN, aascBox('hang'));
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toEqual({ ok: false, error: COULD_NOT_FINISH });
      expect(JSON.stringify(out)).not.toContain(account.secrets[0]);
    });
  });

  describe('what answered must be the machine, at the address dialled', () => {
    it('refuses a box that passes the request on: the answer is sealed for the machine’s own address', async () => {
      const { net, account, tailnet } = world();
      net.at(LAN, relayTo(net, TS)); // a box on the home network, relaying to the real machine
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
      // The machine did redeem (through the relay), so the ticket is spent and nothing is tried again with it.
      expect(tailnet.devices).toHaveLength(1);
      expect(enrollCalls(net).filter((c) => new URL(c.url).origin === LAN)).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain(tailnet.tokens[0]);
      expect(JSON.stringify(out)).not.toContain(account.secrets[0]);
    });

    it('refuses a box that seals a token of its own without the ticket’s seal secret', async () => {
      const { net, tailnet } = world();
      net.at(LAN, aascBox((req) => {
        const body = req.body as { clientKey: string; nonce: string };
        const data = sealAsMachine({
          clientKey: body.clientKey, sealSecret: Buffer.alloc(32, 7).toString('base64url'), nonce: body.nonce, boundAddress: '192.168.1.20:3333',
          plaintext: { deviceId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', deviceToken: 'an-impostor-token-0123456789', status: 'active', confirmCode: null },
        });
        return { status: 201, body: { success: true, data } };
      }));
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
      expect(tailnet.enrollCalls).toBe(0);
    });

    it('refuses a box that seals with no secret at all, from what it saw of the request', async () => {
      const { net } = world();
      net.at(LAN, aascBox((req) => {
        const body = req.body as { clientKey: string; nonce: string };
        const data = sealAsMachine({
          clientKey: body.clientKey, sealSecret: '', nonce: body.nonce, boundAddress: '192.168.1.20:3333',
          plaintext: { deviceId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8', deviceToken: 'an-impostor-token-0123456789', status: 'active', confirmCode: null },
        });
        return { status: 201, body: { success: true, data } };
      }));
      expect(await connectThroughAccount(deps(net), local, MACHINE_ID)).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    });

    it('opens an answer from a machine reached through a port forward only at the address dialled', async () => {
      // The machine sees a private socket address; without the contract's Host rule its seal names that one.
      const { net, account } = world({ machines: [machine({ paths: { lan: null, tailnet: null, public: '45.63.31.79', port: 3333, updatedAt: 'x' } })] });
      net.at(PUB, fakeTarget(account, { address: '192.168.1.20:3333', machineId: MACHINE_ID }).box);
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    });
  });

  // Contract B, updated Nov 20: a machine binds its answer to the request's Host when that names the public pair it
  // publishes (a forwarded port) or its Tailscale pair while its socket is loopback (Tailscale in userspace). So the
  // Host this computer sends must be exactly the address it dialled and opens with.
  describe('the Host a machine sees', () => {
    const PUBLISHED = ['100.101.102.103:3333', '45.63.31.79:3333'];
    const everywhere = [machine({ paths: { lan: '192.168.1.20', tailnet: '100.101.102.103', public: '45.63.31.79', port: 3333, updatedAt: 'x' } })];

    it('is never set by this client: fetch names the address dialled, which is the one the answer is opened with', async () => {
      const { net, account } = world({ machines: everywhere });
      net.at(LAN, null);
      net.at(TS, null);
      const target = fakeTarget(account, { address: '192.168.1.20:3333', machineId: MACHINE_ID, enroll: 'auto', publishes: PUBLISHED });
      net.at(PUB, target.box);
      const out = await connectThroughAccount(deps(net), { port: 3333, sessionToken: 'f'.repeat(64) }, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'public', origin: PUB });
      if (out.ok) await signIn(deps(net), out.target, { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken }, 'required');
      expect(net.calls.length).toBeGreaterThan(6);
      for (const call of net.calls) {
        expect(Object.keys(call.headers).map((name) => name.toLowerCase()), call.url).not.toContain('host');
        // What fetch then sends as Host is the URL's authority: exactly the host:port this client verifies with.
        expect(new URL(call.url).host, call.url).toBe(dialledAddress(new URL(call.url).origin));
      }
    });

    it.each<[string, string, string, string]>([
      ['a forwarded port (the socket is the private address)', PUB, '192.168.1.20:3333', 'public'],
      ['Tailscale in userspace (the socket is loopback)', TS, '127.0.0.1:3333', 'tailnet'],
    ])('lets it connect and sign in through %s when the machine publishes the address dialled', async (_name, origin, socket, via) => {
      const { net, account } = world({ machines: everywhere });
      net.at(LAN, null);
      net.at(TS, null);
      const target = fakeTarget(account, { address: socket, machineId: MACHINE_ID, enroll: 'auto', publishes: PUBLISHED });
      net.at(origin, target.box);
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via, origin });
      if (out.ok === false) return;
      const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken };
      expect(await signIn(deps(net), out.target, creds, 'required')).toMatchObject({ state: 'ok', origin, via });
    });

    it('still refuses a box at an address the machine does not publish, whatever Host reaches the machine', async () => {
      // The directory lists a stale home-network address, where a box now passes requests on to the machine.
      const stale = [machine({ paths: { lan: '192.168.1.99', tailnet: '100.101.102.103', public: null, port: 3333, updatedAt: 'x' } })];
      const { net, account } = world({ machines: stale });
      const target = fakeTarget(account, { address: '100.101.102.103:3333', machineId: MACHINE_ID, publishes: PUBLISHED });
      net.at(TS, target.box);
      net.at('http://192.168.1.99:3333', relayTo(net, TS));
      expect(await connectThroughAccount(deps(net), local, MACHINE_ID)).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    });

    it('opens with the port written out on port 80, where fetch leaves it out of the Host', () => {
      // The machine's rule has to read a bare published address on port 80 as that pair (server boundAddress.ts).
      expect(new URL('http://45.63.31.79:80').host).toBe('45.63.31.79');
      expect(dialledAddress('http://45.63.31.79:80')).toBe('45.63.31.79:80');
    });
  });

  describe('this computer’s dashboard session', () => {
    const SESSION = 'f'.repeat(64);
    const withSession: LocalServer = { port: 3333, sessionToken: SESSION };

    /** Every request that carries the session anywhere: a header, the body or the URL. */
    const carrying = (net: FakeNetwork) => net.calls.filter((c) => JSON.stringify([c.url, c.headers, c.body ?? null]).includes(SESSION));

    it('goes to this computer’s own server and to no machine, whichever address answers', async () => {
      const { net, account } = world({ target: { enroll: 'auto' } });
      // Another AASC at the home-network address: the ticket then goes to a second address too.
      net.at(LAN, fakeTarget(account, { address: '192.168.1.20:3333', machineId: OTHER_MACHINE_ID }).box);
      const out = await connectThroughAccount(deps(net), withSession, MACHINE_ID);
      expect(out).toMatchObject({ ok: true, via: 'tailnet' });
      expect(enrollCalls(net)).toHaveLength(2);
      expect(probeCalls(net)).toHaveLength(2);
      expect(carrying(net).map((c) => new URL(c.url).origin)).toEqual([LOCAL_ORIGIN, LOCAL_ORIGIN]);
      for (const call of net.calls.filter((c) => new URL(c.url).origin !== LOCAL_ORIGIN)) {
        expect(Object.keys(call.headers).sort(), call.url).toEqual(call.method === 'GET' ? ['Accept'] : ['Accept', 'Content-Type']);
      }
    });

    it('goes to no box that answers in the machine’s place, and into no refusal', async () => {
      for (const atLan of [
        (net: FakeNetwork): Box => relayTo(net, TS),
        (): Box => aascBox({ status: 401, body: { code: 'INVALID_TICKET' } }),
        (): Box => aascBox({ status: 302, body: { error: 'Moved' } }),
        (): Box => () => ({ status: 200, body: '<html>router</html>' }),
      ]) {
        const { net } = world();
        net.at(LAN, atLan(net));
        const out = await connectThroughAccount(deps(net), withSession, MACHINE_ID);
        expect(JSON.stringify(out)).not.toContain(SESSION);
        expect(carrying(net).every((c) => new URL(c.url).origin === LOCAL_ORIGIN)).toBe(true);
        expect(carrying(net)).toHaveLength(2);
      }
    });

    it('is asked of loopback only: the server’s address is never anything but 127.0.0.1 and the port', async () => {
      const { net } = world();
      await readAccountDirectory(deps(net), withSession);
      await connectThroughAccount(deps(net), withSession, MACHINE_ID);
      for (const call of carrying(net)) expect(new URL(call.url).hostname).toBe('127.0.0.1');
      // A port that could name another host is refused before anything is sent.
      for (const port of ['3333@evil.example', '3333/..', 3333.5] as unknown as number[]) {
        const quiet = world();
        expect(await readAccountDirectory(deps(quiet.net), { port, sessionToken: SESSION })).toEqual({ state: 'unreachable' });
        expect(quiet.net.calls).toEqual([]);
      }
    });
  });

  describe('before anything is sent to a machine', () => {
    it.each<[string, DirectoryMachine[], RegExp]>([
      ['a computer the account doesn’t list', [machine({ deviceId: OTHER_MACHINE_ID })], /no longer on your AASC Cloud account/],
      ['this computer itself', [machine({ current: true })], /this computer/i],
      ['a computer that can’t redeem a ticket', [machine({ connectable: false })], /Sign in to AASC Cloud again on Mac mini/],
      ['a computer that shows no address', [machine({ paths: null })], /Mac mini shows no address/],
      ['a computer whose addresses are all of the wrong kind', [machine({ paths: { lan: '8.8.8.8', tailnet: null, public: '10.0.0.1', port: 3333, updatedAt: 'x' } })], /Mac mini shows no address/],
    ])('refuses %s, and asks for no ticket', async (_name, machines, message) => {
      const { net } = world({ machines });
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(message);
      expect(ticketCalls(net)).toEqual([]);
      expect(enrollCalls(net)).toEqual([]);
    });

    it.each<[string, FakeAnswer, RegExp]>([
      ['signed out', { status: 409, body: { success: false, error: { code: 'not_connected', message: 'x' } } }, /Sign in to AASC Cloud on this computer first/],
      ['signed in before this release', { status: 403, body: { success: false, error: { code: 'needs_sign_in', message: 'x' } } }, /Sign in to AASC Cloud again on this computer/],
      ['the cloud out of reach', 'network-error', /Can’t reach AASC Cloud/],
      ['on a backend with no machines service', { status: 404, body: { success: false, error: { code: 'unsupported', message: 'x' } } }, /AASC Cloud can’t list your account’s computers yet/],
    ])('says so when this computer is %s', async (_name, answer, message) => {
      const { net } = world({ local: { machines: answer } });
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(message);
      expect(net.calls).toHaveLength(1);
    });

    it.each<[string, FakeAnswer, RegExp]>([
      ['machine_not_found', { status: 404, body: { success: false, error: { code: 'machine_not_found', message: 'x' } } }, /no longer on your AASC Cloud account/],
      ['rate_limited', { status: 429, body: { success: false, error: { code: 'rate_limited', message: 'x' } } }, /Too many tries/],
      ['needs_sign_in', { status: 403, body: { success: false, error: { code: 'needs_sign_in', message: 'x' } } }, /Sign in to AASC Cloud again on this computer/],
      ['no connection', { status: 409, body: { success: false, error: { code: 'not_connected', message: 'x' } } }, /Sign in to AASC Cloud on this computer first/],
      ['a backend with no such service', { status: 404, body: { success: false, error: { code: 'unsupported', message: 'x' } } }, /AASC Cloud didn’t answer/],
      ['a ticket of the wrong shape', { status: 200, body: { success: true, data: { ticket: 'short', sealSecret: 'short' } } }, /AASC Cloud didn’t answer/],
      ['no answer', 'network-error', /AASC Cloud didn’t answer/],
    ])('sends no machine the enroll when the ticket is refused (%s)', async (_name, answer, message) => {
      const { net } = world({ local: { ticket: answer } });
      const out = await connectThroughAccount(deps(net), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      if (out.ok === false) expect(out.error).toMatch(message);
      expect(enrollCalls(net)).toEqual([]);
    });

    it('sends nothing when the random source gives no nonce', async () => {
      const { net } = world();
      const out = await connectThroughAccount(deps(net, { randomHex: () => 'not hex' }), local, MACHINE_ID);
      expect(out.ok).toBe(false);
      expect(enrollCalls(net)).toEqual([]);
    });

    it.each(['', 'not-a-uuid', MACHINE_ID.toUpperCase(), `${MACHINE_ID}/../x`])('asks nothing at all for a machine id that is none (%s)', async (id) => {
      const { net } = world();
      const out = await connectThroughAccount(deps(net), local, id);
      expect(out.ok).toBe(false);
      expect(net.calls).toEqual([]);
    });
  });

  it('never follows a redirect, and never puts a ticket, secret or key in a refusal', async () => {
    const seen: string[] = [];
    for (const refuse of [{ status: 401, body: { code: 'INVALID_TICKET' } }, { status: 500, body: { error: 'x' } }] as FakeAnswer[]) {
      const w = world();
      w.net.at(LAN, aascBox(refuse));
      const watching = deps(w.net, { fetch: (url, init) => { seen.push(init.redirect); return w.net.fetch(url, init); } });
      const out = await connectThroughAccount(watching, local, MACHINE_ID);
      expect(out.ok).toBe(false);
      const text = JSON.stringify(out);
      for (const secret of w.account.secrets) expect(text).not.toContain(secret);
      for (const call of ticketCalls(w.net)) expect(text).not.toContain((call.body as { clientKey: string }).clientKey);
    }
    // The directory, the probe, the ticket and the enroll, twice: every one of them with redirect 'manual'.
    expect(seen).toEqual(Array(8).fill('manual'));
  });
});
