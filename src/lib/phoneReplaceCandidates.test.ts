import { describe, expect, it } from 'vitest';
import type { PairedPhone } from '@/lib/mobilePairingApi';
import { findReplaceCandidates, REPLACE_PRESELECT_IDLE_MS } from './phoneReplaceCandidates';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function phone(over: Partial<PairedPhone>): PairedPhone {
  return {
    id: 'x', label: 'iPhone 17', platform: 'ios', status: 'active', confirmCode: null,
    createdAt: NOW - 5 * DAY, approvedAt: NOW - 5 * DAY, lastSeenAt: NOW - 4 * DAY, ...over,
  };
}

describe('findReplaceCandidates', () => {
  const pending = phone({ id: 'new', status: 'pending', confirmCode: '123456', approvedAt: null, lastSeenAt: null, createdAt: NOW });

  it('offers an active pairing with the same name and platform, ticked when it has been quiet', () => {
    const old = phone({ id: 'old' });
    expect(findReplaceCandidates(pending, [pending, old], NOW)).toEqual([{ device: old, preselected: true }]);
  });

  it('matches the name without regard to case or outer spaces', () => {
    const old = phone({ id: 'old', label: ' iphone 17 ' });
    expect(findReplaceCandidates(pending, [old], NOW).map((c) => c.device.id)).toEqual(['old']);
  });

  it('leaves out another name, another platform, a pending or revoked row and the phone itself', () => {
    const rows = [
      pending,
      phone({ id: 'ipad', label: 'iPad' }),
      phone({ id: 'android', platform: 'android' }),
      phone({ id: 'waiting', status: 'pending' }),
      phone({ id: 'gone', status: 'revoked' }),
    ];
    expect(findReplaceCandidates(pending, rows, NOW)).toEqual([]);
  });

  it('starts unticked when the match was seen or is online lately: maybe a second phone with the same name', () => {
    const recent = phone({ id: 'recent', lastSeenAt: NOW - REPLACE_PRESELECT_IDLE_MS + 1 });
    const online = phone({ id: 'online', online: true });
    const quiet = phone({ id: 'quiet', lastSeenAt: NOW - REPLACE_PRESELECT_IDLE_MS });
    expect(findReplaceCandidates(pending, [recent, online, quiet], NOW).map((c) => [c.device.id, c.preselected]))
      .toEqual([['recent', false], ['online', false], ['quiet', true]]);
  });

  it('judges a never-seen match by when it was approved', () => {
    const fresh = phone({ id: 'fresh', lastSeenAt: null, approvedAt: NOW - 60_000 });
    const old = phone({ id: 'old', lastSeenAt: null, approvedAt: NOW - DAY });
    expect(findReplaceCandidates(pending, [fresh, old], NOW).map((c) => c.preselected)).toEqual([false, true]);
  });

  it('offers nothing for a computer', () => {
    const pc = phone({ id: 'new', platform: 'desktop', label: 'Computer', status: 'pending' });
    const old = phone({ id: 'old', platform: 'desktop', label: 'Computer' });
    expect(findReplaceCandidates(pc, [old], NOW)).toEqual([]);
  });
});
