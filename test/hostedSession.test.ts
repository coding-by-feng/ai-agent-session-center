import { afterEach, expect, it, vi } from 'vitest';
import {
  createHostedToken,
  createToken,
  getTokenLineage,
  isLineageAlive,
  getTokenTTL,
  refreshToken,
  validateToken,
} from '../server/authManager.js';

afterEach(() => vi.useRealTimers());
it('ends a hosted web launch after one absolute hour even when its cookie is repeatedly refreshed', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  let token = createHostedToken('63d17688-d822-4387-b876-9d081278849d', 'principal', {
    sub: 'customer:opaque',
    ownerEpoch: 1,
    accessMode: 'use' as const,
  });
  vi.advanceTimersByTime(55 * 60_000);
  token = refreshToken(token)!;
  expect(validateToken(token)).toBe(true);
  expect(getTokenTTL(token)).toBe(5 * 60_000);
  vi.advanceTimersByTime(4 * 60_000);
  token = refreshToken(token)!;
  expect(getTokenTTL(token)).toBe(60_000);
  const lineage = getTokenLineage(token)!;
  vi.advanceTimersByTime(60_000);
  expect(isLineageAlive(lineage)).toBe(false);
  expect(validateToken(token)).toBe(false);
  expect(refreshToken(token)).toBeNull();
  const relaunched = createHostedToken('63d17688-d822-4387-b876-9d081278849d', 'principal', {
    sub: 'customer:opaque',
    ownerEpoch: 1,
    accessMode: 'use' as const,
  });
  expect(getTokenTTL(relaunched)).toBe(60 * 60_000);
});
it('preserves normal refresh behavior for password and independently paired-device sessions', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const password = createToken();
  const phone = createToken('paired-phone');
  vi.advanceTimersByTime(55 * 60_000);
  const refreshed = [refreshToken(password)!, refreshToken(phone)!];
  vi.advanceTimersByTime(6 * 60_000);
  for (const token of refreshed) {
    expect(validateToken(token)).toBe(true);
    expect(refreshToken(token)).not.toBeNull();
  }
});
