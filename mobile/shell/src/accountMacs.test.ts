// @vitest-environment jsdom
// Plan 17: the Macs on the signed-in account (GET /v1/enroll/macs).
// Plan 18: address hints for those Macs from the account's directory (GET /v1/machines), which only ever adds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_HINTS_MS, listAccountMacs, unsavedAccountMacs, withDirectoryHints, type AccountMac } from './accountMacs';
import { ACCOUNT_VAULT_KEY, currentAccount, signInWithGoogle } from './accountSignIn';
import type { HttpRequest } from './http';
import type { HttpResponse } from './pairingClient';
import { createHarness, KASON_MBP, STUDIO } from './testing/shellHarness';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const MACHINES = 'GET https://api.aasc.work/v1/machines';
const MACS = 'GET https://api.aasc.work/v1/enroll/macs';
const MBP = '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USED = '2026-10-21T00:00:00.000Z';

type Harness = ReturnType<typeof createHarness>;

async function signedIn(opts: Parameters<typeof createHarness>[0] = {}) {
  const t = createHarness({ authSession: true, ...opts });
  await signInWithGoogle(t.deps, 'Pixel');
  t.mac.calls.length = 0;
  return t;
}

const requests = (t: Harness) => t.mac.calls.map((c) => `${c.method} ${c.url}`);

describe('listAccountMacs', () => {
  it('asks nothing when signed out', async () => {
    const t = createHarness();
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    expect(t.mac.calls).toHaveLength(0);
  });

  it('lists the account’s Macs with the account token, and nothing else', async () => {
    const t = await signedIn();
    const out = await listAccountMacs(t.deps);
    expect(out).toEqual({
      status: 'ok',
      macs: [{ deviceId: MBP, name: 'Kason-MBP', lan: null, tailnet: '100.101.102.103', port: 3333, lastUsedAt: USED }],
    });
    expect(requests(t)).toEqual([MACS]); // the directory is not this function's to ask
    expect(t.mac.calls[0].headers.Authorization).toMatch(/^Bearer .{20,}/);
  });

  it('reads every entry as untrusted: bad addresses and ports become null, bad ids are dropped, at most 20', async () => {
    const t = await signedIn();
    t.mac.account.setMacs([
      { deviceId: ID(1), name: '  Studio‮  ', tailnet: '8.8.8.8', port: 0 },
      { deviceId: 'mac-not-a-uuid', name: 'X', tailnet: '100.64.0.1', port: 3333 },
      { deviceId: ID(2), name: '', tailnet: '100.064.0.1', port: 3333.5 },
      ...Array.from({ length: 30 }, (_, i) => ({ deviceId: ID(1000 + i), name: `M${i}`, tailnet: null, port: 3333 })),
    ]);
    const out = await listAccountMacs(t.deps);
    if (out.status !== 'ok') throw new Error(out.status);
    expect(out.macs[0]).toEqual({ deviceId: ID(1), name: 'Studio', lan: null, tailnet: null, port: null, lastUsedAt: null });
    expect(out.macs[1]).toEqual({ deviceId: ID(2), name: 'Mac', lan: null, tailnet: null, port: null, lastUsedAt: null });
    expect(out.macs.some((m) => m.deviceId === 'mac-not-a-uuid')).toBe(false);
    expect(out.macs.length).toBeLessThanOrEqual(20);
  });

  it('never has a home-network address: this list has none to give, even when its answer carries one', async () => {
    const t = await signedIn();
    const deps = {
      ...t.deps,
      requester: {
        request: async (): Promise<HttpResponse> => ({
          status: 200,
          data: { success: true, data: { macs: [{ deviceId: MBP, name: 'Kason-MBP', lan: '192.168.1.20', tailnet: null, port: 3333, lastUsedAt: null }] } },
        }),
      },
    };
    expect(await listAccountMacs(deps)).toEqual({ status: 'ok', macs: [{ deviceId: MBP, name: 'Kason-MBP', lan: null, tailnet: null, port: 3333, lastUsedAt: null }] });
  });

  it('a 401 forgets the account: the phone is signed out', async () => {
    const t = await signedIn();
    t.mac.account.revokeDevice(t.mac.account.devices()[0]);
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a token the phone can’t read right now (a locked keychain) is not a sign-out: nothing is asked, everything stays', async () => {
    const t = await signedIn();
    t.faults.vaultRead = true;
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'unavailable', unreadable: true });
    expect(t.mac.calls).toHaveLength(0);
    t.faults.vaultRead = false;
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(await currentAccount(t.deps)).not.toBeNull();
    expect((await listAccountMacs(t.deps)).status).toBe('ok'); // readable again: the same token still lists
  });

  it('a vault that answers "no token" is signed out, as is one holding something that isn’t a token', async () => {
    const t = await signedIn();
    t.vault.set(ACCOUNT_VAULT_KEY, 'not json');
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    t.vault.delete(ACCOUNT_VAULT_KEY);
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'signed-out' });
    expect(t.mac.calls).toHaveLength(0);
  });

  it('a cloud that is down is just unavailable: the account stays, and it was asked once', async () => {
    const t = await signedIn();
    t.mac.setBackendDown(true);
    expect(await listAccountMacs(t.deps)).toEqual({ status: 'unavailable' });
    expect(requests(t)).toEqual([MACS]);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });
});

describe('withDirectoryHints (GET /v1/machines)', () => {
  /** The Mac as the list has it, and as the directory's entry for it (what the backend writes). */
  const base = (over: Partial<AccountMac> = {}): AccountMac => ({ deviceId: MBP, name: 'Kason-MBP', lan: null, tailnet: '100.101.102.103', port: 3333, lastUsedAt: USED, ...over });
  const pathsOf = (over: Record<string, unknown> = {}) => ({ lan: '192.168.1.20', tailnet: '100.99.1.1', public: null, port: 4444, updatedAt: USED, ...over });
  const machine = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    deviceId: MBP, name: 'Renamed in the directory', platform: 'macos', edition: 'full', appVersion: '2.10.80', lastUsedAt: '2026-11-19T00:00:00.000Z',
    current: false, connectable: true, relation: 'self', paths: pathsOf(), ...over,
  });
  const directory = (...machines: unknown[]): HttpResponse => ({ status: 200, data: { success: true, data: { machines } } });

  /** The phone with GET /v1/machines answered by the test: a response, an Error for a request that fails, or a wait. */
  function phone(t: Harness, answer: HttpResponse | Error | Promise<HttpResponse>) {
    const asked: Array<{ line: string; timeoutMs?: number; authorization?: string }> = [];
    const deps = {
      ...t.deps,
      requester: {
        request: async (req: HttpRequest): Promise<HttpResponse> => {
          asked.push({ line: `${req.method} ${req.url}`, timeoutMs: req.timeoutMs, authorization: req.headers?.Authorization });
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
    return { deps, asked };
  }

  it('asks the directory once, with the account token and a short timeout of its own', async () => {
    const t = await signedIn();
    const { deps, asked } = phone(t, directory(machine()));
    await withDirectoryHints(deps, [base()]);
    expect(asked.map((a) => a.line)).toEqual([MACHINES]);
    expect(asked[0].authorization).toMatch(/^Bearer .{20,}/);
    expect(asked[0].timeoutMs).toBe(DIRECTORY_HINTS_MS);
    expect(DIRECTORY_HINTS_MS).toBe(3_000);
  });

  it('adds the home-network address to a Mac the list already has, and changes nothing else about it', async () => {
    const t = await signedIn();
    const { deps } = phone(t, directory(machine()));
    // The list's own Tailscale address and port stay; the name and last-used time are the list's too.
    expect(await withDirectoryHints(deps, [base()])).toEqual([base({ lan: '192.168.1.20' })]);
  });

  it('fills the Tailscale address only where the list has none', async () => {
    const t = await signedIn();
    const { deps } = phone(t, directory(machine()));
    expect(await withDirectoryHints(deps, [base({ tailnet: null })])).toEqual([base({ lan: '192.168.1.20', tailnet: '100.99.1.1' })]);
  });

  it('takes the directory’s port only where the list has none', async () => {
    const t = await signedIn();
    const { deps } = phone(t, directory(machine()));
    expect(await withDirectoryHints(deps, [base({ tailnet: null, port: null })])).toEqual([base({ lan: '192.168.1.20', tailnet: '100.99.1.1', port: 4444 })]);
  });

  it('reads the fake backend’s directory the same way: the Mac’s home-network address is added', async () => {
    const t = await signedIn();
    t.mac.account.setMacs([{ deviceId: MBP, name: 'Kason-MBP', lan: '192.168.1.20', public: '203.0.113.9', tailnet: '100.101.102.103', port: 3333, lastUsedAt: USED }]);
    const listed = await listAccountMacs(t.deps);
    if (listed.status !== 'ok') throw new Error(listed.status);
    expect(listed.macs).toEqual([base()]);
    const hinted = await withDirectoryHints(t.deps, listed.macs);
    expect(hinted).toEqual([base({ lan: '192.168.1.20' })]);
    expect(JSON.stringify(hinted)).not.toContain('203.0.113.9'); // the public address is not read
    expect(requests(t)).toEqual([MACS, MACHINES]);
  });

  it('never adds, removes, reorders or renames a row', async () => {
    const t = await signedIn();
    const list = [base({ deviceId: ID(2), name: 'Studio', tailnet: '100.88.1.7' }), base()];
    const { deps } = phone(t, directory(
      machine({ deviceId: ID(9), name: 'Only in the directory' }),
      machine({ deviceId: MBP, name: 'Other name', paths: pathsOf({ lan: '192.168.1.20' }) }),
      // ID(2) is not in the directory at all.
    ));
    expect(await withDirectoryHints(deps, list)).toEqual([list[0], base({ lan: '192.168.1.20' })]);
  });

  it('no entry matches: the list comes back as it was', async () => {
    const t = await signedIn();
    const list = [base()];
    const { deps } = phone(t, directory(machine({ deviceId: ID(9) })));
    expect(await withDirectoryHints(deps, list)).toBe(list);
  });

  it.each<[string, unknown]>([
    ['another relation', 'group'],
    ['no relation', undefined],
    ['a null relation', null],
  ])('an entry with %s gives no hint, even for a Mac on the list', async (_what, relation) => {
    const t = await signedIn();
    const list = [base()];
    const { deps } = phone(t, directory(machine({ relation })));
    expect(await withDirectoryHints(deps, list)).toBe(list);
  });

  it('ignores `connectable` and `current`: the list already says a phone can connect to this Mac', async () => {
    const t = await signedIn();
    const { deps } = phone(t, directory(machine({ connectable: false, current: true })));
    expect(await withDirectoryHints(deps, [base()])).toEqual([base({ lan: '192.168.1.20' })]);
  });

  it('the first entry for a Mac is the one read', async () => {
    const t = await signedIn();
    const { deps } = phone(t, directory(machine({ paths: pathsOf({ lan: '10.0.0.5' }) }), machine({ paths: pathsOf({ lan: '10.0.0.6' }) })));
    expect(await withDirectoryHints(deps, [base()])).toEqual([base({ lan: '10.0.0.5' })]);
  });

  // A Mac the list has no address or port for, so every hint could land: what lands is only what is of the right kind.
  const ALL = { lan: '192.168.1.20', tailnet: '100.99.1.1', port: 4444 };
  it.each<[string, Record<string, unknown>, Pick<AccountMac, 'lan' | 'tailnet' | 'port'>]>([
    ['a public address as the home-network one', { lan: '8.8.8.8' }, { ...ALL, lan: null }],
    ['a Tailscale address as the home-network one', { lan: '100.101.102.104' }, { ...ALL, lan: null }],
    ['a home-network address with a leading zero (dialled as another address)', { lan: '192.168.01.20' }, { ...ALL, lan: null }],
    ['a host name as the home-network one', { lan: 'evil.example' }, { ...ALL, lan: null }],
    ['a number as the home-network one', { lan: 3232235796 }, { ...ALL, lan: null }],
    ['a home-network address as the Tailscale one', { tailnet: '192.168.1.21' }, { ...ALL, tailnet: null }],
    ['a public address as the Tailscale one', { tailnet: '8.8.8.8' }, { ...ALL, tailnet: null }],
    ['the two swapped', { lan: '100.99.1.1', tailnet: '192.168.1.20' }, { ...ALL, lan: null, tailnet: null }],
    ['a port out of range', { port: 70000 }, { ...ALL, port: null }],
    ['a port as text', { port: '4444' }, { ...ALL, port: null }],
  ])('drops %s (nothing is moved to the other kind)', async (_what, paths, want) => {
    const t = await signedIn();
    const bare = base({ tailnet: null, port: null });
    const { deps } = phone(t, directory(machine({ paths: pathsOf(paths) })));
    expect(await withDirectoryHints(deps, [bare])).toEqual([{ ...bare, ...want }]);
  });

  it.each<[string, unknown]>([
    ['null (the computer publishes no address)', null],
    ['missing', undefined],
    ['a string', '192.168.1.20'],
    ['a list', ['192.168.1.20']],
  ])('paths %s: the Mac comes back as it was', async (_what, paths) => {
    const t = await signedIn();
    const list = [base()];
    const { deps } = phone(t, directory(machine({ paths })));
    expect(await withDirectoryHints(deps, list)).toBe(list);
  });

  it('reads at most the backend’s 50 entries', async () => {
    const t = await signedIn();
    const list = [base()];
    const others = Array.from({ length: 50 }, (_, i) => machine({ deviceId: ID(300 + i) }));
    expect(await withDirectoryHints(phone(t, directory(...others, machine())).deps, list)).toBe(list);
    expect(await withDirectoryHints(phone(t, directory(...others.slice(1), machine())).deps, list)).toEqual([base({ lan: '192.168.1.20' })]);
  });

  it.each<[string, HttpResponse | Error]>([
    ['a request that fails', new Error('network')],
    ['a 403 (a phone that signed in before the backend listed computers)', { status: 403, data: { success: false, error: { code: 'forbidden' } } }],
    ['a 404 (a backend without the directory)', { status: 404, data: { success: false, error: { code: 'not_found' } } }],
    ['a 500', { status: 500, data: { success: false, error: { code: 'internal' } } }],
    ['a 503 with no body', { status: 503, data: null }],
    ['a 429', { status: 429, data: { success: false, error: { code: 'rate_limited' } } }],
    ['a 200 with no body', { status: 200, data: null }],
    ['a 200 that is text', { status: 200, data: '<html>' }],
    ['a 200 without the list', { status: 200, data: { success: true, data: {} } }],
    ['a 200 whose list is not a list', { status: 200, data: { success: true, data: { machines: { 0: machine() } } } }],
    ['a 200 with the enroll list’s shape', { status: 200, data: { success: true, data: { macs: [machine()] } } }],
    ['a 201 carrying the list', { status: 201, data: { success: true, data: { machines: [machine()] } } }],
  ])('%s leaves the list untouched', async (_what, answer) => {
    const t = await signedIn();
    const list = [base(), base({ deviceId: ID(2), name: 'Studio', tailnet: null, port: null })];
    const before = JSON.stringify(list);
    const { deps, asked } = phone(t, answer);
    const out = await withDirectoryHints(deps, list);
    expect(out).toBe(list);
    expect(JSON.stringify(out)).toBe(before);
    expect(asked).toHaveLength(1);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });

  it('a 401 leaves the list untouched and does NOT sign the phone out: only the list’s own read decides that', async () => {
    const t = await signedIn();
    const list = [base()];
    const { deps, asked } = phone(t, { status: 401, data: { success: false, error: { code: 'unauthorized' } } });
    expect(await withDirectoryHints(deps, list)).toBe(list);
    expect(asked).toHaveLength(1);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });

  it('a token the backend no longer knows: the real 401 changes nothing here either', async () => {
    const t = await signedIn();
    const list = [base()];
    t.mac.account.revokeDevice(t.mac.account.devices()[0]);
    expect(await withDirectoryHints(t.deps, list)).toBe(list);
    expect(requests(t)).toEqual([MACHINES]);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  });

  it.each<['forbidden' | 'absent']>([['forbidden'], ['absent']])('a %s directory on the fake backend leaves the list untouched', async (mode) => {
    const t = await signedIn({ mac: { account: { directory: mode } } });
    t.mac.account.setMacs([{ deviceId: MBP, name: 'Kason-MBP', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, lastUsedAt: USED }]);
    const list = [base()];
    expect(await withDirectoryHints(t.deps, list)).toBe(list);
    expect(requests(t)).toEqual([MACHINES]);
    t.mac.account.setDirectory('listed'); // the phone signs in again, or the backend is updated
    expect(await withDirectoryHints(t.deps, list)).toEqual([base({ lan: '192.168.1.20' })]);
  });

  it('a directory that never answers is given up on after its timeout: the list comes back untouched', async () => {
    const t = await signedIn();
    const list = [base()];
    const { deps, asked } = phone(t, new Promise<HttpResponse>(() => undefined));
    const started = Date.now();
    expect(await withDirectoryHints(deps, list, 30)).toBe(list);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(asked.map((a) => a.timeoutMs)).toEqual([30]); // the native request gets the same limit
  });

  // The limit is for the whole step, the read of the phone's own token included: whatever it is stuck on, the
  // caller (Connect) goes on at the limit with the list as it was.
  describe('one limit for the whole step', () => {
    /** A phone signed in (on the real clock), then a fake clock for everything the test sets up after it. */
    async function onFakeClock() {
      const t = await signedIn();
      vi.useFakeTimers();
      return t;
    }

    /** Start the step; `out()` is its answer once it has one. */
    function start(deps: Parameters<typeof withDirectoryHints>[0], list: AccountMac[]) {
      const got: AccountMac[][] = [];
      void withDirectoryHints(deps, list).then((macs) => {
        got.push(macs);
      });
      return { out: () => got[0] ?? null, answers: () => got.length };
    }

    it('a vault that never answers (it hangs, it does not throw): given up on at the limit, the list untouched, nothing asked', async () => {
      const t = await onFakeClock();
      const list = [base()];
      const { deps, asked } = phone(t, directory(machine()));
      const stuck = { ...deps, vault: { ...deps.vault, get: () => new Promise<string | null>(() => undefined) } };
      const step = start(stuck, list);
      await vi.advanceTimersByTimeAsync(DIRECTORY_HINTS_MS - 1);
      expect(step.out()).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(step.out()).toBe(list);
      expect(asked).toHaveLength(0);
    });

    it('a slow vault and a directory that never answers share the one limit, not one each', async () => {
      const t = await onFakeClock();
      const list = [base()];
      const { deps, asked } = phone(t, new Promise<HttpResponse>(() => undefined));
      const get = deps.vault.get.bind(deps.vault);
      const slow = { ...deps, vault: { ...deps.vault, get: (key: string) => new Promise<string | null>((resolve) => { setTimeout(() => resolve(get(key)), 2_000); }) } };
      const step = start(slow, list);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(asked).toHaveLength(1); // the token was read at 2 s, and the directory asked
      expect(step.out()).toBeNull();
      await vi.advanceTimersByTimeAsync(DIRECTORY_HINTS_MS - 2_500);
      expect(step.out()).toBe(list); // at 3 s from the start, not 3 s from the request
    });

    it('an answer that comes after the limit changes nothing', async () => {
      const t = await onFakeClock();
      const list = [base()];
      const before = JSON.stringify(list);
      const late = new Promise<HttpResponse>((resolve) => { setTimeout(() => resolve(directory(machine())), DIRECTORY_HINTS_MS + 2_000); });
      const step = start(phone(t, late).deps, list);
      await vi.advanceTimersByTimeAsync(DIRECTORY_HINTS_MS);
      expect(step.out()).toBe(list);
      await vi.advanceTimersByTimeAsync(10_000); // the directory answers, with a hint, long after
      expect(step.answers()).toBe(1);
      expect(step.out()).toBe(list);
      expect(JSON.stringify(list)).toBe(before);
    });

    it('an answer just inside the limit still counts', async () => {
      const t = await onFakeClock();
      const inTime = new Promise<HttpResponse>((resolve) => { setTimeout(() => resolve(directory(machine())), DIRECTORY_HINTS_MS - 100); });
      const step = start(phone(t, inTime).deps, [base()]);
      await vi.advanceTimersByTimeAsync(DIRECTORY_HINTS_MS - 100);
      expect(step.out()).toEqual([base({ lan: '192.168.1.20' })]);
    });
  });

  it('a token the phone can’t read right now: nothing is asked, the list is untouched, nothing is forgotten', async () => {
    const t = await signedIn();
    const list = [base()];
    t.faults.vaultRead = true;
    expect(await withDirectoryHints(t.deps, list)).toBe(list);
    expect(t.mac.calls).toHaveLength(0);
    t.faults.vaultRead = false;
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });

  it('signed out, or with nothing on the list: nothing is asked', async () => {
    const out = createHarness();
    const list = [base()];
    expect(await withDirectoryHints(out.deps, list)).toBe(list);
    expect(out.mac.calls).toHaveLength(0);
    const t = await signedIn();
    const none: AccountMac[] = [];
    expect(await withDirectoryHints(t.deps, none)).toBe(none);
    expect(t.mac.calls).toHaveLength(0);
  });

  it('never changes the list it was given, or the Macs in it', async () => {
    const t = await signedIn();
    const list = [Object.freeze(base({ tailnet: null, port: null }))];
    Object.freeze(list);
    const { deps } = phone(t, directory(machine()));
    const out = await withDirectoryHints(deps, list);
    expect(out).not.toBe(list);
    expect(list).toEqual([base({ tailnet: null, port: null })]);
  });
});

describe('unsavedAccountMacs', () => {
  it('leaves out the Macs a saved row already has (by backend device)', () => {
    const listed = [
      { deviceId: MBP, name: 'Kason-MBP', lan: null, tailnet: null, port: 3333, lastUsedAt: null },
      { deviceId: ID(3), name: 'Studio', lan: '192.168.1.40', tailnet: '100.88.1.7', port: 3333, lastUsedAt: null },
    ];
    const saved = [{ ...KASON_MBP, backendDeviceId: MBP }, STUDIO];
    expect(unsavedAccountMacs(listed, saved).map((m) => m.deviceId)).toEqual([ID(3)]);
  });
});
