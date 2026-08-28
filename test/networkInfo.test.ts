// test/networkInfo.test.ts — getLocalIP(), extracted from server/index.ts so
// GET /api/config (apiRouter.ts) can expose the same LAN address the startup
// log already computes, without duplicating the interface-walk logic. The
// client's DevicePresenceChip panel uses this to show "connect a phone at
// http://<localIP>:<port>" instead of the user shelling out to
// `ipconfig getifaddr en0` manually.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkInterfaceInfo } from 'os';

const mockNetworkInterfaces = vi.fn();
vi.mock('os', () => ({
  networkInterfaces: () => mockNetworkInterfaces(),
}));

let getLocalIP: typeof import('../server/networkInfo.js').getLocalIP;

beforeEach(async () => {
  vi.resetModules();
  mockNetworkInterfaces.mockReset();
  ({ getLocalIP } = await import('../server/networkInfo.js'));
});

/** Minimal realistic NetworkInterfaceInfo — real entries carry more fields
 *  (netmask, mac, cidr) nothing here reads. */
function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null } as NetworkInterfaceInfo;
}
function ipv6(address: string, internal = false): NetworkInterfaceInfo {
  return { address, family: 'IPv6', internal, netmask: '', mac: '', cidr: null, scopeid: 0 } as NetworkInterfaceInfo;
}

describe('getLocalIP', () => {
  it('returns the en0 (Wi-Fi) address when present', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [ipv4('127.0.0.1', true)],
      en0: [ipv4('192.168.6.42')],
      en1: [ipv4('10.0.0.5')],
    });
    expect(getLocalIP()).toBe('192.168.6.42');
  });

  it('prefers en0 over en1 over eth0 over wlan0, in that order', () => {
    mockNetworkInterfaces.mockReturnValue({
      wlan0: [ipv4('10.0.0.1')],
      eth0: [ipv4('10.0.0.2')],
      en1: [ipv4('10.0.0.3')],
      en0: [ipv4('10.0.0.4')],
    });
    expect(getLocalIP()).toBe('10.0.0.4');
  });

  it('skips a loopback/internal entry even on a preferred interface name', () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: [ipv4('127.0.0.1', true)],
      en1: [ipv4('192.168.1.10')],
    });
    expect(getLocalIP()).toBe('192.168.1.10');
  });

  it('skips an IPv6-only entry on the preferred interface, falling through to another', () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: [ipv6('fe80::1')],
      en1: [ipv4('192.168.1.20')],
    });
    expect(getLocalIP()).toBe('192.168.1.20');
  });

  it('falls back to any non-internal IPv4 when no preferred interface has one', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [ipv4('127.0.0.1', true)],
      bridge100: [ipv4('192.168.64.1')],
    });
    expect(getLocalIP()).toBe('192.168.64.1');
  });

  it('returns null when every interface is internal or non-IPv4', () => {
    mockNetworkInterfaces.mockReturnValue({
      lo0: [ipv4('127.0.0.1', true), ipv6('::1', true)],
    });
    expect(getLocalIP()).toBeNull();
  });

  it('returns null when there are no interfaces at all', () => {
    mockNetworkInterfaces.mockReturnValue({});
    expect(getLocalIP()).toBeNull();
  });

  it('handles an interface entry that is undefined (Node types allow this)', () => {
    mockNetworkInterfaces.mockReturnValue({
      en0: undefined,
      en1: [ipv4('192.168.1.30')],
    });
    expect(getLocalIP()).toBe('192.168.1.30');
  });
});
