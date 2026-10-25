// cloudFind.ts — find a paired Mac through AASC Cloud when no saved path answers (AASC-60 Remote access).
//
// A Mac publishes its Tailscale address and port to its owner's cloud account; the phone reads that list with its own
// backend token (GET /v1/mac-paths, scope mac-paths:read). The list is hints and nothing more: the cloud never vouches
// for a Mac. An address on it is tried only if it is a canonical Tailscale address on this row's port, and is used only
// once an AASC answers there and the Mac proves it holds this phone's key over that very address (verifyMac): the
// account may list several Macs, and anything can answer on a port. The caller then signs in there and saves the row.
//
// A 401 means the backend no longer knows this phone's token: it is forgotten, and the next sign-in asks the Mac for a
// new one. A 403 means the token was made without mac-paths:read: the Mac is marked, and its next sign-in replaces the
// token (backendLink `relink`; savedMacs RELINK_COOLDOWN_MS stops that from looping). Anything else, a Mac without a
// backend token and a user who has moved on are just no help: null, quietly.
import { bearer, field } from './http.js';
import { answersAsAasc, findMac, IDENTIFY_MS, whenCancelled, withinMs } from './lanRescan.js';
import type { ShellDeps } from './native.js';
import { verifyMac, type HttpResponse, type MacCredentials } from './pairingClient.js';
import { isBackendHost, isTailnetAddress } from './pairingLink.js';
import { forgetBackendCredential, markBackendRelink, readBackendCredential, type SavedMac } from './savedMacs.js';

/** How long the list may take: the user is waiting on a search that has already tried everything else. */
export const CLOUD_LOOKUP_MS = 4_000;
/** = shellFlows PROBE_TIMEOUT_MS: a listed address is reached over Tailscale, so it gets a saved path's 3 s, not the LAN sweep's 800 ms. */
export const HINT_PROBE_MS = 3_000;
/** An owner has a handful of Macs; this many addresses are tried, this Mac's own first. */
export const MAX_CLOUD_HINTS = 8;
/** Listed addresses asked at once. */
const HINT_CONCURRENCY = 4;
/** The backend lists at most 20 Macs (MAC_PATHS_LIST_MAX): more than that is not its answer, and is not read. */
const MAX_LISTED = 20;

type CloudDeps = Pick<ShellDeps, 'vault' | 'store' | 'requester' | 'http'>;

interface Listed {
  deviceId: string | null;
  tailnet: string;
  port: number;
}

/**
 * The entries of `{ data: { macs } }` that name a canonical Tailscale address and a port. The address is checked first:
 * nothing else about an entry matters without one.
 */
function listedMacs(raw: unknown): Listed[] {
  const macs = field(raw, ['data', 'macs']);
  if (!Array.isArray(macs)) return [];
  return macs.slice(0, MAX_LISTED).flatMap((entry): Listed[] => {
    const tailnet = field(entry, ['tailnet']);
    const port = field(entry, ['port']);
    const deviceId = field(entry, ['deviceId']);
    if (typeof tailnet !== 'string' || !isTailnetAddress(tailnet) || typeof port !== 'number') return [];
    return [{ deviceId: typeof deviceId === 'string' ? deviceId : null, tailnet, port }];
  });
}

/** What the caller already knows of the saved paths. */
export interface CloudSearchOpts {
  /**
   * Did the saved paths already try the row's Tailscale address, and fail? Default yes: the saved paths are tried in
   * order and the search comes after the last of them. Not when they stopped earlier (a stranger answered at the saved
   * home address): that address was never tried, and it is then the one the cloud may be right about.
   */
  triedTailnet?: boolean;
}

/**
 * The addresses worth asking, from the cloud's answer: Tailscale addresses on this row's port, other than the one it
 * has saved if that was just tried and failed (`triedTailnet`), this Mac's own backend device first
 * (`backendDeviceId`, when the row has one), each once, at most MAX_CLOUD_HINTS. A reading of the answer only: nothing
 * is dialled, and nothing in it is trusted.
 */
export function cloudHints(mac: SavedMac, raw: unknown, opts: CloudSearchOpts = {}): string[] {
  const { triedTailnet = true } = opts;
  const usable = listedMacs(raw).filter((m) => m.port === mac.port && !(triedTailnet && m.tailnet === mac.tailnet));
  const own = usable.filter((m) => Boolean(mac.backendDeviceId) && m.deviceId === mac.backendDeviceId);
  const rest = usable.filter((m) => !own.includes(m));
  return [...new Set([...own, ...rest].map((m) => m.tailnet))].slice(0, MAX_CLOUD_HINTS);
}

/** The cloud's answer to GET /v1/mac-paths; null when none came in time, or the user moved on first (a cancel never waits for it). */
async function askCloud(deps: CloudDeps, host: string, token: string, proceed: () => boolean): Promise<HttpResponse | null> {
  const cancelled = whenCancelled(proceed, null);
  try {
    const answer = withinMs(
      deps.requester.request({ method: 'GET', url: `https://${host}/v1/mac-paths`, headers: bearer(token), timeoutMs: CLOUD_LOOKUP_MS }),
      CLOUD_LOOKUP_MS, null,
    );
    const res = await Promise.race([answer, cancelled.promise]);
    return proceed() ? res : null;
  } finally {
    cancelled.stop();
  }
}

/**
 * The Tailscale address the account lists for this Mac that answers as an AASC and proves `creds` over that address,
 * or null. Needs this Mac's backend token. Asks no more than four addresses at once, stops at the first that proves
 * itself, and stops asking once `proceed()` turns false.
 */
export async function findViaCloud(
  deps: CloudDeps, mac: SavedMac, creds: MacCredentials, proceed: () => boolean, opts: CloudSearchOpts = {},
): Promise<string | null> {
  const cred = await readBackendCredential(deps.vault, mac.id).catch(() => null);
  if (!cred || !isBackendHost(cred.host) || !proceed()) return null;
  const res = await askCloud(deps, cred.host, cred.token, proceed);
  if (!res) return null;
  if (res.status === 401) await forgetBackendCredential(deps.vault, mac.id).catch(() => undefined);
  if (res.status === 403) await markBackendRelink(deps.store, mac.id).catch(() => undefined);
  if (res.status !== 200) return null;
  const origin = (host: string) => `http://${host}:${mac.port}`;
  return findMac(cloudHints(mac, res.data, opts), {
    answers: (host) => answersAsAasc(deps, origin(host), HINT_PROBE_MS),
    proves: (host) => withinMs(verifyMac(deps.http, origin(host), creds), IDENTIFY_MS, false),
  }, { concurrency: HINT_CONCURRENCY, proceed });
}
