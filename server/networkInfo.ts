/**
 * networkInfo.ts — this machine's own LAN-reachable IPv4 address.
 *
 * Used at startup (server/index.ts logs "Network: http://<ip>:<port>") and via
 * `GET /api/config` (apiRouter.ts), which is how the client's
 * DevicePresenceChip panel shows the address a phone should actually connect
 * to. Extracted into its own file — rather than duplicated in both — so the
 * two never drift on which interface they prefer.
 */
import { networkInterfaces } from 'os';

/**
 * Best-guess LAN IPv4 address for this machine, or null when none is found
 * (no network interface, or every one is loopback/internal-only).
 */
export function getLocalIP(): string | null {
  const nets = networkInterfaces();
  // Prefer en0 (Wi-Fi on macOS) for the most useful LAN address
  const preferred = ['en0', 'en1', 'eth0', 'wlan0'];
  for (const name of preferred) {
    if (nets[name]) {
      for (const cfg of nets[name]!) {
        if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
      }
    }
  }
  // Fallback to first non-internal IPv4
  for (const iface of Object.values(nets)) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return null;
}

/**
 * Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. Canonical dotted-quad only: four octets,
 * each `0` or digits with no leading zero, each at most 255. The URL layer reads a leading-zero octet as octal,
 * so '100.064.001.001' would pass here yet be dialled as 100.52.1.1 (the phone's pairingLink.ts has the same rule).
 */
export function isTailnetAddress(address: string): boolean {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(address);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * The first 100.64.0.0/10 IPv4 address a network interface holds, or null. An interface scan cannot tell Tailscale's
 * address from another VPN's, so since AASC-60 it is only the Tailscale probe's fallback when there is no usable CLI
 * answer (server/tailscaleStatus.ts). The pairing QR, `/paths` and the published address all come from that probe.
 */
export function getTailnetIP(): string | null {
  for (const iface of Object.values(networkInterfaces())) {
    if (!iface) continue;
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal && isTailnetAddress(cfg.address)) return cfg.address;
    }
  }
  return null;
}
