// phoneReroute.test.ts — when the phone app's page gives up on its own address and asks the shell
// to find the Mac again (network switch: home Wi‑Fi → 5G left the page on a dead LAN origin).
import { describe, it, expect, vi } from 'vitest';
import {
  REROUTE_AFTER_DOWN_MS,
  REROUTE_COOLDOWN_MS,
  REROUTE_PROBE_MS,
  originAnswers,
  readLastReroute,
  shouldProbe,
  writeLastReroute,
  type RerouteCheck,
} from './phoneReroute';

const NOW = 1_000_000;
const base: RerouteCheck = {
  online: true,
  visible: true,
  downSince: NOW - REROUTE_AFTER_DOWN_MS,
  lastRerouteAt: null,
  now: NOW,
};

describe('shouldProbe', () => {
  it('probes once the socket has been down long enough, online and in view', () => {
    expect(shouldProbe(base)).toBe(true);
  });

  it('waits while the socket has been down for less than the grace', () => {
    expect(shouldProbe({ ...base, downSince: NOW - REROUTE_AFTER_DOWN_MS + 1 })).toBe(false);
  });

  it('never probes while the phone is offline (no path would answer; keep the last update)', () => {
    expect(shouldProbe({ ...base, online: false })).toBe(false);
  });

  it('never probes in the background', () => {
    expect(shouldProbe({ ...base, visible: false })).toBe(false);
  });

  it('never probes while the socket is up', () => {
    expect(shouldProbe({ ...base, downSince: null })).toBe(false);
  });

  it('holds for the cooldown after a reroute, so a flaky network cannot bounce the page back and forth', () => {
    expect(shouldProbe({ ...base, lastRerouteAt: NOW - REROUTE_COOLDOWN_MS + 1 })).toBe(false);
    expect(shouldProbe({ ...base, lastRerouteAt: NOW - REROUTE_COOLDOWN_MS })).toBe(true);
  });

  it('ignores a reroute stamp from the future (clock moved back)', () => {
    expect(shouldProbe({ ...base, lastRerouteAt: NOW + 5_000 })).toBe(true);
  });
});

describe('originAnswers', () => {
  it('counts any HTTP answer, a 401 included, as the address still being there', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(originAnswers(fetchFn)).resolves.toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/status', expect.objectContaining({ cache: 'no-store' }));
  });

  it('is false when the request fails (no route to the old address)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    await expect(originAnswers(fetchFn)).resolves.toBe(false);
  });

  it('gives up after the probe budget and aborts the request', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchFn = vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      });
      const answer = originAnswers(fetchFn);
      await vi.advanceTimersByTimeAsync(REROUTE_PROBE_MS);
      await expect(answer).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('last reroute stamp', () => {
  it('round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readLastReroute(storage)).toBeNull();
    writeLastReroute(storage, 1234);
    expect(readLastReroute(storage)).toBe(1234);
  });

  it('reads garbage as none and survives a storage that throws', () => {
    const bad = { getItem: () => 'nope', setItem: () => { throw new Error('quota'); } };
    expect(readLastReroute(bad)).toBeNull();
    expect(() => writeLastReroute(bad, 1)).not.toThrow();
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
    expect(readLastReroute(throwing)).toBeNull();
  });
});
