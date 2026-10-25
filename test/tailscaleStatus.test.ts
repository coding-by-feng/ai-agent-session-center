// test/tailscaleStatus.test.ts - AASC-60 Remote access, Task 1: what this Mac knows about its own
// Tailscale. `tailscale status --json` is documented as "format subject to change", so a good part
// of this file is about answers that are missing, broken, or from a newer Tailscale.
//
// Nothing here may start the real `tailscale` (or the macOS app binary that doubles as the CLI):
// every probe is built by probeWith(), whose defaults are all fakes
// (.claude/rules/known-issues.md, "A test must never reach a real process").
import { describe, it, expect, vi } from 'vitest';
import {
  TAILSCALE_CACHE_MS,
  TAILSCALE_CLI_PATHS,
  TAILSCALE_PROBE_TIMEOUT_MS,
  createTailscaleProbe,
  parseTailscaleStatus,
  type TailscaleProbeDeps,
} from '../server/tailscaleStatus.js';

// The probe logs why it fell back at debug level; keep that out of the test output when a
// developer's data/server-config.json turns debug on.
vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Run = NonNullable<TailscaleProbeDeps['run']>;

const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** A trimmed `tailscale status --json` of a signed-in Mac whose Tailscale is running. */
const RUNNING = {
  BackendState: 'Running',
  TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  Self: {
    HostName: 'Kason-MBP',
    DNSName: 'kason-mbp.tail1234.ts.net.',
    UserID: 123,
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    Online: true,
  },
  CurrentTailnet: {
    Name: 'kason@gmail.com',
    MagicDNSSuffix: 'tail1234.ts.net',
    MagicDNSEnabled: true,
  },
  User: { '123': { ID: 123, LoginName: 'kason@gmail.com', DisplayName: 'Kason' } },
};

/** A Mac that is signed out: Go writes every section it has nothing for as null. */
const SIGNED_OUT = {
  Version: '1.80.0',
  BackendState: 'NeedsLogin',
  AuthURL: 'https://login.tailscale.com/a/abc123',
  TailscaleIPs: null,
  Self: null,
  CurrentTailnet: null,
  User: null,
  Peer: null,
};

const CONNECTED = {
  state: 'connected',
  address: '100.101.102.103',
  account: 'kason@gmail.com',
  tailnet: 'kason@gmail.com',
  dnsName: 'kason-mbp.tail1234.ts.net',
};
const NO_DETAILS = { address: null, account: null, tailnet: null, dnsName: null };
/** An interface address that is not Tailscale's: Cloudflare WARP's range, inside 100.64.0.0/10 all the same. */
const WARP = '100.96.0.7';

/** A `run` that exits 0 and prints `status` as JSON. */
const answers =
  (status: unknown): Run =>
  async () => ({ stdout: JSON.stringify(status) });

/** A `run` that prints `stdout` raw, whatever it is. */
const prints =
  (stdout: string): Run =>
  async () => ({ stdout });

/** A `run` that exits non-zero the way a promisified execFile rejects: stdout rides on the error. */
const fails =
  (stdout?: string): Run =>
  async () => {
    throw Object.assign(new Error('Command failed: tailscale status --json'), {
      code: 1,
      stdout,
      stderr: '',
    });
  };

/**
 * A probe whose every dependency is a fake: the Mac app's CLI is installed and reports RUNNING,
 * and the tunnel interface agrees. A test overrides only what it is about.
 */
function probeWith(deps: TailscaleProbeDeps = {}) {
  return createTailscaleProbe({
    platform: 'darwin',
    exists: async (path) => path === MAC_APP_CLI,
    run: answers(RUNNING),
    interfaceAddress: () => '100.101.102.103',
    ...deps,
  });
}

describe('createTailscaleProbe', () => {
  it('maps a Running status to connected with address, account, tailnet and DNS name', async () => {
    const probe = createTailscaleProbe({
      platform: 'darwin',
      exists: async (p) => p === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      run: async () => ({ stdout: JSON.stringify(RUNNING) }),
      interfaceAddress: () => '100.101.102.103',
    });
    expect(await probe.status()).toEqual({
      state: 'connected',
      address: '100.101.102.103',
      account: 'kason@gmail.com',
      tailnet: 'kason@gmail.com',
      dnsName: 'kason-mbp.tail1234.ts.net',
    });
  });

  it('runs the CLI with status --json, a 3 s timeout and TAILSCALE_BE_CLI=1', async () => {
    const run = vi.fn<Run>(answers(RUNNING));
    await probeWith({ run }).status();

    expect(run).toHaveBeenCalledTimes(1);
    const [file, args, opts] = run.mock.calls[0];
    expect(file).toBe(MAC_APP_CLI);
    expect(args).toEqual(['status', '--json']);
    expect(opts.timeout).toBe(3_000);
    expect(opts.timeout).toBe(TAILSCALE_PROBE_TIMEOUT_MS);
    expect(opts.maxBuffer).toBe(2 * 1024 * 1024);
    expect(opts.env.TAILSCALE_BE_CLI).toBe('1');
    expect(opts.env.PATH).toBe(process.env.PATH); // the rest of the environment comes along
  });

  it('maps NeedsLogin and NeedsMachineAuth to signed-out, Stopped to stopped, Starting/NoState to not-running', async () => {
    const names = ['NeedsLogin', 'NeedsMachineAuth', 'Stopped', 'Starting', 'NoState', 'Running'];
    const states: Record<string, string> = {};
    for (const name of names) {
      // The default interface still has a 100.x address: while the CLI answers, BackendState decides.
      const probe = probeWith({ run: answers({ BackendState: name }) });
      states[name] = (await probe.status()).state;
    }
    expect(states).toEqual({
      NeedsLogin: 'signed-out',
      NeedsMachineAuth: 'signed-out',
      Stopped: 'stopped',
      Starting: 'not-running',
      NoState: 'not-running',
      Running: 'connected',
    });
  });

  it('reads a signed-out status whose sections are null', async () => {
    const probe = probeWith({ run: answers(SIGNED_OUT), interfaceAddress: () => null });
    expect(await probe.status()).toEqual({ state: 'signed-out', ...NO_DETAILS });
  });

  it('keeps what the CLI knows when Tailscale is not connected', async () => {
    // A switched-off Tailscale keeps its netmap; its 100.x address is stable while it is off.
    const stopped = { ...RUNNING, BackendState: 'Stopped' };
    const probe = probeWith({ run: answers(stopped), interfaceAddress: () => null });
    expect(await probe.status()).toEqual({ ...CONNECTED, state: 'stopped' });
  });

  it('uses Self.TailscaleIPs when no interface has the address', async () => {
    const onlySelf = { ...RUNNING, TailscaleIPs: undefined }; // JSON.stringify drops the key
    const probe = probeWith({ run: answers(onlySelf), interfaceAddress: () => null });
    expect(await probe.status()).toEqual(CONNECTED);
  });

  // Cloudflare WARP (100.96.0.0/12), NordVPN Meshnet or a carrier-grade-NAT LAN lease also put an interface
  // address inside 100.64.0.0/10. The CLI names this Mac's Tailscale address; no interface overrules it.
  it('takes the address from the CLI when another 100.64.0.0/10 interface differs from it', async () => {
    const probe = probeWith({ interfaceAddress: () => WARP });
    expect(await probe.status()).toEqual(CONNECTED);
  });

  it('a Running CLI with no usable IPv4 has no address, whatever an interface holds', async () => {
    const v6 = ['fd7a:115c:a1e0::1'];
    const v6Only = { ...RUNNING, TailscaleIPs: v6, Self: { ...RUNNING.Self, TailscaleIPs: v6 } };
    const probe = probeWith({ run: answers(v6Only), interfaceAddress: () => WARP });
    expect(await probe.status()).toEqual({ ...CONNECTED, address: null });
  });

  it('a CLI that fails, prints nothing or times out stands aside like a missing one: the interface decides (R26)', async () => {
    const odd = () => Promise.reject('boom');
    for (const run of [fails(''), fails(undefined), odd, prints('')]) {
      const viaInterface = probeWith({ run, interfaceAddress: () => WARP });
      expect(await viaInterface.status()).toEqual({ state: 'connected', ...NO_DETAILS, address: WARP });
      // With no interface either, the CLI exists but says nothing: not-running.
      const alone = probeWith({ run, interfaceAddress: () => null });
      expect(await alone.status()).toEqual({ state: 'not-running', ...NO_DETAILS });
    }
  });

  it('while the CLI names a known state, no interface address is used, whichever state it is (R26)', async () => {
    const names = ['Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState'];
    for (const name of names) {
      const probe = probeWith({ run: answers({ BackendState: name }), interfaceAddress: () => WARP });
      expect((await probe.status()).address, name).toBeNull();
    }
  });

  it('connected from the interface alone when no CLI exists', async () => {
    const run = vi.fn<Run>();
    const probe = probeWith({
      exists: async () => false,
      run,
      interfaceAddress: () => '100.88.1.7',
    });
    expect(await probe.status()).toEqual({
      state: 'connected',
      ...NO_DETAILS,
      address: '100.88.1.7',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('not-installed when there is no CLI and no Tailscale interface', async () => {
    const run = vi.fn<Run>();
    const probe = probeWith({ exists: async () => false, run, interfaceAddress: () => null });
    expect(await probe.status()).toEqual({ state: 'not-installed', ...NO_DETAILS });
    expect(run).not.toHaveBeenCalled();
  });

  it('parses JSON from a failed run (non-zero exit with stdout) and not-running without stdout', async () => {
    const stopped = JSON.stringify({ ...RUNNING, BackendState: 'Stopped' });
    expect((await probeWith({ run: fails(stopped) }).status()).state).toBe('stopped');
    expect(await probeWith({ run: fails(JSON.stringify(RUNNING)) }).status()).toEqual(CONNECTED);

    // No stdout at all (the daemon is down, ENOENT, a timeout): the CLI is there but not answering.
    const down = { interfaceAddress: () => null };
    const empty = await probeWith({ ...down, run: fails('') }).status();
    expect(empty).toEqual({ state: 'not-running', ...NO_DETAILS });
    const none = await probeWith({ ...down, run: fails(undefined) }).status();
    expect(none).toEqual({ state: 'not-running', ...NO_DETAILS });
    const odd = await probeWith({ ...down, run: () => Promise.reject('boom') }).status();
    expect(odd).toEqual({ state: 'not-running', ...NO_DETAILS });
  });

  it('a changed format (no Self, wrong types) falls back to the interface address (R26)', async () => {
    // A CLI answer that is not readable as a known state is no answer: the interface stands in, so a future Tailscale
    // output format cannot make every page read "installed but not running".
    const unusable = [
      '{"Self":"x"}',
      'not json',
      '{"BackendState":"Run', // cut off by the 3 s timeout
      '[]',
      'null',
      '"Running"',
      JSON.stringify({ BackendState: 42 }),
      JSON.stringify({ BackendState: 'SomethingNew' }),
    ];
    for (const stdout of unusable) {
      const viaInterface = probeWith({ run: prints(stdout), interfaceAddress: () => '100.88.1.7' });
      expect(await viaInterface.status(), stdout).toEqual({
        state: 'connected',
        ...NO_DETAILS,
        address: '100.88.1.7',
      });
      // With no interface the CLI exists but cannot say anything: not-running.
      const alone = probeWith({ run: prints(stdout), interfaceAddress: () => null });
      expect(await alone.status(), stdout).toEqual({ state: 'not-running', ...NO_DETAILS });
    }
  });

  it('one CLI run for concurrent calls and within 5 s; fresh: true runs again', async () => {
    expect(TAILSCALE_CACHE_MS).toBe(5_000);
    let clock = 1_000_000;
    const run = vi.fn<Run>(answers(RUNNING));
    const probe = probeWith({ run, now: () => clock });

    const [first, second] = await Promise.all([probe.status(), probe.status()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    clock += TAILSCALE_CACHE_MS - 1;
    expect(await probe.status()).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);

    await probe.status({ fresh: true });
    expect(run).toHaveBeenCalledTimes(2);

    // The fresh answer starts a new 5 s window; the window ends at exactly TAILSCALE_CACHE_MS.
    clock += TAILSCALE_CACHE_MS - 1;
    await probe.status();
    expect(run).toHaveBeenCalledTimes(2);
    clock += 1;
    await probe.status();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('ignores IPv6 and non-CGNAT entries in TailscaleIPs, and an interface does not fill the gap', async () => {
    const entries = ['fd7a::1', '192.168.1.5', '100.63.255.255', '100.128.0.1', 7, null];
    const odd = {
      ...RUNNING,
      TailscaleIPs: entries,
      Self: { ...RUNNING.Self, TailscaleIPs: entries },
    };

    for (const interfaceAddress of [() => '100.88.1.7', () => null]) {
      const probe = probeWith({ run: answers(odd), interfaceAddress });
      expect((await probe.status()).address).toBeNull();
    }
  });

  it('a fresh request made while a probe is running joins it instead of starting a second CLI', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<Run>(async () => {
      await gate;
      return { stdout: JSON.stringify(RUNNING) };
    });
    const probe = probeWith({ run });

    const background = probe.status();
    const refresh = probe.status({ fresh: true });
    release();

    expect(await refresh).toEqual(await background);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a clock that steps backwards does not keep an answer fresh', async () => {
    let clock = 1_000_000;
    const run = vi.fn<Run>(answers(RUNNING));
    const probe = probeWith({ run, now: () => clock });

    await probe.status();
    clock -= 60_000; // an NTP step, or the user set the clock back: the age reads negative
    await probe.status();
    expect(run).toHaveBeenCalledTimes(2);

    // And once the clock runs forward again the new answer is cached as usual.
    clock += TAILSCALE_CACHE_MS - 1;
    await probe.status();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('caches a failed probe too, so a hung Tailscale is not asked again on every call', async () => {
    let clock = 5_000;
    const run = vi.fn<Run>(fails(''));
    const probe = probeWith({ run, now: () => clock, interfaceAddress: () => null });

    expect((await probe.status()).state).toBe('not-running');
    clock += TAILSCALE_CACHE_MS - 1;
    expect((await probe.status()).state).toBe('not-running');
    expect(run).toHaveBeenCalledTimes(1);

    clock += 1;
    await probe.status();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never rejects: a throwing exists or interfaceAddress reads as nothing found', async () => {
    const probe = probeWith({
      exists: async () => {
        throw new Error('EACCES');
      },
      interfaceAddress: () => {
        throw new Error('uv_interface_addresses returned an error');
      },
    });
    expect(await probe.status()).toEqual({ state: 'not-installed', ...NO_DETAILS });
  });

  it('reads a run that resolves without a stdout string as silent, not as a crash', async () => {
    const noStdout = (async () => ({})) as unknown as Run;
    const probe = probeWith({ run: noStdout, interfaceAddress: () => null });
    expect(await probe.status()).toEqual({ state: 'not-running', ...NO_DETAILS });
  });

  it('hands out a frozen status, so one consumer cannot change what the next one reads', async () => {
    const probe = probeWith();
    const status = await probe.status();
    expect(Object.isFrozen(status)).toBe(true);
    expect(await probe.status()).toBe(status);
  });
});

describe('which CLI runs', () => {
  it('lists the install locations of each platform, best first', () => {
    expect(TAILSCALE_CLI_PATHS).toEqual({
      darwin: [
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        '/usr/local/bin/tailscale',
        '/opt/homebrew/bin/tailscale',
      ],
      linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
      win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
    });
  });

  it.each([
    [
      'darwin',
      [MAC_APP_CLI, '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
      MAC_APP_CLI,
    ],
    [
      'darwin',
      ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
      '/usr/local/bin/tailscale',
    ],
    ['darwin', ['/opt/homebrew/bin/tailscale'], '/opt/homebrew/bin/tailscale'],
    ['linux', ['/usr/bin/tailscale', '/usr/local/bin/tailscale'], '/usr/bin/tailscale'],
    ['linux', ['/usr/local/bin/tailscale'], '/usr/local/bin/tailscale'],
    [
      'win32',
      ['C:\\Program Files\\Tailscale\\tailscale.exe'],
      'C:\\Program Files\\Tailscale\\tailscale.exe',
    ],
  ] as const)(
    'on %s, with %j installed, the first existing path (%s) runs',
    async (platform, installed, expected) => {
      const run = vi.fn<Run>(answers(RUNNING));
      const exists = vi.fn(async (path: string) => (installed as readonly string[]).includes(path));
      await probeWith({ platform, exists, run }).status();

      expect(run.mock.calls[0][0]).toBe(expected);
      // It stops looking at the first hit: nothing after it is checked.
      const paths = TAILSCALE_CLI_PATHS[platform] as readonly string[];
      const asked = exists.mock.calls.map(([path]) => path);
      expect(asked).toEqual(paths.slice(0, paths.indexOf(expected) + 1));
    },
  );

  it('a platform with no known CLI location relies on the interface alone', async () => {
    const run = vi.fn<Run>();
    const exists = vi.fn(async () => true);
    const bsd = { platform: 'freebsd' as const, exists, run };

    expect(await probeWith({ ...bsd, interfaceAddress: () => null }).status()).toEqual({
      state: 'not-installed',
      ...NO_DETAILS,
    });
    expect(await probeWith({ ...bsd, interfaceAddress: () => '100.88.1.7' }).status()).toEqual({
      state: 'connected',
      ...NO_DETAILS,
      address: '100.88.1.7',
    });
    expect(exists).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('parseTailscaleStatus', () => {
  it('reads the state, the first Tailscale IPv4, the account, the tailnet and the DNS name', () => {
    expect(parseTailscaleStatus(RUNNING)).toEqual({
      backendState: 'Running',
      address: '100.101.102.103',
      account: 'kason@gmail.com',
      tailnet: 'kason@gmail.com',
      dnsName: 'kason-mbp.tail1234.ts.net',
    });
  });

  it('takes the account from User[Self.UserID], not from another user', () => {
    const shared = {
      ...RUNNING,
      User: {
        '7': { ID: 7, LoginName: 'friend@example.com' },
        '123': { ID: 123, LoginName: 'kason@gmail.com' },
      },
    };
    expect(parseTailscaleStatus(shared).account).toBe('kason@gmail.com');
  });

  it('has no account when the user is not listed, has no name, or Self has no UserID', () => {
    expect(
      parseTailscaleStatus({ ...RUNNING, User: { '7': { LoginName: 'x@y' } } }).account,
    ).toBeNull();
    expect(
      parseTailscaleStatus({ ...RUNNING, User: { '123': { LoginName: '' } } }).account,
    ).toBeNull();
    expect(parseTailscaleStatus({ ...RUNNING, User: undefined }).account).toBeNull();
    expect(
      parseTailscaleStatus({ ...RUNNING, Self: { ...RUNNING.Self, UserID: undefined } }).account,
    ).toBeNull();
  });

  it('reads the address from either list, the top-level one first', () => {
    const top = { ...RUNNING, Self: { ...RUNNING.Self, TailscaleIPs: undefined } };
    expect(parseTailscaleStatus(top).address).toBe('100.101.102.103');
    const self = { ...RUNNING, TailscaleIPs: undefined };
    expect(parseTailscaleStatus(self).address).toBe('100.101.102.103');
    const both = {
      ...RUNNING,
      TailscaleIPs: ['100.64.0.1'],
      Self: { TailscaleIPs: ['100.64.0.2'] },
    };
    expect(parseTailscaleStatus(both).address).toBe('100.64.0.1');
    const v6First = { ...RUNNING, TailscaleIPs: ['fd7a::1', '100.64.0.9'] };
    expect(parseTailscaleStatus(v6First).address).toBe('100.64.0.9');
  });

  it('drops the one trailing dot of the DNS name, and an empty name is null', () => {
    const named = (DNSName: string) => parseTailscaleStatus({ Self: { DNSName } }).dnsName;
    expect(named('host.tail1234.ts.net.')).toBe('host.tail1234.ts.net');
    expect(named('host.tail1234.ts.net')).toBe('host.tail1234.ts.net');
    expect(named('')).toBeNull();
    expect(named('.')).toBeNull();
  });

  it('reads null sections as absent', () => {
    expect(parseTailscaleStatus(SIGNED_OUT)).toEqual({
      backendState: 'NeedsLogin',
      ...NO_DETAILS,
    });
  });

  it('lets a wrong-typed field read as absent without voiding the others', () => {
    const changed = {
      BackendState: 'Running',
      TailscaleIPs: '100.101.102.103', // a string where a list used to be
      Self: { DNSName: 42, UserID: '123', TailscaleIPs: ['100.64.0.5'] },
      CurrentTailnet: { Name: 'kason@gmail.com' },
      User: { '123': 'x' },
    };
    expect(parseTailscaleStatus(changed)).toEqual({
      backendState: 'Running',
      address: '100.64.0.5',
      account: null,
      tailnet: 'kason@gmail.com',
      dnsName: null,
    });
    expect(parseTailscaleStatus({ Self: 'x', CurrentTailnet: [], User: [] })).toEqual({
      backendState: null,
      ...NO_DETAILS,
    });
  });

  it.each([null, undefined, 'x', 42, true, []])(
    'answers nothing for %s rather than throwing',
    (json) => {
      expect(parseTailscaleStatus(json)).toEqual({ backendState: null, ...NO_DETAILS });
    },
  );
});
