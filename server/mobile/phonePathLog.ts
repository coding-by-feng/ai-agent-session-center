// phonePathLog.ts — how each phone last connected to this Mac, and the Tailscale address the Mac last sent it (AASC-60).
//
// The Remote access view tells the owner, per phone, whether it last signed in over the home network or over Tailscale,
// and whether the Mac has told it a Tailscale address yet. Memory only: it answers "what happened lately", a restart
// starts it from nothing, and the phone's next sign-in fills it again. Entries are only ever made for a phone that
// proved its key (a successful sign-in, an approved phone's /paths), so the map is bounded by the paired phones.

import { isTailnetAddress } from '../networkInfo.js';

/** The way a phone reached this Mac: its home network, or Tailscale (100.64.0.0/10). */
export type PhonePath = 'lan' | 'tailnet';

export interface PhonePathEntry {
  /** How the phone's last successful sign-in reached the Mac; null until it has signed in since the server started. */
  lastPath: PhonePath | null;
  lastPathAt: number | null;
  /** The Tailscale address the Mac last answered this phone's /paths with. */
  tailnetSent: string | null;
  tailnetSentAt: number | null;
}

export interface PhonePathLog {
  /** A phone signed in on a socket whose local end is `localAddress` (this Mac's own address on that connection). */
  signedIn(deviceId: string, localAddress: string): void;
  /** The Mac answered this phone's /paths with its Tailscale address. */
  sent(deviceId: string, tailnet: string): void;
  /** A copy of what is known about one phone; every field null for a phone not heard from since the server started. */
  view(deviceId: string): PhonePathEntry;
}

const NOTHING: PhonePathEntry = Object.freeze({ lastPath: null, lastPathAt: null, tailnetSent: null, tailnetSentAt: null });

export function createPhonePathLog(now: () => number = Date.now): PhonePathLog {
  const entries = new Map<string, PhonePathEntry>();
  const current = (deviceId: string): PhonePathEntry => entries.get(deviceId) ?? NOTHING;
  return {
    signedIn(deviceId, localAddress) {
      const lastPath: PhonePath = isTailnetAddress(localAddress) ? 'tailnet' : 'lan';
      entries.set(deviceId, { ...current(deviceId), lastPath, lastPathAt: now() });
    },
    sent(deviceId, tailnet) {
      entries.set(deviceId, { ...current(deviceId), tailnetSent: tailnet, tailnetSentAt: now() });
    },
    view: (deviceId) => ({ ...current(deviceId) }),
  };
}
