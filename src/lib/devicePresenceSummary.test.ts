import { describe, it, expect } from 'vitest';
import { summarizePhones, deviceChipTitle } from './devicePresenceSummary';
import type { PairedPhone } from './mobilePairingApi';

const phone = (over: Partial<PairedPhone>): PairedPhone => ({
  id: 'p', label: 'iPhone', platform: 'ios', status: 'active', confirmCode: null,
  createdAt: 0, approvedAt: 1, lastSeenAt: 1, ...over,
});

describe('summarizePhones', () => {
  it('counts active phones and the online ones; pending and revoked are left out', () => {
    expect(summarizePhones([
      phone({ id: 'a', online: true }),
      phone({ id: 'b', online: false }),
      phone({ id: 'c' }),
      phone({ id: 'd', status: 'pending', online: true }),
      phone({ id: 'e', status: 'revoked' }),
    ])).toEqual({ paired: 3, online: 1 });
  });
  it('leaves out paired computers: the 📱 count is phones only', () => {
    expect(summarizePhones([
      phone({ id: 'a', online: true }),
      phone({ id: 'b', platform: 'desktop', online: true }),
      phone({ id: 'c', platform: 'desktop' }),
    ])).toEqual({ paired: 1, online: 1 });
  });
  it('null (not loaded, or not this Mac) stays null', () => {
    expect(summarizePhones(null)).toBeNull();
  });
});

describe('deviceChipTitle', () => {
  it('reads like the old title without phones', () => {
    expect(deviceChipTitle(1, null)).toBe('1 device connected');
    expect(deviceChipTitle(2, { paired: 0, online: 0 })).toBe('2 devices connected');
  });
  it('adds the paired phones and how many are online', () => {
    expect(deviceChipTitle(1, { paired: 2, online: 1 })).toBe('1 device connected · 2 paired phones (1 online)');
    expect(deviceChipTitle(1, { paired: 1, online: 0 })).toBe('1 device connected · 1 paired phone (none online)');
  });
});
