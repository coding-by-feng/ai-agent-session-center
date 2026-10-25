/**
 * @module pairingTarget
 * AASC-60 (Remote access): what this Mac tells a phone about where to find it, for the pairing QR and
 * for the address `POST /paths` signs.
 *
 * The Tailscale address is the Tailscale probe's, the one the publisher and the Remote access page read,
 * so the QR, `/paths` and the cloud always name the same address. It is never an interface scan while the CLI
 * names a state: Cloudflare WARP, NordVPN Meshnet and a carrier-grade-NAT LAN lease put addresses in
 * 100.64.0.0/10 too, and only the Tailscale CLI can say which one is Tailscale's. (R26: the probe falls back
 * to the interface only without a usable CLI answer; tailscaleStatus.ts.) The probe is cached for a few
 * seconds, so asking on every call is cheap.
 */
import type { TailscaleStatus } from '../../src/types/remoteAccess.js';
import type { PairingTarget } from './mobileRouter.js';

export interface PairingTargetDeps {
  /** This Mac's name as a phone shows it. Read on every call. */
  name: () => string;
  /** The port this Mac's AASC listens on. */
  port: number;
  /** This Mac's home-network address, or null. Read on every call. */
  lan: () => string | null;
  /** The Tailscale probe (`createTailscaleProbe`): its `status()` never rejects. */
  probe: { status(): Promise<TailscaleStatus> };
}

export function createPairingTarget(deps: PairingTargetDeps): () => Promise<PairingTarget> {
  return async () => ({
    name: deps.name(),
    port: deps.port,
    lan: deps.lan(),
    tailnet: (await deps.probe.status()).address,
  });
}
