import { describe, expect, it } from 'vitest';
import { findMac, onSubnet, rediscover, rescanHosts, SWEEP_CONCURRENCY, sweepHosts } from './lanRescan.js';
import { createFakeMac } from './dev/fakeMac.js';

describe('sweepHosts', () => {
  it('lists the saved address\'s /24 without the saved address', () => {
    const hosts = sweepHosts('192.168.1.20');
    expect(hosts).toHaveLength(253);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts.at(-1)).toBe('192.168.1.254');
    expect(hosts).not.toContain('192.168.1.20');
    expect(hosts).not.toContain('192.168.1.0');
    expect(hosts).not.toContain('192.168.1.255');
  });

  it.each([null, '100.101.102.103', '8.8.8.8', 'not-an-ip', '192.168.1'])('sweeps nothing from %s', (lan) => {
    expect(sweepHosts(lan)).toEqual([]);
  });
});

describe('onSubnet', () => {
  it('is true when the phone has an address in the saved address\'s /24', () => {
    expect(onSubnet('192.168.1.20', ['10.0.0.9', '192.168.1.33'])).toBe(true);
  });

  it('is false when it has none there', () => {
    expect(onSubnet('192.168.1.20', ['10.0.0.9', '192.168.10.33'])).toBe(false);
    expect(onSubnet('192.168.1.20', [])).toBe(false);
    expect(onSubnet(null, ['192.168.1.33'])).toBe(false);
  });

  it('is true when the phone can\'t tell (no native list)', () => {
    expect(onSubnet('192.168.1.20', undefined)).toBe(true);
  });
});

describe('rescanHosts', () => {
  const mac = { lan: '192.168.1.20', port: 3333 };

  it('sweeps nothing when the phone is on another network', () => {
    expect(rescanHosts(mac, [{ host: '10.0.0.7', port: 3333 }], ['10.0.0.9'])).toEqual(['10.0.0.7']);
  });

  it('tries what Bonjour found first, then the sweep, each address once', () => {
    const hosts = rescanHosts(mac, [{ host: '10.0.0.7', port: 3333 }, { host: '192.168.1.57', port: 3333 }]);
    expect(hosts.slice(0, 2)).toEqual(['10.0.0.7', '192.168.1.57']);
    expect(hosts.filter((h) => h === '192.168.1.57')).toHaveLength(1);
    expect(hosts).toHaveLength(2 + 252);
  });

  it.each([
    ['a public address', { host: '8.8.8.8', port: 3333 }],
    ['a Tailscale address', { host: '100.101.102.103', port: 3333 }],
    ['another port', { host: '192.168.1.57', port: 4000 }],
    ['an IPv6 address', { host: 'fe80::1', port: 3333 }],
    ['a host name', { host: 'kason-mbp.local', port: 3333 }],
  ])('drops %s from Bonjour', (_label, found) => {
    expect(rescanHosts({ lan: null, port: 3333 }, [found])).toEqual([]);
  });
});

/** A network where `macAt` is the paired Mac, `strangers` answer but can't prove the key. */
function network(macAt: string | null, strangers: readonly string[] = []) {
  const asked: string[] = [];
  const proved: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const deps = {
    answers: async (host: string) => {
      asked.push(host);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return host === macAt || strangers.includes(host);
    },
    proves: async (host: string) => {
      proved.push(host);
      return host === macAt;
    },
  };
  return { deps, asked, proved, peak: () => peak };
}

describe('findMac', () => {
  const hosts = sweepHosts('192.168.1.20');

  it('finds the Mac that proves the key', async () => {
    const net = network('192.168.1.57');
    expect(await findMac(hosts, net.deps)).toBe('192.168.1.57');
  });

  it('never asks for a proof where nothing answered', async () => {
    const net = network('192.168.1.57');
    await findMac(hosts, net.deps);
    expect(net.proved).toEqual(['192.168.1.57']);
  });

  it('passes over another AASC that answers but can\'t prove the key', async () => {
    const net = network('192.168.1.200', ['192.168.1.30']);
    expect(await findMac(hosts, net.deps)).toBe('192.168.1.200');
    expect(net.proved).toContain('192.168.1.30');
  });

  it('is null when no one proves it', async () => {
    const net = network(null, ['192.168.1.30']);
    expect(await findMac(hosts, net.deps)).toBeNull();
    expect(net.asked).toHaveLength(hosts.length);
  });

  it(`keeps at most ${SWEEP_CONCURRENCY} probes in flight`, async () => {
    const net = network(null);
    await findMac(hosts, net.deps);
    expect(net.peak()).toBeLessThanOrEqual(SWEEP_CONCURRENCY);
    expect(net.peak()).toBeGreaterThan(1);
  });

  it('stops probing once found', async () => {
    const net = network('192.168.1.2');
    await findMac(hosts, net.deps, { concurrency: 2 });
    expect(net.asked.length).toBeLessThan(10);
  });

  it('stops when the user moves on', async () => {
    const net = network('192.168.1.200');
    let go = true;
    const found = findMac(hosts, net.deps, { concurrency: 4, proceed: () => go });
    go = false;
    expect(await found).toBeNull();
    expect(net.asked.length).toBeLessThan(10);
  });

  it('answers as soon as the Mac proves itself, without waiting for slower probes', async () => {
    const deps = {
      // Every other address hangs, as a missing host does until its timeout.
      answers: (host: string) => (host === '192.168.1.3' ? Promise.resolve(true) : new Promise<boolean>(() => undefined)),
      proves: async () => true,
    };
    expect(await findMac(hosts, deps, { concurrency: 4 })).toBe('192.168.1.3');
  });

  it('gives up at once when the user moves on, without waiting for probes still out', async () => {
    let go = true;
    const deps = { answers: () => new Promise<boolean>(() => undefined), proves: async () => true };
    const found = findMac(hosts, deps, { concurrency: 4, proceed: () => go });
    await new Promise((r) => setTimeout(r, 5));
    go = false;
    const result = await Promise.race([found, new Promise((r) => setTimeout(() => r('still waiting'), 1_000))]);
    expect(result).toBeNull();
  });

  it('counts a probe that throws as no answer', async () => {
    const deps = {
      answers: async (host: string) => {
        if (host !== '192.168.1.9') throw new Error('unreachable');
        return true;
      },
      proves: async () => true,
    };
    expect(await findMac(hosts, deps)).toBe('192.168.1.9');
  });
});

describe('rediscover', () => {
  it('goes on with the sweep when the Bonjour browse never answers', async () => {
    const mac = createFakeMac({ reachable: ['http://192.168.1.57:3333'] });
    const creds = mac.seedDevice('active');
    const deps = { requester: mac.requester, http: mac.http, discovery: { browse: () => new Promise<never>(() => undefined) } };
    expect(await rediscover(deps, { lan: '192.168.1.20', port: 3333 }, creds, () => true, 20)).toBe('192.168.1.57');
  });
});
