// accountMacs.ts — the Macs on the signed-in AASC Cloud account (plan 17): GET /v1/enroll/macs.
//
// The list is hints, never an authority: a name to show, a backend device id to ask a ticket for, and a
// Tailscale address to try. An address counts only once the Mac there seals this phone's token for the
// address the phone dialled (accountEnroll.ts). A 401 means the backend no longer knows this phone's
// account token: the account is forgotten (signed out). Anything else is quietly "unavailable", and so is
// a vault that can't be read right now (a locked keychain): the token is there, nothing is asked, and
// nothing is forgotten (Nov 20 2026; a failed key read is never a missing key).
// Plan 18 adds one step beside the list, never inside it: withDirectoryHints (GET /v1/machines), which
// gives the Macs on the list their home-network address. Only "Your Macs" calls it (accountWiring.ts).
import { accountCredentialState, signOutAccount } from './accountSignIn.js';
import { bearer, field } from './http.js';
import { withinMs } from './lanRescan.js';
import type { ShellDeps } from './native.js';
import { isBackendHost, isPrivateLanAddress, isTailnetAddress } from './pairingLink.js';
import type { SavedMac } from './savedMacs.js';
import { cleanLabel } from './text.js';

/** The backend lists at most 20 (plan 17); more is not its answer and is not read. */
const MAX_LISTED = 20;
/** The backend's device ids are UUIDs (a ticket asks for one); each also fits savedMacs' backendDeviceId. */
const MAC_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_MAX = 80;
const ISO_MAX = 40;
export const ACCOUNT_LIST_MS = 8_000;

export interface AccountMac {
  deviceId: string;
  name: string;
  /** The Mac's home-network address: never from the list itself, only a hint the directory adds (withDirectoryHints). */
  lan: string | null;
  tailnet: string | null;
  port: number | null;
  lastUsedAt: string | null;
}

export type AccountMacsResult =
  | { status: 'ok'; macs: AccountMac[] }
  | { status: 'signed-out' }
  /** `unreadable`: nothing was asked, because this phone couldn't read its own token. */
  | { status: 'unavailable'; unreadable?: true };

const validPort = (port: unknown): number | null => (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null);

function parseEntry(raw: unknown): AccountMac | null {
  const deviceId = field(raw, ['deviceId']);
  if (typeof deviceId !== 'string' || !MAC_DEVICE_ID.test(deviceId)) return null;
  const tailnet = field(raw, ['tailnet']);
  const port = field(raw, ['port']);
  const lastUsedAt = field(raw, ['lastUsedAt']);
  return {
    deviceId,
    name: cleanLabel(field(raw, ['name']), NAME_MAX) || 'Mac',
    lan: null,
    tailnet: typeof tailnet === 'string' && isTailnetAddress(tailnet) ? tailnet : null,
    port: validPort(port),
    lastUsedAt: typeof lastUsedAt === 'string' && lastUsedAt.length <= ISO_MAX ? lastUsedAt : null,
  };
}

export async function listAccountMacs(deps: Pick<ShellDeps, 'vault' | 'store' | 'requester'>): Promise<AccountMacsResult> {
  const read = await accountCredentialState(deps.vault);
  if (read.status === 'unreadable') return { status: 'unavailable', unreadable: true };
  if (read.status !== 'ok' || !isBackendHost(read.cred.host)) return { status: 'signed-out' };
  const { cred } = read;
  let res;
  try {
    res = await deps.requester.request({
      method: 'GET', url: `https://${cred.host}/v1/enroll/macs`, headers: bearer(cred.token), timeoutMs: ACCOUNT_LIST_MS,
    });
  } catch {
    return { status: 'unavailable' };
  }
  if (res.status === 401) {
    await signOutAccount(deps);
    return { status: 'signed-out' };
  }
  const macs = field(res.data, ['data', 'macs']);
  if (res.status !== 200 || !Array.isArray(macs)) return { status: 'unavailable' };
  const out: AccountMac[] = [];
  for (const raw of macs.slice(0, MAX_LISTED)) {
    const mac = parseEntry(raw);
    if (mac && !out.some((m) => m.deviceId === mac.deviceId)) out.push(mac);
  }
  return { status: 'ok', macs: out };
}

/** The directory lists at most 50 computers; more is not its answer and is not read. */
const MAX_DIRECTORY = 50;
/**
 * How long the whole hints step gets, from its first await (the read of this phone's own token) to the directory's
 * answer. It only adds hints, so it must never hold the list or a Connect back for long, whatever it is stuck on.
 */
export const DIRECTORY_HINTS_MS = 3_000;

/**
 * Plan 18: address hints for the Macs ALREADY on the list, from the account's directory of computers
 * (GET /v1/machines, one request at most). The list above stays the authority on which Macs a phone can
 * connect to; the directory answers a different question (computers a computer can reach), so here it only
 * adds what the list lacks for a Mac it also names as the account's own (`relation: 'self'`, same device id):
 *  - `lan`: its home-network address, when that is a private address (the list never has one);
 *  - `tailnet`: only when the list has none, and only a Tailscale address;
 *  - `port`: only when the list has none.
 * Never a new row, a removed row or another name; `connectable` and `current` are not read, nor is the public
 * address (this app has no public path). Like the list's own addresses these are hints: an address counts only
 * once the Mac there seals this phone's token for the address the phone dialled (accountEnroll.ts).
 *
 * Anything short of a 200 with the list gives the list back as it was: a 403 (this phone signed in before the
 * backend listed computers), a 404 (a backend without the directory), a fault, a body that is not the list, or a
 * token this phone can't read right now. A 401 here signs nobody out: only the list's own read decides that.
 *
 * `timeoutMs` is one limit for the whole step, not one per part: a vault that hangs on the token read (rather
 * than throwing), a request that ignores its own limit, or both in turn, all end with the list as it was at that
 * limit, and an answer that comes later changes nothing. It never rejects, and never changes `macs` or a Mac in it.
 */
export async function withDirectoryHints(
  deps: Pick<ShellDeps, 'vault' | 'requester'>, macs: AccountMac[], timeoutMs: number = DIRECTORY_HINTS_MS,
): Promise<AccountMac[]> {
  if (macs.length === 0) return macs; // no Mac a hint could be for
  return withinMs(directoryHints(deps, macs, timeoutMs), timeoutMs, macs);
}

/** The step itself, unbounded but for the request's own native limit; a failed request rejects (withDirectoryHints turns that into `macs`). */
async function directoryHints(deps: Pick<ShellDeps, 'vault' | 'requester'>, macs: AccountMac[], timeoutMs: number): Promise<AccountMac[]> {
  const read = await accountCredentialState(deps.vault);
  if (read.status !== 'ok' || !isBackendHost(read.cred.host)) return macs;
  const { cred } = read;
  const res = await deps.requester.request({ method: 'GET', url: `https://${cred.host}/v1/machines`, headers: bearer(cred.token), timeoutMs });
  const listed: unknown = field(res.data, ['data', 'machines']);
  if (res.status !== 200 || !Array.isArray(listed)) return macs;
  const own = listed.slice(0, MAX_DIRECTORY).filter((entry) => field(entry, ['relation']) === 'self');
  const hinted = macs.map((mac) => {
    const paths = field(own.find((entry) => field(entry, ['deviceId']) === mac.deviceId), ['paths']);
    const lan = field(paths, ['lan']);
    const tailnet = field(paths, ['tailnet']);
    const next: AccountMac = {
      ...mac,
      lan: typeof lan === 'string' && isPrivateLanAddress(lan) ? lan : mac.lan,
      tailnet: mac.tailnet ?? (typeof tailnet === 'string' && isTailnetAddress(tailnet) ? tailnet : null),
      port: mac.port ?? validPort(field(paths, ['port'])),
    };
    return next.lan === mac.lan && next.tailnet === mac.tailnet && next.port === mac.port ? mac : next;
  });
  return hinted.every((mac, i) => mac === macs[i]) ? macs : hinted;
}

/** The listed Macs no saved row has yet (a saved row names its Mac by `backendDeviceId`). */
export function unsavedAccountMacs(listed: readonly AccountMac[], saved: readonly SavedMac[]): AccountMac[] {
  return listed.filter((a) => !saved.some((m) => m.backendDeviceId === a.deviceId));
}
