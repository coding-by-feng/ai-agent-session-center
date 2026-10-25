// test/pairingTarget.test.ts - AASC-60 Remote access (final fix, R24): the pairing QR's `ts=` and the address /paths signs
// both come from the Tailscale probe (the one the publisher and the Remote access page read), never from an interface scan
// while the CLI names a state (R26: the probe falls back to the interface only without a usable CLI answer).
// A Mac with Cloudflare WARP (100.96.0.0/12), NordVPN Meshnet or a carrier-grade-NAT LAN lease has a second address inside
// 100.64.0.0/10; only the CLI can say which one is Tailscale's. A fake `tailscale` and a fake interface scan: no process.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createPairingTarget } from '../server/mobile/pairingTarget.js';
import { createTailscaleProbe } from '../server/tailscaleStatus.js';
import type { TailscaleStatus } from '../src/types/remoteAccess.js';

const TAILSCALE = '100.101.102.103';
const WARP = '100.96.0.7';
const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

const status = (address: string | null): TailscaleStatus => ({
  state: 'connected',
  address,
  account: null,
  tailnet: null,
  dnsName: null,
});

describe('createPairingTarget', () => {
  it('names this Mac, its port, its LAN address and the probe’s Tailscale address', async () => {
    const target = createPairingTarget({
      name: () => 'Kason-MBP',
      port: 3334,
      lan: () => '192.168.1.20',
      probe: { status: async () => status(TAILSCALE) },
    });
    expect(await target()).toEqual({
      name: 'Kason-MBP',
      port: 3334,
      lan: '192.168.1.20',
      tailnet: TAILSCALE,
    });
  });

  it('has no Tailscale address when the probe has none', async () => {
    const target = createPairingTarget({
      name: () => 'Mac',
      port: 3334,
      lan: () => null,
      probe: { status: async () => status(null) },
    });
    expect(await target()).toEqual({ name: 'Mac', port: 3334, lan: null, tailnet: null });
  });

  it('reads the name, the LAN address and the probe on every call, so a changed address follows', async () => {
    let address: string | null = TAILSCALE;
    let lan = '192.168.1.20';
    const probe = { status: vi.fn(async () => status(address)) };
    const target = createPairingTarget({ name: () => 'Mac', port: 3334, lan: () => lan, probe });
    expect(await target()).toMatchObject({ lan: '192.168.1.20', tailnet: TAILSCALE });
    address = '100.64.0.9';
    lan = '192.168.1.99';
    expect(await target()).toMatchObject({ lan: '192.168.1.99', tailnet: '100.64.0.9' });
    expect(probe.status).toHaveBeenCalledTimes(2);
  });

  it('over the real probe: the CLI’s address, not the 100.64.0.0/10 interface WARP holds', async () => {
    const probe = createTailscaleProbe({
      platform: 'darwin',
      exists: async (path) => path === MAC_APP_CLI,
      run: async () => ({
        stdout: JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: [TAILSCALE] } }),
      }),
      interfaceAddress: () => WARP,
    });
    const target = createPairingTarget({ name: () => 'Mac', port: 3334, lan: () => null, probe });
    expect((await target()).tailnet).toBe(TAILSCALE);
  });
});
