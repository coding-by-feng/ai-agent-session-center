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

/** Four canonical octets (see isTailnetAddress), or null. */
function octetsOf(address: string): number[] | null {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(address);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * RFC 1918 and link-local: the only home-network addresses the phone app dials over plain HTTP
 * (the phone's pairingLink.ts `isPrivateLanAddress` has the same rule and refuses a whole QR whose
 * `lan` breaks it).
 */
export function isPrivateLanAddress(address: string): boolean {
  const o = octetsOf(address);
  if (!o) return false;
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Interfaces whose address a phone on the same Wi-Fi can't reach: container and VM bridges, VPN
 * tunnels (Tailscale has its own `ts=` field). Linux names: docker0, br-1a2b…, veth…, virbr0,
 * tailscale0, wg0, cni0, flannel.1, cali…, lxcbr0; macOS: utun, bridge100, vmnet, vboxnet.
 */
const VIRTUAL_INTERFACE = /^(docker|br-|veth|virbr|lxcbr|lxdbr|cni|flannel|cali|tailscale|utun|wg|zt|tun|tap|bridge|vmnet|vboxnet|podman)/;

/**
 * The address the pairing QR offers as `lan=` (Oct 27 2026), or null. Only a private address on a
 * real interface: the preferred names first, then any other. getLocalIP alone gave a Linux machine's
 * first non-loopback address, since Linux names its NICs enp3s0 / wlp2s0 / ens18 rather than
 * eth0 / wlan0, and that could be tailscale0's 100.x or a public server address. The phone refuses
 * the whole QR for either ("That QR isn’t an AASC pairing code"), or docker0's 172.17.0.1, which it
 * takes and can never reach.
 */
export function getPairingLanIP(): string | null {
  const nets = networkInterfaces();
  const usable = (name: string): string | null => {
    if (VIRTUAL_INTERFACE.test(name)) return null;
    for (const cfg of nets[name] ?? []) {
      if (cfg.family === 'IPv4' && !cfg.internal && isPrivateLanAddress(cfg.address)) return cfg.address;
    }
    return null;
  };
  for (const name of ['en0', 'en1', 'eth0', 'wlan0']) {
    const address = usable(name);
    if (address) return address;
  }
  for (const name of Object.keys(nets)) {
    const address = usable(name);
    if (address) return address;
  }
  return null;
}

/**
 * A public IPv4 on a real interface (Oct 28 2026), or null: what a cloud VM (Vultr, say) carries on its NIC,
 * offered as the pairing link's "Public IP" choice. Behind a router every interface is private, so there is
 * none; VPN tunnels and container bridges are skipped as for getPairingLanIP.
 */
export function getPublicInterfaceIP(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const cfg of nets[name] ?? []) {
      if (cfg.family === 'IPv4' && !cfg.internal && isPublicAddress(cfg.address)) return cfg.address;
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
  const octets = octetsOf(address);
  return !!octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * A routable unicast IPv4 (Oct 28 2026): none of private, Tailscale/carrier NAT, loopback, "this network",
 * link-local, multicast, reserved or broadcast. What a pairing link may name in `pub=`; the desktop's
 * electron/remote/pairingLinkRules.ts has the same rule.
 */
export function isPublicAddress(address: string): boolean {
  const octets = octetsOf(address);
  if (!octets) return false;
  const [a] = octets;
  if (a === 0 || a === 127 || a >= 224) return false;
  return !isPrivateLanAddress(address) && !isTailnetAddress(address);
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
