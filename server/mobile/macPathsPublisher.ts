/**
 * @module macPathsPublisher
 * AASC-60 (Remote access): tells this Mac's AASC Cloud account where the Mac can be found on
 * Tailscale, so a phone away from home can look it up. Only `{ tailnet, port }` is sent
 * (cloud/macPaths.ts). The phone opens what it learns that way only after the Mac there proves it
 * holds that phone's key, so the cloud vouches for nothing.
 *
 * It asks only while a phone could use the Mac (the rule Bonjour follows), and only when something
 * changed: the address, the port or the cloud account. Besides sharing it, a check can end in:
 *  - nothing to tell yet: no phone could use this Mac, no cloud connection, no Tailscale address;
 *  - the account refused (403: paired without the `mac-paths:publish` scope) or its backend has no
 *    such service (404): remembered for that account with one warning, so a refusal is never
 *    retried against the backend's mutation limit. A new account, or the owner's "Check again",
 *    asks again (a press made while a timer check is running waits for it, then asks);
 *  - any other failure (offline, a backend fault): `failed`, tried again at the next check.
 *
 * `check()` never rejects and `view()` never throws: a cloud fault is a state to show.
 */
import type { PublishState, PublishView } from '../../src/types/remoteAccess.js';
import { publishMacPaths } from '../cloud/macPaths.js';
import { CloudError, type CloudConnector } from '../cloud/types.js';
import { isTailnetAddress } from '../networkInfo.js';
import { cloudIdentity } from './cloudReadLog.js';

/** How often the Mac looks again: for a changed address, a new account, or a failure to retry. */
export const PUBLISH_CHECK_MS = 60_000;

export interface MacPathsPublisherDeps {
  cloud: Pick<CloudConnector, 'client' | 'status'>;
  /** This Mac's Tailscale address, or null when it has none (the probe's `status().address`). */
  tailnet: () => Promise<string | null>;
  /** The port this Mac's AASC listens on. */
  port: number;
  /** Could a phone use this Mac: `shouldAdvertise({ passwordEnabled, pairingOffered, activePhones })`. Read on every check. */
  phonesCouldUse: () => boolean;
  /** The clock, in ms, for the time of the last share. Default: `Date.now`. */
  now?: () => number;
  log: { warn(message: string): void; debug(message: string): void };
}

export interface CheckOptions {
  /** "Check again": also ask an account that refused before (403, 404). A timer tick never does. */
  retryRefused?: boolean;
}

export interface MacPathsPublisher {
  /** Check once at once, then every `PUBLISH_CHECK_MS`. The timer never keeps the process alive. */
  start(): void;
  /** Ends the timer. A check already running finishes; at shutdown `cloud.stop()` aborts its request. */
  stop(): void;
  /**
   * One check at a time: callers that arrive while one runs share it, except a "Check again" meeting a check
   * that does not retry refusals, which runs its own right after. Never rejects.
   */
  check(options?: CheckOptions): Promise<PublishView>;
  /** What the last check found, never throws. `pending` until the first check has finished. */
  view(): PublishView;
}

/** Why a check had nothing to ask: settled without looking at Tailscale or the cloud. */
type Early = Extract<PublishState, 'not-needed' | 'no-cloud'>;
/** How a check that got as far as the cloud account ended. */
type Verdict = Extract<
  PublishState,
  'no-tailscale' | 'published' | 'forbidden' | 'unsupported' | 'failed'
>;
type Refusal = Extract<Verdict, 'forbidden' | 'unsupported'>;

const REFUSAL_ADVICE: Record<Refusal, string> = {
  forbidden:
    "This Mac's cloud link can't share its Tailscale address (the backend answered 403). " +
    'Make a new pairing code that lists mac-paths:publish, then connect again.',
  unsupported:
    "AASC Cloud doesn't offer Remote access addresses yet (the backend answered 404). " +
    'Update the backend, then press Check again.',
};

/** The refusals the cloud gives for good: a 403, and the standard not-found for a service it lacks. */
function refusalOf(err: unknown): Refusal | null {
  if (!(err instanceof CloudError)) return null;
  if (err.code === 'forbidden' && err.status === 403) return 'forbidden';
  if (err.code === 'not_found' && err.status === 404) return 'unsupported';
  return null;
}

/** A CloudError's code is a fixed word; anything else is a local fault whose message is all there is. */
const reasonOf = (err: unknown): string =>
  err instanceof CloudError ? err.code : err instanceof Error ? err.message : String(err);

export function createMacPathsPublisher(deps: MacPathsPublisherDeps): MacPathsPublisher {
  const { cloud, port, log } = deps;
  const now = deps.now ?? Date.now;

  /** What the cloud last accepted. Kept across a spell without Tailscale: the same address again is no change. */
  let shared: { account: string; tailnet: string; port: number; at: number } | null = null;
  /** A refusal, remembered for one account. */
  let refused: { account: string; state: Refusal } | null = null;
  /** How the last check that got as far as an account ended, and for which one. */
  let settled: { account: string; state: Verdict } | null = null;
  /** Has any check finished. Until one has, the page reads `pending`. */
  let checked = false;
  /** The kind of failure last warned about, so a long outage says so once. Null after a success or a refusal. */
  let warnedFailure: string | null = null;
  let inFlight: Promise<PublishView> | null = null;
  /** Does the running check retry a remembered refusal (a "Check again"), or honour it (the timer's)? */
  let inFlightRetries = false;
  /** The "Check again" waiting for the running check to end: presses made meanwhile share it. */
  let queuedRetry: Promise<PublishView> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** `account` is the one the view is about: the address and time last shared with it, if any. */
  const viewOf = (state: PublishState, account: string | null): PublishView => {
    const last = account !== null && shared?.account === account ? shared : null;
    return { state, tailnet: last?.tailnet ?? null, port, at: last?.at ?? null };
  };

  /** What can be settled without asking Tailscale or the cloud: nothing to do, or the account to tell. */
  function readiness(): { early: Early } | { account: string } {
    if (!deps.phonesCouldUse()) return { early: 'not-needed' };
    const status = cloud.status();
    // A saved connection nothing has checked yet reads 'offline' after a restart, and a failed request leaves it
    // 'offline' too. The request is what checks it, so only a connection that is gone or revoked is not worth asking.
    const account =
      status.state === 'revoked' || status.state === 'disconnected'
        ? null
        : cloudIdentity(status.connection);
    return account === null ? { early: 'no-cloud' } : { account };
  }

  const isShared = (account: string, address: string): boolean =>
    shared !== null &&
    shared.account === account &&
    shared.tailnet === address &&
    shared.port === port;

  function noteFailure(err: unknown): void {
    const kind = err instanceof CloudError ? err.code : 'error';
    const message = `Could not share the Tailscale address with AASC Cloud (${reasonOf(err)}); trying again every minute`;
    // Said once when a kind of failure starts, not every minute while it goes on.
    if (kind === warnedFailure) log.debug(message);
    else log.warn(message);
    warnedFailure = kind;
  }

  function rejected(account: string, err: unknown): Verdict {
    const refusal = refusalOf(err);
    if (!refusal) {
      noteFailure(err);
      return 'failed';
    }
    // "Check again" meeting the refusal it already knows has nothing new to say.
    if (refused?.account !== account || refused.state !== refusal)
      log.warn(REFUSAL_ADVICE[refusal]);
    refused = { account, state: refusal };
    warnedFailure = null;
    return refusal;
  }

  async function send(account: string, address: string): Promise<Verdict> {
    try {
      await publishMacPaths(cloud.client, { tailnet: address, port });
    } catch (err) {
      return rejected(account, err);
    }
    shared = { account, tailnet: address, port, at: now() };
    refused = null;
    warnedFailure = null;
    return 'published';
  }

  async function decide(account: string, options: CheckOptions): Promise<Verdict> {
    const address = await deps.tailnet();
    // Only a Tailscale address is ever shared: anything else is as good as none.
    if (address === null || !isTailnetAddress(address)) return 'no-tailscale';
    if (isShared(account, address)) return 'published';
    if (refused?.account === account && !options.retryRefused) return refused.state;
    return send(account, address);
  }

  function concluded(account: string, state: Verdict): PublishView {
    checked = true;
    settled = { account, state };
    return viewOf(state, account);
  }

  /** A fault in a dependency, not an answer from the cloud: `failed`, and the next check tries again. */
  function unexpected(account: string | null, err: unknown): PublishView {
    noteFailure(err);
    if (account !== null) return concluded(account, 'failed');
    checked = true;
    return viewOf('failed', null);
  }

  async function run(options: CheckOptions): Promise<PublishView> {
    let account: string | null = null;
    try {
      const ready = readiness();
      if ('early' in ready) {
        checked = true;
        return viewOf(ready.early, null);
      }
      account = ready.account;
      return concluded(account, await decide(account, options));
    } catch (err) {
      return unexpected(account, err);
    }
  }

  function check(options: CheckOptions = {}): Promise<PublishView> {
    const retries = options.retryRefused === true;
    if (inFlight && (inFlightRetries || !retries)) return inFlight;
    if (inFlight) {
      // A press of "Check again" meeting a check that honours the remembered refusal (the timer's): joining it
      // would answer "unsupported" to the very press meant to find out whether that still holds. Wait for it, then
      // retry, so there is still one check at a time. (`check` again, not `run`: something may have started meanwhile.)
      queuedRetry ??= inFlight
        .catch(() => undefined) // a check never rejects; were it to, the press must not wait on it for good
        .then(() => {
          queuedRetry = null;
          return check(options);
        });
      return queuedRetry;
    }
    inFlightRetries = retries;
    inFlight = run(options).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function view(): PublishView {
    try {
      if (!checked) return viewOf('pending', null);
      // Whether anyone needs this and whether there is a cloud are read live, so the page follows a disconnect or a
      // first pairing at once. What a check found about an account is an answer about that account only.
      const ready = readiness();
      if ('early' in ready) return viewOf(ready.early, null);
      return settled?.account === ready.account
        ? viewOf(settled.state, ready.account)
        : viewOf('pending', null);
    } catch (err) {
      log.debug(`Could not read the Remote access sharing state (${reasonOf(err)})`);
      return viewOf('failed', null);
    }
  }

  return {
    start() {
      if (timer) return;
      void check();
      timer = setInterval(() => void check(), PUBLISH_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    check,
    view,
  };
}
