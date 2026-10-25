/**
 * @module tailscaleStatus
 * AASC-60 (Remote access): what this Mac knows about its own Tailscale, for the RESOURCES ->
 * Cloud -> Remote access view and for the tailnet address the Mac publishes to its AASC Cloud
 * account.
 *
 * Two sources:
 *  1. The Tailscale CLI. `status --json` names the backend state (running, signed out, switched
 *     off, ...), the account, the tailnet, this Mac's DNS name and its Tailscale addresses.
 *     Tailscale documents that output as "format subject to change", so every field is read
 *     leniently: a field of the wrong type reads as absent, and never takes the rest of the
 *     answer down with it. It is the authority whenever its answer parses and names a known
 *     `BackendState`: the address is then the first IPv4 in 100.64.0.0/10 it lists for this Mac
 *     (none if it lists none), and no interface is consulted.
 *  2. The network interface (`getTailnetIP`: the first 100.64.0.0/10 address an interface holds).
 *     It stands in when there is no usable CLI answer: no CLI installed (a 100.64.0.0/10
 *     interface then means the Mac is on a tailnet, whatever manages it, say a `tailscaled`
 *     whose CLI lives somewhere this module does not look), or a CLI that fails, times out,
 *     prints nothing or something unreadable, or names a state this code does not know (R26: a
 *     future output format must not make every page read "installed but not running"). That
 *     range is shared with other software (Cloudflare WARP, NordVPN Meshnet, a carrier-grade-NAT
 *     LAN lease), so in these cases the address is the interface's best guess, nothing more.
 *
 * The CLI runs through async `execFile` only (a 3 s timeout, `TAILSCALE_BE_CLI=1`, which makes
 * the macOS app binary behave as the CLI), never synchronously: a probe must not block the event
 * loop. A probe never rejects; the worst answer is `not-installed` or `not-running`.
 */
import { execFile } from 'child_process';
import { access } from 'fs/promises';
import { promisify } from 'util';
import { z } from 'zod';
import type { TailscaleState, TailscaleStatus } from '../src/types/remoteAccess.js';
import log from './logger.js';
import { getTailnetIP, isTailnetAddress } from './networkInfo.js';

export const TAILSCALE_PROBE_TIMEOUT_MS = 3_000;
export const TAILSCALE_CACHE_MS = 5_000;

/** Room for the status of a large tailnet; only a runaway child is cut off by it. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** Where each platform's Tailscale CLI lives, the one to prefer first. */
export const TAILSCALE_CLI_PATHS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: [
    // The App Store app; the standalone app bundles the CLI here too.
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    // The standalone app's "Install CLI".
    '/usr/local/bin/tailscale',
    // Homebrew.
    '/opt/homebrew/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
  win32: ['C:\\Program Files\\Tailscale\\tailscale.exe'],
};

export interface TailscaleProbeDeps {
  /** Whose CLI locations to look in. Default: this process's platform. */
  platform?: NodeJS.Platform;
  /** Is there a file at this path? Default: `fs.promises.access`. */
  exists?: (path: string) => Promise<boolean>;
  /**
   * Run a program and resolve with its stdout; reject on a non-zero exit. Default: a promisified
   * `execFile`, whose rejection carries the stdout the program printed before it failed.
   */
  run?: (
    file: string,
    args: string[],
    opts: { timeout: number; env: NodeJS.ProcessEnv; maxBuffer: number },
  ) => Promise<{ stdout: string }>;
  /** This Mac's Tailscale interface address, or null. Default: `getTailnetIP`. */
  interfaceAddress?: () => string | null;
  /** The clock, in ms, for the cache. Default: `Date.now`. */
  now?: () => number;
}

type ParsedStatus = Omit<TailscaleStatus, 'state'> & { backendState: string | null };

/**
 * A field of the wrong type (or null, which is how Go writes a section it has nothing for) reads
 * as absent, so a field a newer Tailscale changed costs only itself.
 */
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/** Entries are checked one by one later: a list may mix IPv4, IPv6 and whatever comes next. */
const addressList = lenient(z.array(z.unknown()));

const statusSchema = z.object({
  BackendState: lenient(z.string()),
  TailscaleIPs: addressList,
  Self: lenient(
    z.object({
      DNSName: lenient(z.string()),
      UserID: lenient(z.number()),
      TailscaleIPs: addressList,
    }),
  ),
  CurrentTailnet: lenient(z.object({ Name: lenient(z.string()) })),
  // Keyed by the numeric user id, written as a string.
  User: lenient(z.record(z.string(), lenient(z.object({ LoginName: lenient(z.string()) })))),
});

/**
 * Read a `tailscale status --json` document. Total: whatever is not there, or not what it used
 * to be, comes back null, and a document that is not an object reads as empty.
 */
export function parseTailscaleStatus(json: unknown): ParsedStatus {
  const parsed = statusSchema.safeParse(json);
  if (!parsed.success) {
    return { backendState: null, address: null, account: null, tailnet: null, dnsName: null };
  }
  const { BackendState, TailscaleIPs, Self, CurrentTailnet, User } = parsed.data;
  const userId = Self?.UserID;
  const loginName = userId === undefined ? undefined : User?.[String(userId)]?.LoginName;
  return {
    backendState: BackendState || null,
    address: firstTailnetAddress([...(TailscaleIPs ?? []), ...(Self?.TailscaleIPs ?? [])]),
    account: loginName || null,
    tailnet: CurrentTailnet?.Name || null,
    dnsName: Self?.DNSName?.replace(/\.$/, '') || null,
  };
}

/** The first IPv4 in 100.64.0.0/10; Tailscale lists IPv6 addresses alongside. */
function firstTailnetAddress(candidates: readonly unknown[]): string | null {
  const found = candidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && isTailnetAddress(candidate),
  );
  return found ?? null;
}

/** The state a `BackendState` names, or null for a value this code does not know. */
function stateOf(backendState: string | null): TailscaleState | null {
  switch (backendState) {
    case 'Running':
      return 'connected';
    case 'NeedsLogin':
    case 'NeedsMachineAuth':
      return 'signed-out';
    case 'Stopped':
      return 'stopped';
    case 'Starting':
    case 'NoState':
      return 'not-running';
    default:
      return null;
  }
}

/**
 * The state when the CLI named none (missing, silent, or an answer this code cannot read): a
 * tailnet interface means connected whatever manages it; otherwise an installed CLI that says
 * nothing is not running, and no CLI at all is not installed.
 */
function stateWithoutCliAnswer(hasCli: boolean, interfaceUp: boolean): TailscaleState {
  if (interfaceUp) return 'connected';
  return hasCli ? 'not-running' : 'not-installed';
}

const execFileAsync = promisify(execFile);

const runProgram: NonNullable<TailscaleProbeDeps['run']> = (file, args, opts) =>
  execFileAsync(file, args, opts);

const fileExists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The stdout a failed `execFile` printed before it failed; '' when there is none. */
function stdoutOf(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('stdout' in err)) return '';
  return typeof err.stdout === 'string' ? err.stdout : '';
}

/**
 * A cached, de-duplicated reader of this Mac's Tailscale state. The Remote access view and the
 * cloud publisher both ask often; they share one CLI run per `TAILSCALE_CACHE_MS`, and calls
 * that overlap share the run that is already going.
 */
export function createTailscaleProbe(deps: TailscaleProbeDeps = {}): {
  status(opts?: { fresh?: boolean }): Promise<TailscaleStatus>;
} {
  const platform = deps.platform ?? process.platform;
  const exists = deps.exists ?? fileExists;
  const run = deps.run ?? runProgram;
  const interfaceAddress = deps.interfaceAddress ?? getTailnetIP;
  const now = deps.now ?? (() => Date.now());

  /** The first CLI of this platform that is installed, or null. */
  async function findCli(): Promise<string | null> {
    for (const path of TAILSCALE_CLI_PATHS[platform] ?? []) {
      try {
        if (await exists(path)) return path;
      } catch (err) {
        log.debug('tailscale', `could not check ${path} (${reasonOf(err)})`);
      }
    }
    return null;
  }

  /** What `status --json` printed, whether it then exited 0 or not; '' when it printed nothing. */
  async function printedStatus(cli: string): Promise<string> {
    try {
      const { stdout } = await run(cli, ['status', '--json'], {
        timeout: TAILSCALE_PROBE_TIMEOUT_MS,
        env: { ...process.env, TAILSCALE_BE_CLI: '1' },
        maxBuffer: MAX_STDOUT_BYTES,
      });
      return typeof stdout === 'string' ? stdout : '';
    } catch (err) {
      // A Tailscale that is switched off can exit non-zero and still print its status.
      log.debug('tailscale', `status --json failed (${reasonOf(err)})`);
      return stdoutOf(err);
    }
  }

  /** The CLI's status, parsed; null when it printed nothing readable. */
  async function readCliStatus(cli: string): Promise<ParsedStatus | null> {
    const stdout = await printedStatus(cli);
    if (!stdout.trim()) return null;
    try {
      return parseTailscaleStatus(JSON.parse(stdout));
    } catch (err) {
      log.debug('tailscale', `status --json did not print JSON (${reasonOf(err)})`);
      return null;
    }
  }

  function tailnetInterface(): string | null {
    try {
      return interfaceAddress();
    } catch (err) {
      log.debug('tailscale', `could not read the network interfaces (${reasonOf(err)})`);
      return null;
    }
  }

  async function probeOnce(): Promise<TailscaleStatus> {
    const cli = await findCli();
    const reported = cli ? await readCliStatus(cli) : null;
    const named = reported ? stateOf(reported.backendState) : null;
    // R26: the CLI is authoritative only when its answer parses and names a known state, and then no interface
    // is read (WARP, Meshnet or a CGNAT lease can hold a 100.64.0.0/10 address of their own). Any other
    // outcome is no usable CLI answer, and the interface stands in as it does without a CLI.
    const viaInterface = named === null ? tailnetInterface() : null;
    // Frozen: the same object goes to every caller until the cache expires.
    return Object.freeze({
      state: named ?? stateWithoutCliAnswer(cli !== null, viaInterface !== null),
      address: named === null ? (viaInterface ?? reported?.address ?? null) : (reported?.address ?? null),
      account: reported?.account ?? null,
      tailnet: reported?.tailnet ?? null,
      dnsName: reported?.dnsName ?? null,
    });
  }

  let cached: { at: number; result: TailscaleStatus } | null = null;
  /** A negative age is a clock set back since: that answer is of unknown age, so it is not fresh. */
  function isFresh(at: number): boolean {
    const age = now() - at;
    return age >= 0 && age < TAILSCALE_CACHE_MS;
  }
  let inFlight: Promise<TailscaleStatus> | null = null;

  return {
    status(opts: { fresh?: boolean } = {}): Promise<TailscaleStatus> {
      if (!opts.fresh && cached && isFresh(cached.at)) return Promise.resolve(cached.result);
      // A fresh request joins a probe that is already running (it started moments ago) rather
      // than racing a second CLI against it.
      inFlight ??= probeOnce()
        .then((result) => {
          cached = { at: now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
