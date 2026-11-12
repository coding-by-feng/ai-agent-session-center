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
  /** This Mac's backend device id from the pairing link (`md`), which every push it sends carries. */
  backendDeviceId?: string | null;
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

/**
 * How long a path that answered waits for an earlier one in the list (the home network) that has not answered
 * yet. On the same Wi-Fi the Mac answers in tens of milliseconds; a phone away from home gives up on it this soon.
 */
export const LAN_GRACE_MS = 1_500;

/**
 * Probe every path at once; the earliest in the list that answers wins. A later one that answered first waits
 * up to LAN_GRACE_MS for the earlier ones (Nov 10 2026: a phone at home opened its Mac over a relayed Tailscale
 * link and sat on "Loading..."). `onTry` names the path it is waiting on, each time that changes. `probe` owns
 * its own timeout; a throw counts as no answer.
 */
export function pickPreferred(
  list: Candidate[],
  probe: (origin: string) => Promise<boolean>,
  onTry?: (c: Candidate) => void,
): Promise<Candidate | null> {
  if (list.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const answers: Array<boolean | undefined> = list.map(() => undefined);
    let done = false;
    let grace: ReturnType<typeof setTimeout> | null = null;
    let named = -1;
    const finish = (picked: Candidate | null) => {
      if (done) return;
      done = true;
      if (grace) clearTimeout(grace);
      resolve(picked);
    };
    const firstAnswered = () => list[answers.findIndex((a) => a === true)] ?? null;
    const settle = () => {
      const lead = answers.findIndex((a) => a !== false);
      if (lead === -1) return finish(null);
      if (answers[lead] === true) return finish(list[lead]);
      if (lead !== named) {
        named = lead;
        onTry?.(list[lead]);
      }
      if (grace === null && answers.some((a) => a === true)) grace = setTimeout(() => finish(firstAnswered()), LAN_GRACE_MS);
    };
    settle();
    list.forEach((candidate, i) => {
      const answer = (async () => probe(candidate.origin))().then((ok) => ok === true, () => false);
      void answer.then((ok) => {
        answers[i] = ok;
        settle();
      });
    });
  });
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
