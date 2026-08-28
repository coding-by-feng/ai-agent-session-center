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
