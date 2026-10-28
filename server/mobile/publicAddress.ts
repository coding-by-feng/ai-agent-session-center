// publicAddress.ts — the address a pairing link's "Public IP" choice offers (Oct 28 2026, by request).
//
// For a server with no network in common with the computer pairing to it (a cloud VM, say). In order:
//   environment         AASC_PUBLIC_ADDRESS=45.63.31.79 (set but empty turns the choice off)
//   server-config.json  "publicAddress": "45.63.31.79" (for a server behind NAT)
//   a network interface the public IPv4 on a real NIC (getPublicInterfaceIP), as a cloud VM has
// The link names it (`pub=`) only when the desktop ticks Public IP for that link (POST /pairing `include`).
// Another AASC desktop dials it last, over plain HTTP across the Internet: the port must be open to it, and
// nothing on the way is encrypted. Only a routable unicast IPv4 counts. The phone app does not read `pub`.

import { isPublicAddress } from '../networkInfo.js';

export interface PublicAddressConfig {
  publicAddress?: string;
}

export function pairingPublicAddress(
  config: PublicAddressConfig,
  env: Readonly<Record<string, string | undefined>>,
  interfaceAddress: () => string | null = () => null,
): string | null {
  const raw = (env.AASC_PUBLIC_ADDRESS ?? config.publicAddress ?? interfaceAddress() ?? '').trim();
  return raw !== '' && isPublicAddress(raw) ? raw : null;
}
