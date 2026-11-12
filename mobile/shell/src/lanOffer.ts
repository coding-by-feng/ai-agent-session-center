// lanOffer.ts — "Use the home network?" (Nov 10 2026).
//
// A Mac paired with the home network off is reached only over Tailscale, which may relay and be slow even when the
// phone sits on the same Wi-Fi (an iPhone at home then waited on the Mac page's "Loading..."). When that Mac answers
// on its saved home address, the phone is at home: offer the home network, once per Mac. The check runs beside the
// normal opening, so away from home it costs nothing. The home network stays the user's choice: it is plain HTTP.
import { answersAsAasc } from './lanRescan.js';
import type { ShellDeps } from './native.js';
import { isPrivateLanAddress } from './pairingLink.js';
import type { SavedMac } from './savedMacs.js';

/** Preferences key: ids of the Macs already offered the home network (JSON array). */
export const LAN_OFFERED_KEY = 'aasc.lanOffered';
/** How long the saved home address gets to answer for the offer. */
export const LAN_OFFER_PROBE_MS = 1_500;

async function offeredIds(store: ShellDeps['store']): Promise<string[]> {
  try {
    const raw = JSON.parse((await store.get(LAN_OFFERED_KEY)) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Should opening `mac` offer the home network: off for it, not offered before, and the Mac answers there now. */
export async function lanOfferDue(deps: Pick<ShellDeps, 'store' | 'requester'>, mac: SavedMac): Promise<boolean> {
  if (mac.status !== 'active' || mac.lanAllowed || !isPrivateLanAddress(mac.lan)) return false;
  if ((await offeredIds(deps.store)).includes(mac.id)) return false;
  return answersAsAasc(deps, `http://${mac.lan}:${mac.port}`, LAN_OFFER_PROBE_MS).catch(() => false);
}

/** The offer was answered (either way): never ask for this Mac again. */
export async function markLanOffered(store: ShellDeps['store'], macId: string): Promise<void> {
  const ids = await offeredIds(store);
  if (!ids.includes(macId)) await store.set(LAN_OFFERED_KEY, JSON.stringify([...ids, macId]));
}
