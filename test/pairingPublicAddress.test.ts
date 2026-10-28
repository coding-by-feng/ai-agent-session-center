// test/pairingPublicAddress.test.ts — the public address a pairing link may name (Oct 28 2026, by request):
// server-config.json "publicAddress" or AASC_PUBLIC_ADDRESS (the variable wins), and only a routable unicast IPv4.
import { describe, expect, it } from 'vitest';
import { pairingPublicAddress } from '../server/mobile/publicAddress.js';
import { isPublicAddress } from '../server/networkInfo.js';

describe('pairingPublicAddress', () => {
  it('is off unless set', () => {
    expect(pairingPublicAddress({}, {})).toBeNull();
  });

  it('reads server-config.json', () => {
    expect(pairingPublicAddress({ publicAddress: '45.63.31.79' }, {})).toBe('45.63.31.79');
  });

  it('lets the environment win, and an empty variable turn it off', () => {
    expect(pairingPublicAddress({ publicAddress: '45.63.31.79' }, { AASC_PUBLIC_ADDRESS: ' 203.0.113.9 ' })).toBe('203.0.113.9');
    expect(pairingPublicAddress({ publicAddress: '45.63.31.79' }, { AASC_PUBLIC_ADDRESS: '' })).toBeNull();
  });

  it.each(['192.168.1.5', '10.0.0.1', '100.74.194.86', '127.0.0.1', '169.254.169.254', '224.0.0.1', 'example.com', '045.63.31.79'])(
    'ignores %s, which is no public address',
    (address) => {
      expect(pairingPublicAddress({ publicAddress: address }, {})).toBeNull();
    },
  );
});

describe('isPublicAddress', () => {
  it.each([
    ['45.63.31.79', true], ['8.8.8.8', true], ['172.32.0.1', true], ['100.63.255.255', true], ['100.128.0.0', true],
    ['172.16.0.1', false], ['192.168.0.1', false], ['100.64.0.1', false], ['0.1.2.3', false], ['127.0.0.1', false],
    ['169.254.0.1', false], ['224.0.0.1', false], ['240.0.0.1', false], ['255.255.255.255', false], ['1.2.3', false],
  ])('%s → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });
});
