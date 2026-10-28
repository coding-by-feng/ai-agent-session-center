import { describe, it, expect } from 'vitest';
import { readRemotePairingLink, NOT_A_PAIRING_LINK } from '../electron/remote/pairingLinkRules.js';
import { readPairingLink } from '../mobile/shell/src/pairingLink.js';

const MC = 'ABCDEFGH23';
const link = (frag: string): string => `https://aasc.work/pair#${frag}`;

describe('readRemotePairingLink', () => {
  it('reads a full link', () => {
    const read = readRemotePairingLink(link(`v=2&name=Studio%20Mac&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=${MC}`));
    expect(read).toEqual({
      ok: true,
      link: { version: 2, name: 'Studio Mac', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, macCode: MC },
    });
  });

  it('reads a bare fragment', () => {
    const read = readRemotePairingLink(`  v=2&name=Box&lan=10.0.0.5&p=3333&mc=${MC}  `);
    expect(read.ok).toBe(true);
  });

  it('says why a non-link is refused', () => {
    const read = readRemotePairingLink('https://example.com/pair#v=2');
    expect(read).toMatchObject({ ok: false, why: 'not-a-pairing-link', error: NOT_A_PAIRING_LINK });
  });

  it('names the refused address in a computer’s words', () => {
    const read = readRemotePairingLink(link(`v=2&name=Box&lan=8.8.8.8&p=3333&mc=${MC}`));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.why).toBe('no-usable-address');
    expect(read.error).toContain('8.8.8.8');
    expect(read.error).toContain('this computer can’t reach');
  });

  it('says so when no address is named', () => {
    const read = readRemotePairingLink(link(`v=2&name=Box&p=3333&mc=${MC}`));
    expect(read).toMatchObject({ ok: false, why: 'no-usable-address', address: null });
    if (!read.ok) expect(read.error).toContain('names no address');
  });

  it('refuses non-string input', () => {
    expect(readRemotePairingLink(42 as unknown as string).ok).toBe(false);
  });

  it('never aims at the cloud metadata address, though it is link-local', () => {
    const read = readRemotePairingLink(link(`v=2&name=Box&lan=169.254.169.254&p=80&mc=${MC}`));
    expect(read).toMatchObject({ ok: false, why: 'no-usable-address', address: '169.254.169.254' });
  });

  // A public address (Oct 28 2026, by request): only in its own `pub=`, never in `lan=` or `ts=`, and
  // only a routable unicast IPv4. The phone shell does not read `pub` (it is not in the drift table).
  describe('a public address (pub=)', () => {
    it('reads a link that names only a public address', () => {
      const read = readRemotePairingLink(link(`v=2&name=claude-desktop&pub=45.63.31.79&p=3333&mc=${MC}`));
      expect(read).toEqual({
        ok: true,
        link: { version: 2, name: 'claude-desktop', lan: null, tailnet: null, publicAddress: '45.63.31.79', port: 3333, macCode: MC },
      });
    });

    it('keeps the private and Tailscale addresses beside it', () => {
      const read = readRemotePairingLink(link(`v=2&name=Box&lan=10.0.0.5&ts=100.74.194.86&pub=45.63.31.79&p=3333&mc=${MC}`));
      expect(read.ok && read.link).toMatchObject({ lan: '10.0.0.5', tailnet: '100.74.194.86', publicAddress: '45.63.31.79' });
    });

    it('leaves the field out of a link without one', () => {
      const read = readRemotePairingLink(link(`v=2&name=Box&lan=10.0.0.5&p=3333&mc=${MC}`));
      expect(read.ok && 'publicAddress' in read.link).toBe(false);
    });

    it.each([
      ['private', '192.168.1.5'], ['private 10', '10.0.0.1'], ['private 172', '172.20.0.1'],
      ['Tailscale', '100.74.194.86'], ['carrier NAT edge', '100.64.0.0'], ['loopback', '127.0.0.1'],
      ['this network', '0.0.0.0'], ['link-local', '169.254.1.1'], ['cloud metadata', '169.254.169.254'],
      ['multicast', '224.0.0.1'], ['reserved', '240.0.0.1'], ['broadcast', '255.255.255.255'],
      ['hostname', 'example.com'], ['octal-looking', '045.63.31.79'], ['empty', ''],
    ])('refuses the whole link for a %s pub', (_label, address) => {
      const read = readRemotePairingLink(link(`v=2&name=Box&lan=10.0.0.5&pub=${address}&p=3333&mc=${MC}`));
      expect(read).toMatchObject({ ok: false, why: 'no-usable-address', address });
    });

    it('still refuses a public address in ts= or lan=', () => {
      expect(readRemotePairingLink(link(`v=2&name=Box&ts=45.63.31.79&p=3333&mc=${MC}`)).ok).toBe(false);
      expect(readRemotePairingLink(link(`v=2&name=Box&lan=45.63.31.79&p=3333&mc=${MC}`)).ok).toBe(false);
    });
  });

  it('strips invisible format characters from the name (no right-to-left spoofing)', () => {
    const read = readRemotePairingLink(link(`v=2&name=Box%E2%80%AEcam%E2%80%8B&lan=10.0.0.5&p=3333&mc=${MC}`));
    expect(read.ok && read.link.name).toBe('Boxcam');
  });
});

/**
 * Drift: electron/remote/pairingLinkRules.ts mirrors mobile/shell/src/pairingLink.ts
 * (electron/ can't import mobile/). Same verdict, same link, for every case.
 */
describe('drift with the phone shell’s readPairingLink', () => {
  const cases: [string, string][] = [
    ['full', link(`v=2&name=Mac&lan=192.168.1.2&ts=100.64.0.1&p=3333&mc=${MC}`)],
    ['lan only', link(`v=2&name=Mac&lan=10.1.2.3&p=3333&mc=${MC}`)],
    ['tailnet only', link(`v=2&name=Mac&ts=100.127.255.254&p=1&mc=${MC}`)],
    ['172.16 edge', link(`v=2&name=Mac&lan=172.16.0.1&p=3333&mc=${MC}`)],
    ['172.31 edge', link(`v=2&name=Mac&lan=172.31.255.255&p=3333&mc=${MC}`)],
    ['172.32 public', link(`v=2&name=Mac&lan=172.32.0.1&p=3333&mc=${MC}`)],
    ['link-local', link(`v=2&name=Mac&lan=169.254.3.4&p=3333&mc=${MC}`)],
    ['public lan', link(`v=2&name=Mac&lan=8.8.8.8&p=3333&mc=${MC}`)],
    ['octal-looking lan', link(`v=2&name=Mac&lan=010.1.1.1&p=3333&mc=${MC}`)],
    ['octet > 255', link(`v=2&name=Mac&lan=192.168.1.256&p=3333&mc=${MC}`)],
    ['hostname lan', link(`v=2&name=Mac&lan=mac.local&p=3333&mc=${MC}`)],
    ['tailnet below range', link(`v=2&name=Mac&ts=100.63.255.255&p=3333&mc=${MC}`)],
    ['tailnet above range', link(`v=2&name=Mac&ts=100.128.0.0&p=3333&mc=${MC}`)],
    ['good lan + bad tailnet', link(`v=2&name=Mac&lan=192.168.0.2&ts=1.2.3.4&p=3333&mc=${MC}`)],
    ['no address', link(`v=2&name=Mac&p=3333&mc=${MC}`)],
    ['empty lan', link(`v=2&name=Mac&lan=&ts=100.64.0.1&p=3333&mc=${MC}`)],
    ['port 0', link(`v=2&name=Mac&lan=10.0.0.1&p=0&mc=${MC}`)],
    ['port 65536', link(`v=2&name=Mac&lan=10.0.0.1&p=65536&mc=${MC}`)],
    ['port float', link(`v=2&name=Mac&lan=10.0.0.1&p=33.5&mc=${MC}`)],
    ['port missing', link(`v=2&name=Mac&lan=10.0.0.1&mc=${MC}`)],
    ['mac code short', link('v=2&name=Mac&lan=10.0.0.1&p=3333&mc=ABCDEFGH2')],
    ['mac code with I/O/0/1', link('v=2&name=Mac&lan=10.0.0.1&p=3333&mc=ABCDEFGHI0')],
    ['mac code lowercase', link('v=2&name=Mac&lan=10.0.0.1&p=3333&mc=abcdefgh23')],
    ['no name', link(`v=2&lan=10.0.0.1&p=3333&mc=${MC}`)],
    ['control-only name', link(`v=2&name=%01%02%7F&lan=10.0.0.1&p=3333&mc=${MC}`)],
    ['long name', link(`v=2&name=${'x'.repeat(200)}&lan=10.0.0.1&p=3333&mc=${MC}`)],
    ['name with controls', link(`v=2&name=%20Mac%0Amini%20&lan=10.0.0.1&p=3333&mc=${MC}`)],
    ['version 1', link(`v=1&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}`)],
    ['wrong origin', `https://evil.example/pair#v=2&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}`],
    ['http origin', `http://aasc.work/pair#v=2&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}`],
    ['wrong path', `https://aasc.work/pairing#v=2&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}`],
    ['no hash', 'https://aasc.work/pair'],
    ['bare fragment', `v=2&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}`],
    ['legacy backend fields ignored', link(`v=2&name=Mac&lan=10.0.0.1&p=3333&mc=${MC}&be=x.aasc.work&bc=abc&md=1`)],
    ['garbage', 'not a link at all'],
    ['empty', ''],
  ];

  it.each(cases)('%s', (_label, input) => {
    const ours = readRemotePairingLink(input);
    const shell = readPairingLink(input);
    expect(ours.ok).toBe(shell.ok);
    if (ours.ok && shell.ok) {
      expect(ours.link).toEqual(shell.link);
    } else if (!ours.ok && !shell.ok) {
      expect(ours.why).toBe(shell.why);
      if (ours.why === 'no-usable-address' && shell.why === 'no-usable-address') {
        expect(ours.address).toBe(shell.address);
      }
    }
  });
});
