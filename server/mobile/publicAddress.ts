// publicAddress.ts — the public address a pairing link may name (Oct 28 2026, by request).
//
// For a server with no network in common with the computer pairing to it (a cloud VM, say):
//   server-config.json  "publicAddress": "45.63.31.79"
//   environment         AASC_PUBLIC_ADDRESS=45.63.31.79 (wins; set but empty turns it off)
// Off unless set. The link then carries `pub=`, which another AASC desktop dials last, over plain
// HTTP across the Internet: the port must be open to it, and nothing on the way is encrypted. Only a
// routable unicast IPv4 counts; anything else is ignored. The phone app does not read `pub`.

import { isPublicAddress } from '../networkInfo.js';

export interface PublicAddressConfig {
  publicAddress?: string;
}

export function pairingPublicAddress(
  config: PublicAddressConfig,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const raw = (env.AASC_PUBLIC_ADDRESS ?? config.publicAddress ?? '').trim();
  return raw !== '' && isPublicAddress(raw) ? raw : null;
}
