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
import type { ShellDeps } from './native.js';
import { pairWithBackend, requestBackendCode } from './pairingClient.js';
import { readBackendCredential, writeBackendCredential, type SavedMac } from './savedMacs.js';

export type BackendLinkOutcome =
  /** A new backend device for this Mac, its token in the vault. */
  | { kind: 'linked'; macDeviceId: string | null }
  /** This Mac's backend token was already in the vault. */
  | { kind: 'already' }
  /** The Mac has no cloud connection. */
  | { kind: 'no-cloud' }
  /** Anything else; asked again at the next sign-in. */
  | { kind: 'failed' };

export async function linkBackend(
  deps: Pick<ShellDeps, 'vault' | 'http' | 'requester'>, mac: SavedMac, origin: string, sessionToken: string,
): Promise<BackendLinkOutcome> {
  if (await readBackendCredential(deps.vault, mac.id).catch(() => null)) return { kind: 'already' };
  const issued = await requestBackendCode(deps.requester, origin, sessionToken);
  if (issued.status === 'no-cloud') return { kind: 'no-cloud' };
  if (issued.status !== 'ok') return { kind: 'failed' };
  try {
    const device = await pairWithBackend(deps.http, issued.host, issued.code, mac.phoneName || 'Phone');
    await writeBackendCredential(deps.vault, mac.id, { host: issued.host, deviceId: device.deviceId, token: device.token });
  } catch {
    // The Mac bound the code to this phone: asking again revokes whatever it made, so nothing is left behind.
    return { kind: 'failed' };
  }
  return { kind: 'linked', macDeviceId: issued.macDeviceId };
}
