// Plan 17 review M3: the Mac's owner hears about every phone that joins through the AASC Cloud account.
import { describe, expect, it } from 'vitest';
import { accountPhoneNotice, newAccountPhones } from './accountPhoneNotice';
import type { PairedPhone } from './mobilePairingApi';

function phone(id: string, over: Partial<PairedPhone> = {}): PairedPhone {
  return {
    id, label: `Phone ${id}`, platform: 'ios', status: 'active', confirmCode: null,
    createdAt: 1, approvedAt: 1, lastSeenAt: null, origin: 'account', accountEmail: 'me@example.com', ...over,
  };
}

describe('newAccountPhones', () => {
  it('says nothing on the first read: those phones were there before this window opened', () => {
    expect(newAccountPhones(null, [phone('a')])).toEqual([]);
  });

  it('finds account phones that appeared since the last read', () => {
    const before = [phone('a')];
    const after = [phone('a'), phone('b'), phone('c', { origin: 'code', accountEmail: null })];
    expect(newAccountPhones(before, after).map((p) => p.id)).toEqual(['b']);
  });

  it('ignores pending and revoked rows, and phones from an older server with no origin', () => {
    const after = [phone('p', { status: 'pending' }), phone('r', { status: 'revoked' }), phone('o', { origin: undefined })];
    expect(newAccountPhones([], after)).toEqual([]);
  });

  it('says nothing when a phone leaves', () => {
    expect(newAccountPhones([phone('a'), phone('b')], [phone('a')])).toEqual([]);
  });
});

describe('accountPhoneNotice', () => {
  it('names the phone and the account it came through', () => {
    expect(accountPhoneNotice(phone('a', { label: 'Pixel 9' })))
      .toBe('Pixel 9 connected through your AASC Cloud account (me@example.com)');
  });

  it('leaves the account out when there is no email', () => {
    expect(accountPhoneNotice(phone('a', { label: 'Pixel 9', accountEmail: null })))
      .toBe('Pixel 9 connected through your AASC Cloud account');
  });
});
