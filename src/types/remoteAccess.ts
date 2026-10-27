/**
 * Remote access (AASC-60): types shared by the server and the RESOURCES -> Cloud -> Remote
 * access view. The server reads them from server/tailscaleStatus.ts.
 */

/** Where this Mac stands with Tailscale. */
export type TailscaleState =
  | 'not-installed'
  | 'not-running'
  | 'signed-out'
  | 'stopped'
  | 'connected';

/** What this Mac knows about its own Tailscale. A field Tailscale does not report is null. */
export interface TailscaleStatus {
  state: TailscaleState;
  /** This Mac's tailnet IPv4, in 100.64.0.0/10. */
  address: string | null;
  /** The signed-in account: `User[Self.UserID].LoginName`. */
  account: string | null;
  /** `CurrentTailnet.Name`. */
  tailnet: string | null;
  /** `Self.DNSName` without the trailing dot. */
  dnsName: string | null;
}

/**
 * Whether this Mac has told its AASC Cloud account where to find it, which is how a phone away from
 * home learns the Mac's Tailscale address. `unavailable` means nothing publishes at all.
 */
export type PublishState =
  | 'unavailable'
  | 'no-cloud'
  | 'not-needed'
  | 'no-tailscale'
  | 'pending'
  | 'published'
  | 'forbidden'
  | 'unsupported'
  | 'failed';

export interface PublishView {
  state: PublishState;
  /** The Tailscale address shared with the cloud account; null until one has been. */
  tailnet: string | null;
  port: number;
  /** When it was last shared, in ms since the epoch; null until it has been. */
  at: number | null;
}

/** One paired phone: does it know this Mac's Tailscale address, and how did it last connect. */
export interface PhoneReachView {
  id: string;
  label: string;
  /** 'desktop': a paired computer (another AASC desktop, Oct 28 2026). */
  platform: 'ios' | 'android' | 'desktop';
  status: 'pending' | 'active';
  /** The Mac has sent this phone its current Tailscale address. Never true while the Mac has none. */
  hasTailnet: boolean;
  tailnetSentAt: number | null;
  /** How the phone's last sign-in reached the Mac since AASC started; null if it has not signed in since. */
  lastPath: 'lan' | 'tailnet' | null;
  lastPathAt: number | null;
}

/** Everything the Remote access page shows, answered by `/api/resources/cloud/remote-access`. */
export interface RemoteAccessView {
  /** `canOpenApp`: the page may offer to open the Tailscale app (macOS, and Tailscale is installed). */
  tailscale: TailscaleStatus & { canOpenApp: boolean };
  publish: PublishView;
  phones: PhoneReachView[];
  /** The port this Mac's AASC listens on. */
  port: number;
}
