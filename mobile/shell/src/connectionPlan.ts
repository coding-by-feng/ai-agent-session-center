// connectionPlan.ts — which address to reach the Mac on, in what order (AASC-17).
//
// Tailscale is encrypted end to end (WireGuard) and works anywhere; the home
// network is faster but plain HTTP, so it is opt-in per server and shown as
// unencrypted. The optional Cloudflare and relay paths join this list later.
import { isPrivateLanAddress, isTailnetAddress } from './pairingLink.js';

export type PathKind = 'lan' | 'tailnet';

export interface PairedServer {
  id: string;
  name: string;
  port: number;
  lan: string | null;
  tailnet: string | null;
  /** The user allowed unencrypted home-network connections to this Mac. */
  lanAllowed: boolean;
}

export interface Candidate {
  kind: PathKind;
  origin: string;
  encrypted: boolean;
}

export function candidates(server: PairedServer): Candidate[] {
  const out: Candidate[] = [];
  // At home the LAN answers first; elsewhere it simply fails its probe.
  if (server.lanAllowed && isPrivateLanAddress(server.lan)) {
    out.push({ kind: 'lan', origin: `http://${server.lan}:${server.port}`, encrypted: false });
  }
  if (isTailnetAddress(server.tailnet)) {
    out.push({ kind: 'tailnet', origin: `http://${server.tailnet}:${server.port}`, encrypted: true });
  }
  return out;
}

/** Probe in order; the first that answers wins. `probe` owns its own timeout. */
export async function pickReachable(
  list: Candidate[],
  probe: (origin: string) => Promise<boolean>,
): Promise<Candidate | null> {
  for (const candidate of list) {
    try {
      if (await probe(candidate.origin)) return candidate;
    } catch {
      /* unreachable: try the next path */
    }
  }
  return null;
}

/**
 * The shell's navigation guard. Plain HTTP is allowed only to the exact
 * addresses and port of a paired server, never to any other host, so a link
 * in the loaded UI can't lead the WebView to an unencrypted foreign page.
 */
export function isAllowedNavigation(url: string, servers: PairedServer[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return /(?:^|\.)aasc\.work$/.test(parsed.hostname);
  if (parsed.protocol !== 'http:') return false;
  return servers.some((s) => candidates(s).some((c) => new URL(c.origin).host === parsed.host));
}
