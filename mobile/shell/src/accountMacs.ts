// accountMacs.ts — the Macs on the signed-in AASC Cloud account (plan 17): GET /v1/enroll/macs.
//
// The list is hints, never an authority: a name to show, a backend device id to ask a ticket for, and a
// Tailscale address to try. An address counts only once the Mac there seals this phone's token for the
// address the phone dialled (accountEnroll.ts). A 401 means the backend no longer knows this phone's
// account token: the account is forgotten (signed out). Anything else is quietly "unavailable".
import { readAccountCredential, signOutAccount } from './accountSignIn.js';
import { bearer, field } from './http.js';
import type { ShellDeps } from './native.js';
import { isBackendHost, isTailnetAddress } from './pairingLink.js';
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
  tailnet: string | null;
  port: number | null;
  lastUsedAt: string | null;
}

export type AccountMacsResult =
  | { status: 'ok'; macs: AccountMac[] }
  | { status: 'signed-out' }
  | { status: 'unavailable' };

function parseEntry(raw: unknown): AccountMac | null {
  const deviceId = field(raw, ['deviceId']);
  if (typeof deviceId !== 'string' || !MAC_DEVICE_ID.test(deviceId)) return null;
  const tailnet = field(raw, ['tailnet']);
  const port = field(raw, ['port']);
  const lastUsedAt = field(raw, ['lastUsedAt']);
  return {
    deviceId,
    name: cleanLabel(field(raw, ['name']), NAME_MAX) || 'Mac',
    tailnet: typeof tailnet === 'string' && isTailnetAddress(tailnet) ? tailnet : null,
    port: typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    lastUsedAt: typeof lastUsedAt === 'string' && lastUsedAt.length <= ISO_MAX ? lastUsedAt : null,
  };
}

export async function listAccountMacs(deps: Pick<ShellDeps, 'vault' | 'store' | 'requester'>): Promise<AccountMacsResult> {
  const cred = await readAccountCredential(deps.vault).catch(() => null);
  if (!cred || !isBackendHost(cred.host)) return { status: 'signed-out' };
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

/** The listed Macs no saved row has yet (a saved row names its Mac by `backendDeviceId`). */
export function unsavedAccountMacs(listed: readonly AccountMac[], saved: readonly SavedMac[]): AccountMac[] {
  return listed.filter((a) => !saved.some((m) => m.backendDeviceId === a.deviceId));
}
