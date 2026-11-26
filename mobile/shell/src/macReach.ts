// macReach.ts — does each computer in the list answer right now (Nov 27 2026)? The list of computers is also the
// switcher, so each row says Online or Offline. A saved computer is probed on the paths opening it would use
// (connectionPlan `candidates`: the home network only where the person allowed it); one of the account's computers
// not on this phone yet on the addresses the account lists (hints only: answering proves nothing about who it is,
// and nothing is sent but the same `GET /api/auth/status` opening a computer starts with). All paths at once; the first
// answer is Online; none within REACH_MS is Offline. Until then a row says nothing: no claim either way.
import type { AccountMac } from './accountMacs.js';
import { candidates } from './connectionPlan.js';
import { withinMs } from './lanRescan.js';
import { isPrivateLanAddress, isTailnetAddress } from './pairingLink.js';
import type { SavedMac } from './savedMacs.js';

export type Reach = 'online' | 'offline';

/** How long a row waits for any of its paths before it says Offline. */
export const REACH_MS = 2_000;

export interface ReachTarget {
  /** The row: a saved computer's id, or `account:<device id>` for one of the account's. */
  key: string;
  origins: string[];
}

export const accountReachKey = (deviceId: string): string => `account:${deviceId}`;

/** What to probe for each row of the list, saved computers first. */
export function reachTargets(saved: readonly SavedMac[], account: readonly AccountMac[]): ReachTarget[] {
  const mine = saved
    .filter((m) => m.status === 'active')
    .map((m) => ({ key: m.id, origins: candidates(m).map((c) => c.origin) }));
  const listed = account.map((m) => {
    const origins: string[] = [];
    if (m.port !== null && isPrivateLanAddress(m.lan)) origins.push(`http://${m.lan}:${m.port}`);
    if (m.port !== null && isTailnetAddress(m.tailnet)) origins.push(`http://${m.tailnet}:${m.port}`);
    return { key: accountReachKey(m.deviceId), origins };
  });
  return [...mine, ...listed];
}

/** Online once any origin answers; Offline when none does within `ms` (or there is nothing to try). Never rejects. */
export function reachOne(probe: (origin: string) => Promise<boolean>, target: ReachTarget, ms: number = REACH_MS): Promise<Reach> {
  if (target.origins.length === 0) return Promise.resolve('offline');
  const anyAnswer = new Promise<Reach>((resolve) => {
    let left = target.origins.length;
    for (const origin of target.origins) {
      probe(origin).then((ok) => ok, () => false).then((ok) => {
        left -= 1;
        if (ok) resolve('online');
        else if (left === 0) resolve('offline');
      });
    }
  });
  return withinMs(anyAnswer, ms, 'offline' as Reach);
}
