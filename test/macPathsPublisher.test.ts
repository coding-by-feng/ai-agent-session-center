// test/macPathsPublisher.test.ts - AASC-60 Remote access, Task 7: the Mac shares its Tailscale address with its AASC Cloud account.
//
// When a phone could use this Mac, the publisher tells the account `{ tailnet, port }` so a phone away from home can look it up.
// It asks only when something changed, stops asking an account that refused it (403, or a backend without the service), and a
// cloud fault is a state to show, never an exception. Fake clients and fake timers throughout: no network, no Tailscale.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudError, type CloudClient, type CloudStatus } from '../server/cloud/types.js';
import type { CloudConnection } from '../src/types/cloud.js';
import {
  createMacPathsPublisher,
  PUBLISH_CHECK_MS,
  type MacPathsPublisher,
  type MacPathsPublisherDeps,
} from '../server/mobile/macPathsPublisher.js';
import { ORIGIN } from './macPathsFixture.js';

const TAILNET = '100.101.102.103';
const OTHER_TAILNET = '100.64.0.9';
const PORT = 3334;
const UPDATED_AT = '2026-10-22T01:23:45.000Z';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

const connection = (over: Partial<CloudConnection> = {}): CloudConnection => ({
  backendOrigin: ORIGIN,
  accountId: ACCOUNT,
  deviceId: '00000000-0000-4000-8000-0000000000d1',
  deviceName: 'Kason MBP',
  generation: 1,
  ...over,
});
const connected = (over: Partial<CloudConnection> = {}): CloudStatus => ({
  connection: connection(over),
  state: 'connected',
  lastError: null,
});
const disconnected: CloudStatus = { connection: null, state: 'disconnected', lastError: null };

const forbidden = () =>
  new CloudError('forbidden', 'This device does not have permission for this cloud action.', 403);
const notFound = () => new CloudError('not_found', 'Cloud item was not found.', 404);
const offline = () =>
  new CloudError('offline', 'Cloud is offline. Check the connection and try again.');
const ok = () => ({ updatedAt: UPDATED_AT });

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const publishers: MacPathsPublisher[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const publisher of publishers.splice(0)) publisher.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

interface Options {
  status?: CloudStatus;
  /** The address Tailscale reports; null when it has none. */
  address?: string | null;
  /** Could a phone use this Mac (a password and a phone paired or pairing offered). */
  phones?: boolean;
  /** The cloud's answer to the nth request; throw to fail it. */
  reply?: (nth: number) => unknown;
  deps?: Partial<MacPathsPublisherDeps>;
}

/** A publisher over a fake client that counts what it is asked. Everything it reads can be changed between checks. */
function setup(options: Options = {}) {
  const initial = options.status ?? connected();
  let readStatus: () => CloudStatus = () => initial;
  let address = options.address === undefined ? TAILNET : options.address;
  let phones = options.phones ?? true;
  let clock = 1_000;
  let reply = options.reply ?? ok;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    requests.push({ method, path, body });
    return reply(requests.length);
  });
  const tailnet = vi.fn(async () => address);
  const log = { warn: vi.fn(), debug: vi.fn() };
  const publisher = createMacPathsPublisher({
    cloud: { client: { request } as unknown as CloudClient, status: () => readStatus() },
    tailnet,
    port: PORT,
    phonesCouldUse: () => phones,
    now: () => clock,
    log,
    ...options.deps,
  });
  publishers.push(publisher);
  return {
    publisher,
    requests,
    request,
    tailnet,
    log,
    setStatus: (next: CloudStatus | (() => CloudStatus)) => {
      readStatus = typeof next === 'function' ? next : () => next;
    },
    setAddress: (next: string | null) => {
      address = next;
    },
    setPhones: (next: boolean) => {
      phones = next;
    },
    setClock: (next: number) => {
      clock = next;
    },
    setReply: (next: (nth: number) => unknown) => {
      reply = next;
    },
  };
}
const viewOf = (state: string, tailnet: string | null = null, at: number | null = null) => ({
  state,
  tailnet,
  port: PORT,
  at,
});

describe('check()', () => {
  it('publishes once when connected, then not again while nothing changed', async () => {
    const f = setup();
    expect(await f.publisher.check()).toEqual(viewOf('published', TAILNET, 1_000));
    expect(f.requests).toEqual([
      { method: 'PUT', path: '/v1/mac-paths/self', body: { tailnet: TAILNET, port: PORT } },
    ]);

    f.setClock(9_000);
    // Nothing changed: still published, still the time it was shared, and nothing sent.
    expect(await f.publisher.check()).toEqual(viewOf('published', TAILNET, 1_000));
    expect(await f.publisher.check()).toEqual(viewOf('published', TAILNET, 1_000));
    expect(f.requests).toHaveLength(1);
  });

  it('publishes again when the address changes', async () => {
    const f = setup();
    await f.publisher.check();
    f.setAddress(OTHER_TAILNET);
    f.setClock(5_000);
    expect(await f.publisher.check()).toEqual(viewOf('published', OTHER_TAILNET, 5_000));
    expect(f.requests.map((r) => r.body)).toEqual([
      { tailnet: TAILNET, port: PORT },
      { tailnet: OTHER_TAILNET, port: PORT },
    ]);
    // And only the address that changed back is a change again.
    f.setAddress(TAILNET);
    await f.publisher.check();
    expect(f.requests).toHaveLength(3);
  });

  it.each([
    ['another owner', { accountId: '00000000-0000-4000-8000-0000000000a2' }],
    ['another backend', { backendOrigin: 'https://other.example' }],
    ['the same account paired again (a new generation)', { generation: 2 }],
  ])('publishes again when the cloud account changes: %s', async (_name, change) => {
    const f = setup();
    await f.publisher.check();
    f.setStatus(connected(change));
    f.setClock(7_000);
    expect(await f.publisher.check()).toEqual(viewOf('published', TAILNET, 7_000));
    expect(f.requests).toHaveLength(2);
    // The new account is not asked again while nothing changes.
    await f.publisher.check();
    expect(f.requests).toHaveLength(2);
  });

  it('does not publish again for a change that is not the address, the port or the account', async () => {
    const f = setup();
    await f.publisher.check();
    f.setStatus(connected({ deviceName: 'Renamed Mac' }));
    f.setStatus({ ...connected({ deviceName: 'Renamed Mac' }), lastError: 'a past hiccup' });
    await f.publisher.check();
    expect(f.requests).toHaveLength(1);
  });

  it.each<[string, Options, string]>([
    ['no phone could use this Mac', { phones: false }, 'not-needed'],
    ['the cloud is disconnected', { status: disconnected }, 'no-cloud'],
    [
      'the cloud device was revoked',
      { status: { connection: connection(), state: 'revoked', lastError: 'revoked' } },
      'no-cloud',
    ],
    [
      'there is no connection at all',
      { status: { connection: null, state: 'offline', lastError: null } },
      'no-cloud',
    ],
    ['Tailscale has no address', { address: null }, 'no-tailscale'],
    ['the only address is on the home network', { address: '192.168.1.20' }, 'no-tailscale'],
  ])('sends nothing when %s', async (_name, options, state) => {
    const f = setup(options);
    expect(await f.publisher.check()).toEqual(viewOf(state));
    expect(f.publisher.view()).toEqual(viewOf(state));
    expect(f.request).not.toHaveBeenCalled();
  });

  it('does not even look at Tailscale until a phone could use this Mac and there is a cloud to tell', async () => {
    const quiet = setup({ phones: false });
    await quiet.publisher.check();
    const alone = setup({ status: disconnected });
    await alone.publisher.check();
    expect(quiet.tailnet).not.toHaveBeenCalled();
    expect(alone.tailnet).not.toHaveBeenCalled();
  });

  it('keeps what it shared across a spell without Tailscale: the same address again is not a change', async () => {
    const f = setup();
    await f.publisher.check();
    f.setAddress(null);
    expect((await f.publisher.check()).state).toBe('no-tailscale');
    f.setAddress(TAILNET);
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.requests).toHaveLength(1);
  });

  it('tries a saved connection nothing has checked yet: offline is what a restart leaves it as', async () => {
    const f = setup({ status: { connection: connection(), state: 'offline', lastError: null } });
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.requests).toHaveLength(1);
  });

  it('never sends the LAN address, the account name or a token', async () => {
    const f = setup({
      status: connected({
        accountId: 'ACCOUNT-ID-SECRET',
        deviceId: 'DEVICE-ID-SECRET',
        deviceName: 'Kason-MBP',
      }),
    });
    await f.publisher.check();
    expect(f.request.mock.calls).toHaveLength(1);
    // Method, path and body: nothing else crosses to the client, and the body is the two fields.
    expect((f.request.mock.calls[0] as unknown as unknown[]).slice(0, 3)).toEqual([
      'PUT',
      '/v1/mac-paths/self',
      { tailnet: TAILNET, port: PORT },
    ]);
    const everything = JSON.stringify([
      f.request.mock.calls,
      f.log.warn.mock.calls,
      f.log.debug.mock.calls,
    ]);
    for (const secret of [
      '192.168',
      'kason@gmail.com',
      'ACCOUNT-ID-SECRET',
      'DEVICE-ID-SECRET',
      'Kason-MBP',
      'oken',
      'Bearer',
      'tail1234.ts.net',
    ]) {
      expect({ secret, found: everything.includes(secret) }).toEqual({ secret, found: false });
    }
  });
});

describe('refusals are remembered for that account', () => {
  it('403 stops retrying for that account and says forbidden', async () => {
    const f = setup({
      reply: () => {
        throw forbidden();
      },
    });
    expect(await f.publisher.check()).toEqual(viewOf('forbidden'));
    for (let i = 0; i < 3; i++) expect((await f.publisher.check()).state).toBe('forbidden');
    expect(f.requests).toHaveLength(1);
    expect(f.publisher.view().state).toBe('forbidden');
    // One warning, with the way out, and nothing about the account.
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    const warning = String(f.log.warn.mock.calls[0]?.[0]);
    expect(warning).toContain('mac-paths:publish');
    expect(warning).not.toContain(ACCOUNT);

    // A new address does not wake it: only another account does.
    f.setAddress(OTHER_TAILNET);
    expect((await f.publisher.check()).state).toBe('forbidden');
    expect(f.requests).toHaveLength(1);

    // The owner paired this Mac again with the scope: a new connection, asked afresh.
    f.setReply(ok);
    f.setStatus(connected({ generation: 2 }));
    expect(await f.publisher.check()).toEqual(viewOf('published', OTHER_TAILNET, 1_000));
    expect(f.requests).toHaveLength(2);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  it('404 says unsupported and stops retrying', async () => {
    const f = setup({
      reply: () => {
        throw notFound();
      },
    });
    expect(await f.publisher.check()).toEqual(viewOf('unsupported'));
    for (let i = 0; i < 3; i++) expect((await f.publisher.check()).state).toBe('unsupported');
    expect(f.requests).toHaveLength(1);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(String(f.log.warn.mock.calls[0]?.[0])).toMatch(/update/i);

    // Another account is asked afresh, and a backend that has since been updated takes it.
    f.setReply(ok);
    f.setStatus(connected({ accountId: '00000000-0000-4000-8000-0000000000a2' }));
    expect((await f.publisher.check()).state).toBe('published');
  });

  it.each([
    [
      'a backend error',
      new CloudError('backend_error', 'Cloud request failed. Check the backend and try again.'),
    ],
    [
      'a 404 that is not the standard not_found',
      new CloudError('not_found', 'Cloud item was not found.', 409),
    ],
    [
      'a forbidden that is not a 403',
      new CloudError(
        'forbidden',
        'This device does not have permission for this cloud action.',
        401,
      ),
    ],
    [
      'an invalid response',
      new CloudError('invalid_response', 'Cloud returned an invalid response.'),
    ],
  ])('%s is just a failure, retried at the next check', async (_name, failure) => {
    const f = setup({
      reply: (nth) => {
        if (nth === 1) throw failure;
        return ok();
      },
    });
    expect(await f.publisher.check()).toEqual(viewOf('failed'));
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.requests).toHaveLength(2);
  });

  it('"Check again" asks once more after a refusal, and the next check does not', async () => {
    const f = setup({
      reply: () => {
        throw notFound();
      },
    });
    expect((await f.publisher.check()).state).toBe('unsupported');
    expect((await f.publisher.check()).state).toBe('unsupported');
    expect(f.requests).toHaveLength(1);

    // The owner updated the backend, then pressed Check again.
    f.setReply(ok);
    expect((await f.publisher.check({ retryRefused: true })).state).toBe('published');
    expect(f.requests).toHaveLength(2);
    // The refusal is forgotten.
    f.setAddress(OTHER_TAILNET);
    expect((await f.publisher.check()).state).toBe('published');
    expect(f.requests).toHaveLength(3);
  });

  it('"Check again" that is refused again says so, without a second warning, and asks nobody else', async () => {
    const f = setup({
      reply: () => {
        throw forbidden();
      },
    });
    await f.publisher.check();
    expect((await f.publisher.check({ retryRefused: true })).state).toBe('forbidden');
    expect(f.requests).toHaveLength(2);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    // Back to not asking.
    await f.publisher.check();
    expect(f.requests).toHaveLength(2);
  });

  it('"Check again" does not publish what is already published, and does not ask a Mac with nothing to say', async () => {
    const f = setup();
    await f.publisher.check();
    await f.publisher.check({ retryRefused: true });
    expect(f.requests).toHaveLength(1);
    f.setAddress(null);
    expect((await f.publisher.check({ retryRefused: true })).state).toBe('no-tailscale');
    expect(f.requests).toHaveLength(1);
  });
});

describe('failures', () => {
  it('a network failure says failed and retries at the next check', async () => {
    vi.useFakeTimers();
    const f = setup({
      reply: (nth) => {
        if (nth === 1) throw offline();
        return ok();
      },
    });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view()).toEqual(viewOf('failed'));
    expect(f.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS - 1);
    expect(f.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requests).toHaveLength(2);
    expect(f.publisher.view()).toEqual(viewOf('published', TAILNET, 1_000));
  });

  it('keeps trying every minute while the cloud stays down, and says so once, not every minute', async () => {
    vi.useFakeTimers();
    const f = setup({
      reply: () => {
        throw offline();
      },
    });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS * 5);
    expect(f.requests).toHaveLength(6);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.publisher.view().state).toBe('failed');
    // It recovers, and a later outage is worth one more line.
    f.setReply(ok);
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS);
    expect(f.publisher.view().state).toBe('published');
    f.setReply(() => {
      throw offline();
    });
    f.setAddress(OTHER_TAILNET);
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS);
    expect(f.publisher.view().state).toBe('failed');
    expect(f.log.warn).toHaveBeenCalledTimes(2);
  });
});

describe('start() and stop()', () => {
  it('checks once at once, then every PUBLISH_CHECK_MS', async () => {
    vi.useFakeTimers();
    const f = setup();
    expect(PUBLISH_CHECK_MS).toBe(60_000);
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.tailnet).toHaveBeenCalledTimes(1);
    expect(f.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS - 1);
    expect(f.tailnet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.tailnet).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS);
    expect(f.tailnet).toHaveBeenCalledTimes(3);
    // Nothing changed, so nothing was sent after the first.
    expect(f.requests).toHaveLength(1);

    // A change is picked up at the next check.
    f.setAddress(OTHER_TAILNET);
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS);
    expect(f.requests).toHaveLength(2);
  });

  it('starting twice is one timer', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.publisher.start();
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS * 2);
    expect(f.tailnet).toHaveBeenCalledTimes(3); // at once, then once a minute
  });

  it('stop() ends the checks, and start() begins them again', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    f.publisher.stop();
    f.setAddress(OTHER_TAILNET);
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS * 3);
    expect(f.requests).toHaveLength(1);
    f.publisher.stop(); // twice is fine

    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
  });

  it('never keeps the process alive: the timer is unref()ed', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const f = setup();
    f.publisher.start();
    expect(spy).toHaveBeenCalledTimes(1);
    const timer = spy.mock.results[0]!.value as { hasRef(): boolean };
    expect(timer.hasRef()).toBe(false);
  });

  it('keeps a stopped publisher answerable', async () => {
    const f = setup();
    f.publisher.stop();
    expect((await f.publisher.check()).state).toBe('published');
  });
});

describe('one check at a time', () => {
  it('concurrent callers share the check that is running', async () => {
    const gate = deferred();
    const f = setup({ reply: () => gate.promise });
    const first = f.publisher.check();
    const second = f.publisher.check();
    expect(second).toBe(first);
    gate.resolve(ok());
    expect(await first).toEqual(viewOf('published', TAILNET, 1_000));
    expect(f.requests).toHaveLength(1);
    expect(f.tailnet).toHaveBeenCalledTimes(1);

    // Once it is over, the next call is a check of its own.
    await f.publisher.check();
    expect(f.tailnet).toHaveBeenCalledTimes(2);
  });

  it('a tick that finds a check running adds nothing to it', async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const f = setup({ reply: () => gate.promise });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS * 3); // the first request is still out
    expect(f.requests).toHaveLength(1);
    expect(f.tailnet).toHaveBeenCalledTimes(1);
    gate.resolve(ok());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view().state).toBe('published');
  });

  describe('"Check again" while a timer check is running', () => {
    /** A remembered 404, a backend that has been updated since, and a Tailscale lookup the test can hold up. */
    async function refusedThenUpdated() {
      let hold: Promise<void> | null = null;
      let looking = 0;
      let mostLooking = 0;
      const f = setup({
        reply: () => {
          throw notFound();
        },
        deps: {
          tailnet: async () => {
            mostLooking = Math.max(mostLooking, ++looking);
            try {
              await hold;
              return TAILNET;
            } finally {
              looking -= 1;
            }
          },
        },
      });
      expect((await f.publisher.check()).state).toBe('unsupported');
      f.setReply(ok);
      return {
        f,
        /** The most checks that were looking at Tailscale at once. */
        mostLooking: () => mostLooking,
        /** Hold the next lookup, as a check that is slow to get its answer would. */
        holdLookup() {
          const gate = deferred();
          hold = gate.promise;
          return () => {
            hold = null;
            gate.resolve(undefined);
          };
        },
      };
    }

    it('waits for the running check, then retries the refusal it remembers', async () => {
      const { f, holdLookup } = await refusedThenUpdated();
      const release = holdLookup();
      const timer = f.publisher.check(); // what the timer does: it honours the remembered refusal
      const pressed = f.publisher.check({ retryRefused: true });
      expect(pressed).not.toBe(timer);
      release();
      expect((await timer).state).toBe('unsupported');
      expect(await pressed).toEqual(viewOf('published', TAILNET, 1_000));
      expect(f.requests).toHaveLength(2); // the first refusal, then the retry: the timer check asked nobody
    });

    it('presses made while one check runs share one retry', async () => {
      const { f, holdLookup } = await refusedThenUpdated();
      const release = holdLookup();
      void f.publisher.check();
      const first = f.publisher.check({ retryRefused: true });
      const second = f.publisher.check({ retryRefused: true });
      expect(second).toBe(first);
      release();
      expect((await first).state).toBe('published');
      expect(f.requests).toHaveLength(2);
    });

    it('joins a retry that is already running instead of queuing another', async () => {
      const { f, holdLookup } = await refusedThenUpdated();
      const release = holdLookup();
      const first = f.publisher.check({ retryRefused: true });
      expect(f.publisher.check({ retryRefused: true })).toBe(first);
      expect(f.publisher.check()).toBe(first); // a timer tick adds nothing either
      release();
      expect((await first).state).toBe('published');
      expect(f.requests).toHaveLength(2);
    });

    it('still runs one check at a time: the retry starts only after the running check is over', async () => {
      const { f, holdLookup, mostLooking } = await refusedThenUpdated();
      const release = holdLookup();
      const timer = f.publisher.check();
      const pressed = f.publisher.check({ retryRefused: true });
      release();
      await Promise.all([timer, pressed]);
      expect(mostLooking()).toBe(1); // never the timer's lookup and the retry's at the same time
      expect(f.requests).toHaveLength(2);
    });
  });

  it('a failed check does not block the next one', async () => {
    const f = setup({
      reply: (nth) => {
        if (nth === 1) throw offline();
        return ok();
      },
    });
    expect((await f.publisher.check()).state).toBe('failed');
    expect((await f.publisher.check()).state).toBe('published');
  });
});

describe('view()', () => {
  it('is pending until the first check has finished, then says what it found', async () => {
    const gate = deferred();
    const f = setup({ reply: () => gate.promise });
    expect(f.publisher.view()).toEqual(viewOf('pending'));
    const done = f.publisher.check();
    expect(f.publisher.view()).toEqual(viewOf('pending')); // the request is still out
    gate.resolve(ok());
    await done;
    expect(f.publisher.view()).toEqual(viewOf('published', TAILNET, 1_000));
  });

  it('is pending until the first check has finished, whatever that check finds', async () => {
    for (const options of [
      { phones: false },
      { status: disconnected },
      { address: null },
    ] as Options[]) {
      const f = setup(options);
      expect(f.publisher.view().state).toBe('pending');
      await f.publisher.check();
      expect(f.publisher.view().state).not.toBe('pending');
    }
  });

  it('keeps what the last check found between checks', async () => {
    const f = setup();
    await f.publisher.check();
    f.setAddress(null); // Tailscale went away since, but nothing has looked
    expect(f.publisher.view()).toEqual(viewOf('published', TAILNET, 1_000));
    await f.publisher.check();
    expect(f.publisher.view()).toEqual(viewOf('no-tailscale', TAILNET, 1_000));
  });

  it('follows the cloud connection at once, without waiting for the next check', async () => {
    const f = setup();
    await f.publisher.check();
    f.setStatus(disconnected);
    expect(f.publisher.view()).toEqual(viewOf('no-cloud'));
    // Connected again, to the same account (a new generation): an answer about the last connection is not an answer for this one.
    f.setStatus(connected({ generation: 2 }));
    expect(f.publisher.view()).toEqual(viewOf('pending'));
    await f.publisher.check();
    expect(f.publisher.view()).toEqual(viewOf('published', TAILNET, 1_000));
  });

  it("does not show one account's refusal for the next", async () => {
    const f = setup({
      reply: () => {
        throw forbidden();
      },
    });
    await f.publisher.check();
    expect(f.publisher.view().state).toBe('forbidden');
    f.setStatus(connected({ generation: 2 }));
    expect(f.publisher.view().state).toBe('pending');
  });

  it('follows whether a phone could use this Mac at once', async () => {
    const f = setup();
    await f.publisher.check();
    f.setPhones(false);
    expect(f.publisher.view().state).toBe('not-needed');
    f.setPhones(true);
    expect(f.publisher.view().state).toBe('published');
  });
});

describe('a fault is a state, not an exception', () => {
  it('check() resolves failed when the Tailscale lookup rejects', async () => {
    const f = setup({
      deps: {
        tailnet: async () => {
          throw new Error('probe exploded');
        },
      },
    });
    await expect(f.publisher.check()).resolves.toEqual(viewOf('failed'));
    expect(f.publisher.view()).toEqual(viewOf('failed'));
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('check() resolves failed when the cloud client throws something that is not a CloudError', async () => {
    const f = setup({
      reply: () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(f.publisher.check()).resolves.toEqual(viewOf('failed'));
    expect(f.publisher.view()).toEqual(viewOf('failed'));
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  it('check() and view() resolve failed when reading the cloud status throws', async () => {
    const f = setup();
    f.setStatus(() => {
      throw new Error('status exploded');
    });
    await expect(f.publisher.check()).resolves.toEqual(viewOf('failed'));
    expect(f.publisher.view()).toEqual(viewOf('failed'));
    expect(f.request).not.toHaveBeenCalled();
  });

  it('check() and view() resolve failed when phonesCouldUse throws', async () => {
    const f = setup({
      deps: {
        phonesCouldUse: () => {
          throw new Error('device list exploded');
        },
      },
    });
    await expect(f.publisher.check()).resolves.toEqual(viewOf('failed'));
    expect(f.publisher.view()).toEqual(viewOf('failed'));
  });

  it('a throwing check does not stop the timer', async () => {
    vi.useFakeTimers();
    let broken = true;
    const f = setup({
      deps: {
        tailnet: async () => {
          if (broken) throw new Error('probe exploded');
          return TAILNET;
        },
      },
    });
    f.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.publisher.view().state).toBe('failed');
    broken = false;
    await vi.advanceTimersByTimeAsync(PUBLISH_CHECK_MS);
    expect(f.publisher.view().state).toBe('published');
  });
});
