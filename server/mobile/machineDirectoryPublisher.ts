/**
 * @module machineDirectoryPublisher
 * Plan 18, stage 2: tells this computer's AASC Cloud account where the computer can be tried, so the account's
 * other devices can list it and connect without a pairing link (cloud/machines.ts, `PUT /v1/machines/self`).
 * An address there is a hint: a client trusts what answers only after the sealed exchange of computerEnroll.ts
 * opens with the address it dialled itself, so the cloud vouches for nothing.
 *
 * It publishes while all of these hold, and withdraws (`DELETE`) when one stops holding after it published:
 *  - a usable cloud connection (one that is gone or revoked is never asked anything);
 *  - "Show this computer to my account" is on (machineAccountSettings.ts);
 *  - a computer could connect here at all: pairing is offered and a dashboard password is set;
 *  - there is an address to give: the home-network one, the Tailscale one and, only when "Public IP" is
 *    ticked, the public one, each from the pairing target (the one source the pairing link and /paths use).
 *
 * It asks only when something changed (an address, the port, a tick, the account). The account it last published
 * to is remembered across restarts (`remembered`), so a computer that never published makes no request, and one
 * whose setting was turned off while it was down still withdraws at its first check. A refusal for good (403: a
 * sign-in from before the backend listed computers; 404: a backend without the service) is remembered for that
 * account and not retried on a timer. Any other failure is `failed` and tried again at the next check.
 *
 * `check()` and `withdraw()` never reject and `view()` never throws. Nothing here logs an address or an account.
 */
import { publishMachinePaths, withdrawMachinePaths } from '../cloud/machines.js';
import { CloudError, type CloudConnector } from '../cloud/types.js';
import { isPrivateLanAddress, isPublicAddress, isTailnetAddress } from '../networkInfo.js';
import { cloudIdentity } from './cloudReadLog.js';
import type { MachineAccountSettings } from './machineAccountSettings.js';

/** How often it looks again: for a changed address, a new account, or a failure to retry. */
export const DIRECTORY_CHECK_MS = 60_000;
/** A sign-out waits this long, at most, for the withdraw before it. */
const SIGN_OUT_WITHDRAW_MS = 3_000;
/** Link-local, and never a computer's own. */
const CLOUD_METADATA_ADDRESS = '169.254.169.254';

export type DirectoryState =
  /** No check has finished yet (or none for the account now signed in). */
  | 'pending'
  | 'no-cloud'
  /** "Show this computer to my account" is off. */
  | 'off'
  /** No computer could connect here: pairing is off on this computer. */
  | 'pairing-off'
  /** No computer could connect here: no dashboard password is set, so every device route refuses. */
  | 'no-password'
  /** Every address is unticked, or this computer has none of the ticked kinds right now. */
  | 'no-address'
  | 'published'
  /** The backend answered 403: this computer signed in before computers were listed. */
  | 'needs-sign-in'
  /** The backend answered 404: it has no machine directory. */
  | 'unsupported'
  | 'failed';

export interface DirectoryView {
  state: DirectoryState;
  /** What the account last accepted, while `published`. */
  lan: string | null;
  tailnet: string | null;
  public: string | null;
  port: number | null;
  at: number | null;
}

/** Where this computer is: the pairing target's shape (pairingTarget.ts). */
export interface DirectoryTarget {
  lan: string | null;
  tailnet: string | null;
  publicAddress?: string | null;
  port: number;
}

export interface MachineDirectoryDeps {
  cloud: Pick<CloudConnector, 'client' | 'status'>;
  settings: () => MachineAccountSettings;
  /** Why no computer could connect here at all, or null when one could. Read on every check. */
  unreachable: () => Unreachable | null;
  /** The pairing target: the one source of this computer's addresses (never a second probe). */
  target: () => Promise<DirectoryTarget>;
  /** The account this computer last published to, kept across restarts; null when it is in no directory. */
  remembered: { get(): string | null; set(account: string | null): void };
  now?: () => number;
  log: { warn(message: string): void; debug(message: string): void };
}

export interface DirectoryCheckOptions {
  /** Also ask an account that refused before (403, 404): a changed setting or a new sign-in, never a timer tick. */
  retryRefused?: boolean;
}

export interface MachineDirectoryPublisher {
  /** Check once at once, then every `DIRECTORY_CHECK_MS`. The timer never keeps the process alive. */
  start(): void;
  stop(): void;
  /** One check at a time: one asked for while another runs waits for it, then looks again. Never rejects. */
  check(options?: DirectoryCheckOptions): Promise<DirectoryView>;
  /** Before a sign-out: leave the directory if this computer is in it. Never rejects, never waits long. */
  withdraw(): Promise<void>;
  /**
   * What the last check found, without starting one. `pending` (and no address) before the first check, and
   * while the publisher is still acting on a saved setting, a sign-in or a change it found.
   */
  view(): DirectoryView;
}

type Refusal = Extract<DirectoryState, 'needs-sign-in' | 'unsupported'>;
/** Why no computer could connect here: nothing is published then, since it would tell the cloud an address for nothing. */
export type Unreachable = Extract<DirectoryState, 'pairing-off' | 'no-password'>;
type Quiet = Extract<DirectoryState, 'off' | 'no-address'> | Unreachable;
/** The addresses this computer tells its account, each null when it is not told. */
export interface DirectoryAddresses { lan: string | null; tailnet: string | null; public: string | null; port: number }
type Published = DirectoryAddresses;

/**
 * What this computer would publish from `target` under `settings`: the addresses the ticks allow, each only
 * when it is of its kind. One rule for what is sent to the directory and for which addresses an answer may be
 * bound to by its Host (machineAccountWiring.ts), so the two can never name different addresses. It does not
 * look at "Show this computer to my account" or at the cloud: the callers do.
 */
export function directoryAddresses(target: DirectoryTarget, settings: MachineAccountSettings): DirectoryAddresses {
  const lan = settings.addresses.lan && target.lan && isPrivateLanAddress(target.lan)
    && target.lan !== CLOUD_METADATA_ADDRESS ? target.lan : null;
  const tailnet = settings.addresses.tailnet && target.tailnet && isTailnetAddress(target.tailnet) ? target.tailnet : null;
  const publicAddress = settings.addresses.public && target.publicAddress && isPublicAddress(target.publicAddress)
    ? target.publicAddress : null;
  return { lan, tailnet, public: publicAddress, port: target.port };
}

const REFUSAL_ADVICE: Record<Refusal, string> = {
  'needs-sign-in':
    'This computer can’t show itself to its AASC Cloud account (the backend answered 403). '
    + 'Sign out of AASC Cloud and sign in again.',
  unsupported: 'AASC Cloud doesn’t list computers yet (the backend answered 404). Update the backend.',
};

function refusalOf(err: unknown): Refusal | null {
  if (!(err instanceof CloudError)) return null;
  if (err.code === 'forbidden' && err.status === 403) return 'needs-sign-in';
  if (err.code === 'not_found' && err.status === 404) return 'unsupported';
  return null;
}

/** A CloudError's code is a fixed word; anything else is a local fault, named only by its kind. */
const reasonOf = (err: unknown): string => (err instanceof CloudError ? err.code : 'error');

const view = (state: DirectoryState, published: (Published & { at: number }) | null = null): DirectoryView => ({
  state,
  lan: published?.lan ?? null,
  tailnet: published?.tailnet ?? null,
  public: published?.public ?? null,
  port: published?.port ?? null,
  at: published?.at ?? null,
});

const same = (a: Published, b: Published): boolean =>
  a.lan === b.lan && a.tailnet === b.tailnet && a.public === b.public && a.port === b.port;

export function createMachineDirectoryPublisher(deps: MachineDirectoryDeps): MachineDirectoryPublisher {
  const { cloud, log } = deps;
  const now = deps.now ?? Date.now;

  /** What the account last accepted from this process. */
  let shared: (Published & { account: string; at: number }) | null = null;
  /** A refusal for good, remembered for one account. */
  let refused: { account: string; state: Refusal } | null = null;
  /** How the last check ended, and for which account. */
  let settled: { account: string; view: DirectoryView } | null = null;
  let checked = false;
  /**
   * True while the publisher is acting on something `settled` does not show yet: an ask from outside (a saved
   * setting, a sign-in) from the moment it is made, or a change a timer check found, from the moment it tells
   * the cloud. The view reads `pending` then, with no address: what the account held before the change must
   * never read as the outcome (an address the owner has just unticked would look still published). A timer
   * check that finds nothing to send never sets it, so the settled finding stands while it looks.
   */
  let acting = false;
  /** The kind of failure last warned about, so a long outage says so once. */
  let warnedFailure: string | null = null;
  let inFlight: Promise<DirectoryView> | null = null;
  /** The check waiting for the running one to end; asks made meanwhile share it. */
  let queued: Promise<DirectoryView> | null = null;
  /** Does one of those asks want a remembered refusal retried? */
  let queuedRetries = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** The account a request would go to, or null when there is none worth asking. */
  function usableAccount(): string | null {
    const status = cloud.status();
    // A saved connection nothing has checked yet reads 'offline' after a restart: the request is what checks it.
    return status.state === 'revoked' || status.state === 'disconnected' ? null : cloudIdentity(status.connection);
  }

  /** Is this computer in `account`'s directory, as far as it knows (this process, or one before it)? */
  const inDirectory = (account: string): boolean => shared?.account === account || deps.remembered.get() === account;

  function noteFailure(err: unknown): void {
    const kind = reasonOf(err);
    const message = `Could not update this computer in its AASC Cloud account's directory (${kind}); trying again every minute`;
    if (kind === warnedFailure) log.debug(message);
    else log.warn(message);
    warnedFailure = kind;
  }

  /** A failed request as a state: a refusal for good is remembered, anything else is tried again. */
  function rejected(account: string, err: unknown): Extract<DirectoryState, Refusal | 'failed'> {
    const refusal = refusalOf(err);
    if (!refusal) {
      noteFailure(err);
      return 'failed';
    }
    if (refused?.account !== account || refused.state !== refusal) log.warn(REFUSAL_ADVICE[refusal]);
    refused = { account, state: refusal };
    warnedFailure = null;
    return refusal;
  }

  function forget(account: string): void {
    if (shared?.account === account) shared = null;
    if (deps.remembered.get() === account) deps.remembered.set(null);
  }

  /** Nothing is to be published: leave the directory if this computer is in it. */
  async function leave(account: string, why: Quiet, options: DirectoryCheckOptions): Promise<DirectoryView> {
    if (!inDirectory(account)) return view(why);
    if (refused?.account === account && !options.retryRefused) return view(why);
    acting = true;
    try {
      await withdrawMachinePaths(cloud.client);
    } catch (err) {
      // A refusal for good means the backend holds nothing this computer could take back: say why it is quiet.
      return rejected(account, err) === 'failed' ? view('failed') : view(why);
    }
    forget(account);
    warnedFailure = null;
    return view(why);
  }

  async function publish(account: string, options: DirectoryCheckOptions): Promise<DirectoryView> {
    const want = directoryAddresses(await deps.target(), deps.settings());
    if (!want.lan && !want.tailnet && !want.public) return leave(account, 'no-address', options);
    if (shared?.account === account && same(shared, want)) return view('published', shared);
    if (refused?.account === account && !options.retryRefused) return view(refused.state);
    acting = true;
    try {
      await publishMachinePaths(cloud.client, want);
    } catch (err) {
      return view(rejected(account, err));
    }
    shared = { ...want, account, at: now() };
    deps.remembered.set(account);
    refused = null;
    warnedFailure = null;
    return view('published', shared);
  }

  async function run(options: DirectoryCheckOptions): Promise<DirectoryView> {
    let account: string | null = null;
    let result: DirectoryView;
    try {
      account = usableAccount();
      const unreachable = account === null ? null : deps.unreachable();
      if (account === null) result = view('no-cloud');
      else if (!deps.settings().showOnAccount) result = await leave(account, 'off', options);
      else if (unreachable) result = await leave(account, unreachable, options);
      else result = await publish(account, options);
    } catch (err) {
      // A fault in a dependency, not an answer from the cloud.
      noteFailure(err);
      result = view('failed');
    }
    checked = true;
    settled = account === null ? null : { account, view: result };
    return result;
  }

  /** `fromTimer`: the periodic look, which nobody asked for and which usually finds nothing to do. */
  function ask(options: DirectoryCheckOptions, fromTimer: boolean): Promise<DirectoryView> {
    if (!fromTimer) acting = true;
    if (inFlight) {
      // A tick that meets a running check shares it: the next one is a minute away.
      if (fromTimer) return inFlight;
      // What is running read the settings before this ask: look again once it ends. (`ask` again, not `run`:
      // something else may have started meanwhile.) Asks that arrive while waiting share that one look; one of
      // them wanting a refusal retried is enough for all.
      if (options.retryRefused === true) queuedRetries = true;
      queued ??= inFlight
        .catch(() => undefined)
        .then(() => {
          queued = null;
          const retryRefused = queuedRetries;
          queuedRetries = false;
          return ask({ retryRefused }, false);
        });
      return queued;
    }
    inFlight = run(options).finally(() => {
      inFlight = null;
      // Settled, whatever the outcome, unless an ask is still waiting its turn: never a `pending` that stays.
      if (queued === null) acting = false;
    });
    return inFlight;
  }

  const check = (options: DirectoryCheckOptions = {}): Promise<DirectoryView> => ask(options, false);

  return {
    start() {
      if (timer) return;
      void check();
      timer = setInterval(() => void ask({}, true), DIRECTORY_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
    async withdraw() {
      try {
        const account = usableAccount();
        if (account === null || !inDirectory(account)) return;
        await withdrawMachinePaths(cloud.client, AbortSignal.timeout(SIGN_OUT_WITHDRAW_MS));
        forget(account);
      } catch (err) {
        log.warn(`Could not take this computer out of its AASC Cloud account's directory before signing out (${reasonOf(err)})`);
      }
    },
    view() {
      try {
        if (!checked) return view('pending');
        const account = usableAccount();
        if (account === null) return view('no-cloud');
        if (acting) return view('pending');
        return settled?.account === account ? settled.view : view('pending');
      } catch {
        return view('failed');
      }
    },
  };
}

/**
 * The connector every sign-in and sign-out goes through (the cloud routes and Sign in with Google, server/index.ts),
 * with the directory following it: this computer publishes right after connecting (never holding the sign-in up)
 * and leaves the directory before disconnecting, while its token can still say so. A sign-out never waits long
 * on, or fails with, the withdraw.
 *
 * Signing in again while a connection is in use swaps this computer's backend device. The device it is about to
 * stop being would otherwise stay in the account's directory with addresses nobody updates, so it leaves first,
 * with its own token. If the sign-in then fails, the old connection is still this computer's and it publishes
 * again.
 */
export function withMachineDirectory(
  cloud: CloudConnector,
  publisher: Pick<MachineDirectoryPublisher, 'check' | 'withdraw'>,
): CloudConnector {
  return {
    ...cloud,
    async connectCloud(input) {
      const before = cloud.status();
      const inUse = before.connection !== null && before.state !== 'revoked' && before.state !== 'disconnected';
      if (inUse) {
        try {
          await publisher.withdraw(); // at most a few seconds, and nothing when this computer is not listed
        } catch {
          // The sign-in goes ahead.
        }
      }
      const publishAgain = (): void => void publisher.check({ retryRefused: true }).catch(() => undefined);
      let connection: Awaited<ReturnType<CloudConnector['connectCloud']>>;
      try {
        connection = await cloud.connectCloud(input);
      } catch (error) {
        if (inUse) publishAgain(); // still the old device: back into the directory it just left
        throw error;
      }
      publishAgain();
      return connection;
    },
    async disconnectCloud() {
      try {
        await publisher.withdraw();
      } catch {
        // The sign-out goes ahead. An address left behind is only a hint: asked there, this computer answers
        // that it is not the one the ticket names.
      }
      await cloud.disconnectCloud();
    },
  };
}
