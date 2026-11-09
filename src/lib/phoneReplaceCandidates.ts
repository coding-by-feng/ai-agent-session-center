/**
 * phoneReplaceCandidates.ts — which older pairings a phone waiting for Allow probably replaces (Nov 6 2026).
 *
 * A phone that lost its key (an app reinstall wipes its saved list) pairs again and can't unpair its old row, so
 * the Mac listed the same "iPhone 17" twice. The Allow prompt offers to revoke each active row with the same name
 * and platform. The name is only a guess: a match seen lately, or online now, may be a second phone with the same
 * name, so it starts unticked. Computers are left out: "Computer" is every computer's default name.
 */
import type { PairedPhone } from '@/lib/mobilePairingApi';

/** A match quiet for at least this long starts ticked. */
export const REPLACE_PRESELECT_IDLE_MS = 10 * 60_000;

export interface ReplaceCandidate {
  device: PairedPhone;
  preselected: boolean;
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function findReplaceCandidates(
  pending: PairedPhone, devices: readonly PairedPhone[], now: number,
): ReplaceCandidate[] {
  if (pending.platform === 'desktop') return [];
  return devices
    .filter((d) => d.id !== pending.id && d.status === 'active' && d.platform === pending.platform
      && sameName(d.label, pending.label))
    .map((device) => {
      const lastActive = device.lastSeenAt ?? device.approvedAt ?? device.createdAt;
      return { device, preselected: !device.online && now - lastActive >= REPLACE_PRESELECT_IDLE_MS };
    });
}
