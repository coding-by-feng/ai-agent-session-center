// backendLink.ts — this phone's own backend device for push, one per Mac (AASC-52).
//
// The pairing QR carries the Mac's code only. Once a Mac has allowed this phone
// and it has signed in, the phone asks that Mac for a phone-scoped backend code
// over the session it just opened, and redeems it with the backend exactly as
// the QR's backend half used to be redeemed: the token goes to the vault under
// that Mac, and push registers with it (pushRegistration.ts).
//
// Quiet on purpose: a Mac with no cloud, a refusal, a network failure or a vault
// that won't store just mean no notifications from that Mac yet. Nothing is
// stored then, so the next sign-in asks again. A phone that already holds its
// backend token for this Mac doesn't ask. The code itself is never stored.
//
// A redemption that fails asks the Mac once more at once: on the LAN's plain
// HTTP someone may have redeemed the code first, and the Mac revokes the device
// that made before it issues the next one. Once only: the Mac caps the asks.
//
// Opening a Mac waits for the link only so long (shellFlows LINK_BUDGET_MS), then
// aborts `signal`. Whatever comes back after that is dropped, and the token is
// only written while the Mac is still saved here with its key and no newer
// backend token was written for it: a later sign-in or an unpair may have run.
import type { ShellDeps } from './native.js';
import { pairWithBackend, requestBackendCode } from './pairingClient.js';
import {
  loadMacs, readBackendCredential, readMacCredentials, writeBackendCredential, type SavedMac,
} from './savedMacs.js';

export type BackendLinkOutcome =
  /** A new backend device for this Mac, its token in the vault. */
  | { kind: 'linked'; macDeviceId: string | null }
  /** This Mac's backend token was already in the vault. */
  | { kind: 'already' }
  /** The Mac has no cloud connection. */
  | { kind: 'no-cloud' }
  /** Anything else; asked again at the next sign-in. */
  | { kind: 'failed' };

type LinkDeps = Pick<ShellDeps, 'vault' | 'store' | 'http' | 'requester'>;

/** Still worth writing: not cut off, the Mac still saved here with its key, and no newer token for it. */
async function stillWanted(deps: LinkDeps, macId: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const [macs, key, held] = await Promise.all([
    loadMacs(deps.store).catch(() => []),
    readMacCredentials(deps.vault, macId).catch(() => null),
    readBackendCredential(deps.vault, macId).catch(() => null),
  ]);
  return !signal?.aborted && macs.some((m) => m.id === macId) && key !== null && held === null;
}

/** One code from the Mac, redeemed and stored; `redeem-failed` when the backend wouldn't take it. */
async function linkOnce(
  deps: LinkDeps, mac: SavedMac, origin: string, sessionToken: string, signal?: AbortSignal,
): Promise<BackendLinkOutcome | { kind: 'redeem-failed' }> {
  const issued = await requestBackendCode(deps.requester, origin, sessionToken);
  if (issued.status === 'no-cloud') return { kind: 'no-cloud' };
  if (issued.status !== 'ok' || signal?.aborted) return { kind: 'failed' };
  let device;
  try {
    device = await pairWithBackend(deps.http, issued.host, issued.code, mac.phoneName || 'Phone');
  } catch {
    // The Mac bound the code to this phone: asking again revokes whatever it made, so nothing is left behind.
    return { kind: 'redeem-failed' };
  }
  if (!(await stillWanted(deps, mac.id, signal))) return { kind: 'failed' };
  try {
    await writeBackendCredential(deps.vault, mac.id, { host: issued.host, deviceId: device.deviceId, token: device.token });
  } catch {
    return { kind: 'failed' };
  }
  return { kind: 'linked', macDeviceId: issued.macDeviceId };
}

export async function linkBackend(
  deps: LinkDeps, mac: SavedMac, origin: string, sessionToken: string, signal?: AbortSignal,
): Promise<BackendLinkOutcome> {
  if (await readBackendCredential(deps.vault, mac.id).catch(() => null)) return { kind: 'already' };
  const first = await linkOnce(deps, mac, origin, sessionToken, signal);
  if (first.kind !== 'redeem-failed') return first;
  const again = signal?.aborted ? first : await linkOnce(deps, mac, origin, sessionToken, signal);
  return again.kind === 'redeem-failed' ? { kind: 'failed' } : again;
}
