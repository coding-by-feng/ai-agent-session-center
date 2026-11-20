// test/machineDirectoryPublisher.test.ts — plan 18, stage 2 (CONTRACT.md section D): this computer tells its
// AASC Cloud account where it can be tried.
//
// While signed in with a usable connection, shown to its account and reachable at all (a dashboard password, and
// pairing offered), it publishes the ticked addresses: home network, Tailscale, and the public one only when
// "Public IP" is ticked. It asks only when something changed, withdraws when it stops (the setting off, nothing
// left to publish, signing out), and never asks anything with no connection. Fake client throughout: no network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudError, type CloudClient, type CloudConnector, type CloudStatus } from '../server/cloud/types.js';
import type { CloudConnection } from '../src/types/cloud.js';
import {
  createMachineDirectoryPublisher, DIRECTORY_CHECK_MS, withMachineDirectory,
  type MachineDirectoryDeps, type MachineDirectoryPublisher,
} from '../server/mobile/machineDirectoryPublisher.js';
import type { MachineAccountSettings } from '../server/mobile/machineAccountSettings.js';

const LAN = '192.168.1.57';
const TAILNET = '100.101.102.103';
const PUBLIC = '45.63.31.79';
const PORT = 3333;
const AT = '2026-11-20T01:02:03.000Z';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

const connection = (over: Partial<CloudConnection> = {}): CloudConnection => ({
  backendOrigin: 'https://backend.example', accountId: ACCOUNT, deviceId: '00000000-0000-4000-8000-0000000000d1',
  deviceName: 'Mac mini', generation: 1, ...over,
});
const signedIn = (state: CloudStatus['state'] = 'connected', over: Partial<CloudConnection> = {}): CloudStatus =>
  ({ connection: connection(over), state, lastError: null });
const signedOut: CloudStatus = { connection: null, state: 'disconnected', lastError: null };

const forbidden = () => new CloudError('forbidden', 'This device does not have permission for this cloud action.', 403);
const notFound = () => new CloudError('not_found', 'Cloud item was not found.', 404);
const offline = () => new CloudError('offline', 'Cloud is offline. Check the connection and try again.');

const publishers: MachineDirectoryPublisher[] = [];
afterEach(() => {
  for (const publisher of publishers.splice(0)) publisher.stop();
  vi.useRealTimers();
});

interface Call { method: string; path: string; body: unknown }

function setUp(over: {
  status?: CloudStatus;
  settings?: Partial<MachineAccountSettings> & { addresses?: Partial<MachineAccountSettings['addresses']> };
  /** Why no computer could connect here, when none could. */
  blocked?: 'pairing-off' | 'no-password' | null;
  target?: { lan: string | null; tailnet: string | null; publicAddress?: string | null; port: number };
  remembered?: string | null;
  reply?: (call: Call, nth: number) => unknown;
} = {}) {
  /** While set, reading this computer's addresses (the check's local part) waits on it. */
  const local: { hold: Promise<void> | null } = { hold: null };
  const state = {
    status: over.status ?? signedIn(),
    settings: {
      showOnAccount: true, computerEnroll: 'ask', ...over.settings,
      addresses: { lan: true, tailnet: true, public: false, ...over.settings?.addresses },
    } as MachineAccountSettings,
    blocked: over.blocked ?? null,
    target: over.target ?? { lan: LAN, tailnet: TAILNET, publicAddress: PUBLIC, port: PORT },
    remembered: over.remembered ?? null,
    reply: over.reply ?? ((call: Call) => (call.method === 'PUT' ? { updatedAt: AT } : { withdrawn: true })),
  };
  const calls: Call[] = [];
  const targetCalls = { n: 0 };
  const warn = vi.fn();
  const client: CloudClient = {
    request: (async (method: string, path: string, body?: unknown) => {
      const call = { method, path, body };
      calls.push(call);
      return state.reply(call, calls.length);
    }) as CloudClient['request'],
  };
  const deps: MachineDirectoryDeps = {
    cloud: { client, status: () => state.status },
    settings: () => state.settings,
    unreachable: () => state.blocked,
    target: async () => { targetCalls.n += 1; if (local.hold) await local.hold; return state.target; },
    remembered: { get: () => state.remembered, set: (account) => { state.remembered = account; } },
    now: () => 5_000,
    log: { warn, debug: vi.fn() },
  };
  const publisher = createMachineDirectoryPublisher(deps);
  publishers.push(publisher);
  return { publisher, state, calls, targetCalls, warn, local };
}

/** Something a test holds shut until it opens it. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const PUT = (body: Record<string, unknown>): Call => ({ method: 'PUT', path: '/v1/machines/self', body });
const DELETE: Call = { method: 'DELETE', path: '/v1/machines/self', body: undefined };

describe('what it publishes', () => {
  it('publishes the home-network and Tailscale addresses by default, never the public one', async () => {
    const f = setUp();
    expect(await f.publisher.check()).toEqual({ state: 'published', lan: LAN, tailnet: TAILNET, public: null, port: PORT, at: 5_000 });
    expect(f.calls).toEqual([PUT({ lan: LAN, tailnet: TAILNET, port: PORT })]);
  });

  it('adds the public address only when Public IP is ticked and one is known', async () => {
    const f = setUp({ settings: { addresses: { public: true } } });
    await f.publisher.check();
    expect(f.calls).toEqual([PUT({ lan: LAN, tailnet: TAILNET, public: PUBLIC, port: PORT })]);
    const g = setUp({ settings: { addresses: { public: true } }, target: { lan: LAN, tailnet: null, port: PORT } });
    await g.publisher.check();
    expect(g.calls).toEqual([PUT({ lan: LAN, port: PORT })]);
  });

  it('leaves out an address that is unticked', async () => {
    const f = setUp({ settings: { addresses: { lan: false } } });
    await f.publisher.check();
    expect(f.calls).toEqual([PUT({ tailnet: TAILNET, port: PORT })]);
  });

  it('never sends an address of the wrong kind, whatever a source says', async () => {
    const f = setUp({
      settings: { addresses: { public: true } },
      target: { lan: PUBLIC, tailnet: '10.8.0.2', publicAddress: LAN, port: PORT },
    });
    expect((await f.publisher.check()).state).toBe('no-address');
    expect(f.calls).toEqual([]);
  });

  it('says published without asking again while nothing changed', async () => {
    const f = setUp();
    await f.publisher.check();
    await f.publisher.check();
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ['the home-network address changes', (s: ReturnType<typeof setUp>['state']) => { s.target = { ...s.target, lan: '192.168.1.99' }; }, { lan: '192.168.1.99', tailnet: TAILNET, port: PORT }],
    ['Tailscale goes away', (s: ReturnType<typeof setUp>['state']) => { s.target = { ...s.target, tailnet: null }; }, { lan: LAN, port: PORT }],
    ['Public IP is ticked', (s: ReturnType<typeof setUp>['state']) => { s.settings = { ...s.settings, addresses: { ...s.settings.addresses, public: true } }; }, { lan: LAN, tailnet: TAILNET, public: PUBLIC, port: PORT }],
    ['the port changes', (s: ReturnType<typeof setUp>['state']) => { s.target = { ...s.target, port: 4444 }; }, { lan: LAN, tailnet: TAILNET, port: 4444 }],
  ])('publishes again, whole, when %s', async (_label, change, body) => {
    const f = setUp();
    await f.publisher.check();
    change(f.state);
    await f.publisher.check();
    expect(f.calls).toEqual([PUT({ lan: LAN, tailnet: TAILNET, port: PORT }), PUT(body)]);
  });

  it('publishes to a new account after signing in to another', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.status = signedIn('connected', { accountId: '00000000-0000-4000-8000-0000000000a2', generation: 2 });
    await f.publisher.check();
    expect(f.calls).toHaveLength(2);
  });

  it('tries a saved connection that nothing has checked yet (offline after a restart)', async () => {
    const f = setUp({ status: signedIn('offline') });
    expect((await f.publisher.check()).state).toBe('published');
  });
});

describe('when it asks nothing', () => {
  it('makes no request, and reads no address, with no connection', async () => {
    const f = setUp({ status: signedOut });
    expect(await f.publisher.check()).toEqual({ state: 'no-cloud', lan: null, tailnet: null, public: null, port: null, at: null });
    expect(f.calls).toEqual([]);
    expect(f.targetCalls.n).toBe(0);
  });

  it('makes no request with a revoked connection', async () => {
    const f = setUp({ status: signedIn('revoked'), remembered: 'anything' });
    expect((await f.publisher.check()).state).toBe('no-cloud');
    expect(f.calls).toEqual([]);
  });

  it.each([
    ['the setting is off', { settings: { showOnAccount: false } }, 'off'],
    ['pairing is off, so no computer could connect here', { blocked: 'pairing-off' }, 'pairing-off'],
    ['no dashboard password is set, so no computer could connect here', { blocked: 'no-password' }, 'no-password'],
    ['it has no address to give', { target: { lan: null, tailnet: null, port: PORT } }, 'no-address'],
    ['every address is unticked', { settings: { addresses: { lan: false, tailnet: false } } }, 'no-address'],
  ] as const)('makes no request when %s and it never published', async (_label, over, state) => {
    const f = setUp(over as Parameters<typeof setUp>[0]);
    expect((await f.publisher.check()).state).toBe(state);
    expect(f.calls).toEqual([]);
  });

  it('does not ask Tailscale for an address while the setting is off', async () => {
    const f = setUp({ settings: { showOnAccount: false } });
    await f.publisher.check();
    expect(f.targetCalls.n).toBe(0);
  });
});

describe('withdrawing', () => {
  it('withdraws once when the setting is turned off after publishing', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.settings = { ...f.state.settings, showOnAccount: false };
    expect(await f.publisher.check()).toEqual({ state: 'off', lan: null, tailnet: null, public: null, port: null, at: null });
    await f.publisher.check();
    expect(f.calls).toEqual([PUT({ lan: LAN, tailnet: TAILNET, port: PORT }), DELETE]);
    expect(f.state.remembered).toBeNull();
  });

  it('withdraws when nothing is left to publish (the backend takes no empty list)', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.target = { lan: null, tailnet: null, port: PORT };
    expect((await f.publisher.check()).state).toBe('no-address');
    expect(f.calls.at(-1)).toEqual(DELETE);
  });

  it('withdraws when no computer could connect here any more', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.blocked = 'no-password';
    expect((await f.publisher.check()).state).toBe('no-password');
    expect(f.calls.at(-1)).toEqual(DELETE);
  });

  it('withdraws at the first check after a restart when it published before and the setting is now off', async () => {
    const first = setUp();
    await first.publisher.check();
    const remembered = first.state.remembered;
    expect(remembered).toBeTruthy();
    // A new process: nothing in memory, the setting turned off meanwhile (a config edit, or AASC_SHOW_ON_ACCOUNT=0).
    const f = setUp({ settings: { showOnAccount: false }, remembered });
    expect((await f.publisher.check()).state).toBe('off');
    expect(f.calls).toEqual([DELETE]);
    await f.publisher.check();
    expect(f.calls).toHaveLength(1);
  });

  it('does not withdraw for an account it never published to', async () => {
    const f = setUp({ settings: { showOnAccount: false }, remembered: 'another-account' });
    await f.publisher.check();
    expect(f.calls).toEqual([]);
  });

  it('publishes again after the setting comes back on', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.settings = { ...f.state.settings, showOnAccount: false };
    await f.publisher.check();
    f.state.settings = { ...f.state.settings, showOnAccount: true };
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.calls.map((c) => c.method)).toEqual(['PUT', 'DELETE', 'PUT']);
  });

  it('tries again at the next check when a withdraw fails', async () => {
    let fail = true;
    const f = setUp({ reply: (call) => {
      if (call.method === 'DELETE' && fail) throw offline();
      return call.method === 'PUT' ? { updatedAt: AT } : { withdrawn: true };
    } });
    await f.publisher.check();
    f.state.settings = { ...f.state.settings, showOnAccount: false };
    expect((await f.publisher.check()).state).toBe('failed');
    fail = false;
    expect((await f.publisher.check()).state).toBe('off');
    expect(f.calls.map((c) => c.method)).toEqual(['PUT', 'DELETE', 'DELETE']);
  });

  it('withdraw() before a sign-out sends one DELETE, and nothing when it never published', async () => {
    const f = setUp();
    await f.publisher.check();
    await f.publisher.withdraw();
    expect(f.calls.at(-1)).toEqual(DELETE);
    expect(f.state.remembered).toBeNull();
    const g = setUp();
    await g.publisher.withdraw();
    expect(g.calls).toEqual([]);
  });

  it('withdraw() never rejects, whatever the cloud does', async () => {
    const f = setUp({ reply: (call) => { if (call.method === 'DELETE') throw offline(); return { updatedAt: AT }; } });
    await f.publisher.check();
    await expect(f.publisher.withdraw()).resolves.toBeUndefined();
  });
});

describe('refusals and failures', () => {
  it('remembers a 403 as needs-sign-in and does not ask that account again on a timer check', async () => {
    const f = setUp({ reply: () => { throw forbidden(); } });
    expect((await f.publisher.check()).state).toBe('needs-sign-in');
    expect((await f.publisher.check()).state).toBe('needs-sign-in');
    expect(f.calls).toHaveLength(1);
    expect(f.warn).toHaveBeenCalledTimes(1);
  });

  it('remembers a backend without the service as unsupported', async () => {
    const f = setUp({ reply: () => { throw notFound(); } });
    expect((await f.publisher.check()).state).toBe('unsupported');
    await f.publisher.check();
    expect(f.calls).toHaveLength(1);
  });

  it('asks a refusing account again when told to (a changed setting, a new sign-in)', async () => {
    let refuse = true;
    const f = setUp({ reply: () => { if (refuse) throw forbidden(); return { updatedAt: AT }; } });
    await f.publisher.check();
    refuse = false;
    expect((await f.publisher.check({ retryRefused: true })).state).toBe('published');
    expect(f.calls).toHaveLength(2);
  });

  it('asks again for another account after a refusal', async () => {
    let refuse = true;
    const f = setUp({ reply: () => { if (refuse) throw forbidden(); return { updatedAt: AT }; } });
    await f.publisher.check();
    refuse = false;
    f.state.status = signedIn('connected', { accountId: '00000000-0000-4000-8000-0000000000a2', generation: 2 });
    expect((await f.publisher.check()).state).toBe('published');
  });

  it('reads any other failure as failed, tries again at the next check, and warns once per kind', async () => {
    let fail = true;
    const f = setUp({ reply: () => { if (fail) throw offline(); return { updatedAt: AT }; } });
    expect((await f.publisher.check()).state).toBe('failed');
    expect((await f.publisher.check()).state).toBe('failed');
    expect(f.warn).toHaveBeenCalledTimes(1);
    fail = false;
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.calls).toHaveLength(3);
  });

  it('never rejects: a fault in an address source is a failed check', async () => {
    const f = setUp();
    f.state.target = null as never;
    await expect(f.publisher.check()).resolves.toMatchObject({ state: 'failed' });
  });

  it('never logs an address, an account or an id', async () => {
    const f = setUp({ reply: () => { throw offline(); } });
    await f.publisher.check();
    const g = setUp({ reply: () => { throw forbidden(); } });
    await g.publisher.check();
    const logged = [...f.warn.mock.calls, ...g.warn.mock.calls].map((c) => String(c[0])).join('\n');
    for (const secret of [LAN, TAILNET, PUBLIC, ACCOUNT, 'backend.example']) expect(logged).not.toContain(secret);
  });
});

describe('one check at a time', () => {
  it('a check asked for while one runs waits for it, then looks again, so the latest setting wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const f = setUp({ reply: async (call) => {
      if (call.method === 'PUT') await gate;
      return call.method === 'PUT' ? { updatedAt: AT } : { withdrawn: true };
    } });
    const first = f.publisher.check();
    await Promise.resolve();
    f.state.settings = { ...f.state.settings, showOnAccount: false };
    const second = f.publisher.check();
    const third = f.publisher.check();
    release();
    expect((await first).state).toBe('published');
    expect((await second).state).toBe('off');
    expect((await third).state).toBe('off');
    expect(f.calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
  });
});

describe('start and stop', () => {
  it('checks at once, then every minute, until stopped', async () => {
    vi.useFakeTimers();
    const f = setUp();
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    f.state.target = { ...f.state.target, lan: '192.168.1.99' };
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS);
    expect(f.calls).toHaveLength(2);
    f.publisher.stop();
    f.state.target = { ...f.state.target, lan: '192.168.1.100' };
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS * 3);
    expect(f.calls).toHaveLength(2);
  });

  it('a machine that was never signed in makes no request at start, or ever', async () => {
    vi.useFakeTimers();
    const f = setUp({ status: signedOut });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS * 5);
    expect(f.calls).toEqual([]);
    expect(f.targetCalls.n).toBe(0);
  });
});

describe('view', () => {
  it('is pending until a check has finished, then what the check found', async () => {
    const f = setUp();
    expect(f.publisher.view().state).toBe('pending');
    await f.publisher.check();
    expect(f.publisher.view()).toEqual({ state: 'published', lan: LAN, tailnet: TAILNET, public: null, port: PORT, at: 5_000 });
  });

  it('follows a sign-out at once', async () => {
    const f = setUp();
    await f.publisher.check();
    f.state.status = signedOut;
    expect(f.publisher.view().state).toBe('no-cloud');
  });
});

describe('the view while a check runs', () => {
  // The page reads view() between a save and the cloud's answer. It must never show what the account held BEFORE
  // the change as if it were the outcome: an address the owner has just unticked would read as still published.
  const PENDING = { state: 'pending', lan: null, tailnet: null, public: null, port: null, at: null };
  const answer = (call: Call) => (call.method === 'PUT' ? { updatedAt: AT } : { withdrawn: true });
  const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  /** Published with the public address; from now on the cloud answers only when `cloud.open()` is called. */
  async function publishedThenSlow(fail = false) {
    const slow = { on: false, cloud: gate() };
    const f = setUp({
      settings: { addresses: { public: true } },
      reply: async (call) => {
        if (slow.on) {
          await slow.cloud.wait;
          if (fail) throw offline();
        }
        return answer(call);
      },
    });
    await f.publisher.check();
    expect(f.publisher.view()).toMatchObject({ state: 'published', public: PUBLIC });
    slow.on = true;
    return { ...f, slow };
  }
  const untickPublic = (f: Awaited<ReturnType<typeof publishedThenSlow>>): void => {
    f.state.settings = { ...f.state.settings, addresses: { ...f.state.settings.addresses, public: false } };
  };

  it('after a save on a slow cloud: pending with no address from the moment it is asked until the cloud answers, then the new finding', async () => {
    const f = await publishedThenSlow();
    untickPublic(f);
    const saving = f.publisher.check({ retryRefused: true });
    expect(f.publisher.view()).toEqual(PENDING); // at once: not the public address the owner just unticked
    await turns();
    expect(f.calls).toHaveLength(2); // the PUT is out, unanswered
    expect(f.publisher.view()).toEqual(PENDING);
    f.slow.cloud.open();
    expect(await saving).toMatchObject({ state: 'published', public: null });
    expect(f.publisher.view()).toEqual({ state: 'published', lan: LAN, tailnet: TAILNET, public: null, port: PORT, at: 5_000 });
  });

  it('a slow check that fails: pending, then failed, never a pending that stays', async () => {
    const f = await publishedThenSlow(true);
    untickPublic(f);
    const saving = f.publisher.check({ retryRefused: true });
    await turns();
    expect(f.publisher.view()).toEqual(PENDING);
    f.slow.cloud.open();
    expect((await saving).state).toBe('failed');
    expect(f.publisher.view()).toEqual({ ...PENDING, state: 'failed' });
  });

  it('a fault in an address source during an ask leaves failed, not pending', async () => {
    const f = await publishedThenSlow();
    f.state.target = null as never;
    expect((await f.publisher.check({ retryRefused: true })).state).toBe('failed');
    expect(f.publisher.view().state).toBe('failed');
  });

  it('a timer check that finds nothing changed never reads pending: the settled finding stands while it looks and after', async () => {
    vi.useFakeTimers();
    const f = setUp();
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    const settled = f.publisher.view();
    expect(settled.state).toBe('published');
    const looking = gate();
    f.local.hold = looking.wait; // the tick is held in its local part (reading this computer's addresses)
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS);
    expect(f.targetCalls.n).toBe(2);
    expect(f.publisher.view()).toEqual(settled);
    looking.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view()).toEqual(settled);
    expect(f.calls).toHaveLength(1); // it sent nothing
  });

  it('a timer check that finds a change reads pending while it tells the cloud, then the new finding', async () => {
    vi.useFakeTimers();
    const slow = { on: false, cloud: gate() };
    const f = setUp({ reply: async (call) => { if (slow.on) await slow.cloud.wait; return answer(call); } });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    slow.on = true;
    f.state.target = { ...f.state.target, lan: '192.168.1.99' };
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS);
    expect(f.calls).toHaveLength(2);
    expect(f.publisher.view()).toEqual(PENDING);
    slow.cloud.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view()).toMatchObject({ state: 'published', lan: '192.168.1.99' });
  });

  it('an ask that arrives while a timer check is looking reads pending at once, through that check and its own', async () => {
    vi.useFakeTimers();
    const slow = { on: false, cloud: gate() };
    const f = setUp({ reply: async (call) => { if (slow.on) await slow.cloud.wait; return answer(call); } });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    const looking = gate();
    f.local.hold = looking.wait;
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS); // a quiet tick, held in its local part
    expect(f.publisher.view().state).toBe('published');

    slow.on = true;
    f.state.settings = { ...f.state.settings, addresses: { ...f.state.settings.addresses, public: true } };
    const saving = f.publisher.check({ retryRefused: true });
    expect(f.publisher.view()).toEqual(PENDING);
    f.local.hold = null;
    looking.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view()).toEqual(PENDING); // the cloud has not answered
    slow.cloud.open();
    expect(await saving).toMatchObject({ state: 'published', public: PUBLIC });
    expect(f.publisher.view()).toMatchObject({ state: 'published', public: PUBLIC });
  });

  it('a second timer tick while a check still runs starts no third: it shares the one in flight', async () => {
    vi.useFakeTimers();
    const f = setUp();
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    const looking = gate();
    f.local.hold = looking.wait;
    await vi.advanceTimersByTimeAsync(DIRECTORY_CHECK_MS * 3); // three ticks while the first is still looking
    expect(f.targetCalls.n).toBe(2);
    f.local.hold = null;
    looking.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targetCalls.n).toBe(2);
    expect(f.publisher.view().state).toBe('published');
  });

  it('reads no-cloud, not pending, once the computer is signed out, whatever is still running', async () => {
    const f = await publishedThenSlow();
    untickPublic(f);
    void f.publisher.check({ retryRefused: true });
    await turns();
    f.state.status = signedOut;
    expect(f.publisher.view().state).toBe('no-cloud');
    f.slow.cloud.open();
  });
});

describe('withMachineDirectory', () => {
  function connector(status: CloudStatus = signedIn()) {
    const order: string[] = [];
    const base = {
      client: { request: vi.fn() },
      status: () => status,
      connectCloud: vi.fn(async () => { order.push('connect'); return connection(); }),
      recheckCloud: vi.fn(),
      disconnectCloud: vi.fn(async () => { order.push('disconnect'); }),
      revokeDevice: vi.fn(),
      stop: vi.fn(),
      onStop: vi.fn(),
    } as unknown as CloudConnector;
    const publisher = {
      check: vi.fn(async () => { order.push('check'); return {} as never; }),
      withdraw: vi.fn(async () => { order.push('withdraw'); }),
    };
    return { base, publisher, order, wrapped: withMachineDirectory(base, publisher) };
  }

  it('withdraws before a sign-out, while the connection can still say so', async () => {
    const f = connector();
    await f.wrapped.disconnectCloud();
    expect(f.order).toEqual(['withdraw', 'disconnect']);
  });

  it('signs out even when the withdraw fails', async () => {
    const f = connector();
    f.publisher.withdraw.mockRejectedValueOnce(new Error('boom'));
    await f.wrapped.disconnectCloud();
    expect(f.order).toEqual(['disconnect']);
  });

  const SIGN_IN = { backendUrl: 'https://backend.example', pairingCode: 'c'.repeat(22), deviceName: 'Mac' };

  it('a first sign-in: nothing to withdraw; it publishes right after, without holding the sign-in up, and asks a refusing account again', async () => {
    const f = connector(signedOut);
    await expect(f.wrapped.connectCloud(SIGN_IN)).resolves.toEqual(connection());
    expect(f.order).toEqual(['connect', 'check']);
    expect(f.publisher.withdraw).not.toHaveBeenCalled();
    expect(f.publisher.check).toHaveBeenCalledWith({ retryRefused: true });
  });

  it.each([
    ['connected', signedIn()],
    ['saved and not yet checked (offline after a restart)', signedIn('offline')],
  ])('signing in again while %s: the device it is about to stop being leaves the directory first, then the new one publishes', async (_label, status) => {
    const f = connector(status);
    await f.wrapped.connectCloud(SIGN_IN);
    expect(f.order).toEqual(['withdraw', 'connect', 'check']);
  });

  it('signing in from a revoked connection: nothing can be withdrawn with a dead token, so nothing is asked', async () => {
    const f = connector(signedIn('revoked'));
    await f.wrapped.connectCloud(SIGN_IN);
    expect(f.order).toEqual(['connect', 'check']);
  });

  it('a first sign-in that fails publishes nothing', async () => {
    const f = connector(signedOut);
    (f.base.connectCloud as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new CloudError('pairing_invalid', 'no', 400));
    await expect(f.wrapped.connectCloud(SIGN_IN)).rejects.toBeInstanceOf(CloudError);
    expect(f.publisher.check).not.toHaveBeenCalled();
  });

  it('signing in again that fails after the withdraw: the old connection is still this computer\'s, so it publishes again', async () => {
    const f = connector();
    (f.base.connectCloud as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      f.order.push('connect');
      throw new CloudError('pairing_invalid', 'no', 400);
    });
    await expect(f.wrapped.connectCloud(SIGN_IN)).rejects.toMatchObject({ code: 'pairing_invalid' });
    expect(f.order).toEqual(['withdraw', 'connect', 'check']);
    expect(f.publisher.check).toHaveBeenCalledWith({ retryRefused: true });
  });

  it('signs in even when the withdraw before it fails', async () => {
    const f = connector();
    f.publisher.withdraw.mockRejectedValueOnce(new Error('boom'));
    await expect(f.wrapped.connectCloud(SIGN_IN)).resolves.toEqual(connection());
    expect(f.order).toEqual(['connect', 'check']);
  });

  it('passes everything else straight through', () => {
    const f = connector();
    expect(f.wrapped.client).toBe(f.base.client);
    expect(f.wrapped.status()).toEqual(signedIn());
    expect(f.wrapped.recheckCloud).toBe(f.base.recheckCloud);
    expect(f.wrapped.revokeDevice).toBe(f.base.revokeDevice);
  });
});
