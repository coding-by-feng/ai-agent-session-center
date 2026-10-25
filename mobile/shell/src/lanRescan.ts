// lanRescan.ts — find a paired Mac again after its home-network address changed, without pairing again.
//
// signInAndOpen runs this when every saved path failed, or the saved home
// address answered as someone else's AASC, for an approved Mac the user allowed
// the home network for. Addresses come from Bonjour first (`_aasc._tcp`, which
// the Mac advertises: server/mobile/lanAdvertiser.ts; native, phones only), then
// from a sweep of the saved address's /24 while the phone is on that network,
// which covers a new DHCP lease. Anything may answer on the port, so an address
// is used only once the Mac there proves it holds this phone's key, over that
// address (verifyMac): another AASC, a relay, or anything else is never saved
// or opened.
//
// `answersAsAasc`, `withinMs` and `whenCancelled` are shared with cloudFind.ts, which looks for the Mac the same way
// (answer, then proof) at the addresses AASC Cloud lists.
import type { ShellDeps } from './native.js';
import { verifyMac, type MacCredentials } from './pairingClient.js';
import { isPrivateLanAddress } from './pairingLink.js';
import { field } from './http.js';

/** Probes in flight at once: 254 addresses in about 8 rounds. */
export const SWEEP_CONCURRENCY = 32;
/** Per address: a Mac on the LAN answers in milliseconds; a missing host never does. */
export const SWEEP_PROBE_MS = 800;
/** How long the Bonjour browse listens. */
export const DISCOVERY_MS = 2_000;
/** The whole browse, resolving included: past it the sweep goes on without Bonjour (a crowd of fake services can't stall it). */
export const BROWSE_BUDGET_MS = DISCOVERY_MS + 3_000;
/** How often a running search checks whether the user moved on. */
const CANCEL_POLL_MS = 50;
/** The identify round trip, once an address has answered. */
export const IDENTIFY_MS = 3_000;

/** One `_aasc._tcp` service as the native browse resolved it. */
export interface FoundService {
  host: string;
  port: number;
}

/** The native browse's answer: the services, and the phone's own IPv4 addresses when it can tell. */
export interface BrowseResult {
  services: FoundService[];
  local?: string[];
}

const slash24 = (ip: string) => ip.split('.').slice(0, 3).join('.');

/**
 * Is the phone on the saved address's network (one of its addresses in the same
 * /24)? A phone that can't tell (`local` absent) is taken to be, as before it could.
 */
export function onSubnet(lan: string | null, local: readonly string[] | undefined): boolean {
  if (!isPrivateLanAddress(lan)) return false;
  return local === undefined || local.some((ip) => isPrivateLanAddress(ip) && slash24(ip) === slash24(lan!));
}

/** Every other address in the saved address's /24 (.1 to .254); nothing for one that isn't private. */
export function sweepHosts(lan: string | null): string[] {
  if (!isPrivateLanAddress(lan)) return [];
  const prefix = slash24(lan!);
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i += 1) {
    const host = `${prefix}.${i}`;
    if (host !== lan) hosts.push(host);
  }
  return hosts;
}

/**
 * The addresses to try, each once: what Bonjour found (private IPv4 on the
 * saved port only: the row keeps its port, which its Tailscale path shares),
 * then the sweep, only while the phone is on that network (`local`): a café
 * that happens to use the same range is never probed.
 */
export function rescanHosts(
  mac: { lan: string | null; port: number }, found: readonly FoundService[], local?: readonly string[],
): string[] {
  const fromBonjour = found
    .filter((s) => typeof s?.host === 'string' && s.port === mac.port && isPrivateLanAddress(s.host))
    .map((s) => s.host);
  const sweep = onSubnet(mac.lan, local) ? sweepHosts(mac.lan) : [];
  return [...new Set([...fromBonjour, ...sweep])];
}

/** Resolves to `value` once `proceed()` turns false; `stop()` ends the watch. */
export function whenCancelled<T>(proceed: () => boolean, value: T): { promise: Promise<T>; stop: () => void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setInterval(() => {
      if (proceed()) return;
      clearInterval(timer);
      resolve(value);
    }, CANCEL_POLL_MS);
  });
  return { promise, stop: () => clearInterval(timer) };
}

export interface FindMacDeps {
  /** Does an AASC answer at this address? */
  answers(host: string): Promise<boolean>;
  /** Is it the Mac this phone paired with? */
  proves(host: string): Promise<boolean>;
}

/**
 * The first address to prove this phone's key (tried in order, up to
 * `concurrency` at a time; a proof is asked for only where an AASC answered);
 * null when none does. It answers the moment one proves itself, or the user
 * moves on (`proceed()`): probes still out then finish on their own and start
 * no more, so a cancel never holds the caller's turn.
 */
export async function findMac(
  hosts: readonly string[], deps: FindMacDeps, opts: { concurrency?: number; proceed?: () => boolean } = {},
): Promise<string | null> {
  const { concurrency = SWEEP_CONCURRENCY, proceed = () => true } = opts;
  let next = 0;
  let found: string | null = null;
  let proven: (host: string) => void = () => undefined;
  const first = new Promise<string>((resolve) => {
    proven = resolve;
  });
  const go = () => found === null && proceed();
  const worker = async (): Promise<void> => {
    while (go() && next < hosts.length) {
      const host = hosts[next];
      next += 1;
      const answered = await deps.answers(host).catch(() => false);
      if (!answered || !go()) continue;
      if (await deps.proves(host).catch(() => false) && found === null) {
        found = host;
        proven(host);
      }
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker)).then(() => found);
  const cancelled = whenCancelled(proceed, null);
  try {
    const result = await Promise.race([first, all, cancelled.promise]);
    return proceed() ? result : null;
  } finally {
    cancelled.stop();
  }
}

/** `work`'s answer, or `fallback` once `ms` have passed. */
export async function withinMs<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An AASC a phone can use answers GET /api/auth/status with a password set (every phone route needs one). It gets `ms`
 * to answer: a home network's sweep probes are short, a Tailscale address from the cloud gets longer (cloudFind).
 */
export async function answersAsAasc(deps: Pick<ShellDeps, 'requester'>, origin: string, ms = SWEEP_PROBE_MS): Promise<boolean> {
  const res = await withinMs(
    deps.requester.request({ method: 'GET', url: `${origin}/api/auth/status`, timeoutMs: ms }),
    ms, null,
  );
  return res?.status === 200 && field(res.data, ['passwordRequired']) === true;
}

/** The browse's answer as far as it can be trusted to have a shape: native data, checked anyway. */
function browseResult(raw: unknown): BrowseResult {
  const r = raw as Partial<BrowseResult> | null;
  const services = Array.isArray(r?.services) ? r!.services : [];
  const local = Array.isArray(r?.local) ? r!.local.filter((ip): ip is string => typeof ip === 'string') : undefined;
  return { services, local };
}

/**
 * The Mac's new home-network address, or null. Bonjour first (when the phone
 * has it, within `browseBudgetMs`), then the sweep while the phone is on the
 * saved address's network; only an address whose Mac proves `creds` counts.
 */
export async function rediscover(
  deps: Pick<ShellDeps, 'requester' | 'http' | 'discovery'>,
  mac: { lan: string | null; port: number },
  creds: MacCredentials,
  proceed: () => boolean = () => true,
  browseBudgetMs = BROWSE_BUDGET_MS,
): Promise<string | null> {
  let browsed: BrowseResult = { services: [] };
  if (deps.discovery) {
    const cancelled = whenCancelled(proceed, null);
    try {
      browsed = browseResult(await Promise.race([withinMs(deps.discovery.browse(DISCOVERY_MS), browseBudgetMs, null), cancelled.promise]));
    } finally {
      cancelled.stop();
    }
  }
  if (!proceed()) return null;
  const origin = (host: string) => `http://${host}:${mac.port}`;
  return findMac(rescanHosts(mac, browsed.services, browsed.local), {
    answers: (host) => answersAsAasc(deps, origin(host)),
    proves: (host) => withinMs(verifyMac(deps.http, origin(host), creds), IDENTIFY_MS, false),
  }, { proceed });
}
