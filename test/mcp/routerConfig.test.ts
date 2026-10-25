// test/mcp/routerConfig.test.ts — the router's weights and the two other P4 switches, read from server-config.json
// (`mcp.router`, `mcp.autoRouting`, `mcp.idleWorkerMinutes`; server/mcp/routerConfig.ts): the spec's defaults when the
// file says nothing, every number clamped to a range that cannot break routing, and whatever the file holds that is
// not a number ignored. Restart-to-apply, like every server-config.json value.
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../../server/serverConfig.js';
import {
  AUTO_ROUTING_DEFAULT,
  IDLE_WORKER_MINUTES_DEFAULT,
  ROUTER_DEFAULTS,
  autoRoutingEnabled,
  idleWorkerMinutes,
  routerSettings,
} from '../../server/mcp/routerConfig.js';

describe('routerSettings', () => {
  it('is the spec when the config says nothing', () => {
    expect(routerSettings(undefined)).toEqual({
      weights: { sameFolder: 3, taskWords: 2, idleOrWaiting: 2, headroom: 1, recentActivity: 1 },
      reuseThreshold: 4,
      contextCeilingPct: 80,
      runnersUp: 5,
    });
    expect(routerSettings({})).toEqual(ROUTER_DEFAULTS);
    expect(routerSettings({ router: {} })).toEqual(ROUTER_DEFAULTS);
  });

  it('takes what mcp.router sets, field by field', () => {
    const got = routerSettings({
      router: { weightSameFolder: 5, weightTaskWords: 1, reuseThreshold: 6, contextCeilingPct: 70, runnersUp: 3 },
    });
    expect(got.weights).toEqual({ sameFolder: 5, taskWords: 1, idleOrWaiting: 2, headroom: 1, recentActivity: 1 });
    expect(got.reuseThreshold).toBe(6);
    expect(got.contextCeilingPct).toBe(70);
    expect(got.runnersUp).toBe(3);
  });

  it('clamps every weight to 0-10, the threshold to 1-20, the ceiling to 50-95 % and runners-up to 1-10', () => {
    const low = routerSettings({
      router: {
        weightSameFolder: -3, weightTaskWords: -1, weightIdleOrWaiting: -0.5, weightHeadroom: -9, weightRecentActivity: -2,
        reuseThreshold: 0, contextCeilingPct: 10, runnersUp: 0,
      },
    });
    expect(low.weights).toEqual({ sameFolder: 0, taskWords: 0, idleOrWaiting: 0, headroom: 0, recentActivity: 0 });
    expect(low.reuseThreshold).toBe(1);
    expect(low.contextCeilingPct).toBe(50);
    expect(low.runnersUp).toBe(1);

    const high = routerSettings({
      router: {
        weightSameFolder: 99, weightTaskWords: 11, weightIdleOrWaiting: 10.5, weightHeadroom: 1_000, weightRecentActivity: 10,
        reuseThreshold: 100, contextCeilingPct: 100, runnersUp: 50,
      },
    });
    expect(high.weights).toEqual({ sameFolder: 10, taskWords: 10, idleOrWaiting: 10, headroom: 10, recentActivity: 10 });
    expect(high.reuseThreshold).toBe(20);
    expect(high.contextCeilingPct).toBe(95);
    expect(high.runnersUp).toBe(10);
  });

  it('keeps runners-up a whole number', () => {
    expect(routerSettings({ router: { runnersUp: 2.6 } }).runnersUp).toBe(3);
    expect(routerSettings({ router: { runnersUp: 2.4 } }).runnersUp).toBe(2);
  });

  it('ignores a value that is not a finite number, and keeps the rest', () => {
    const got = routerSettings({
      router: {
        weightSameFolder: '4',
        weightTaskWords: Number.NaN,
        weightIdleOrWaiting: null,
        weightHeadroom: Number.POSITIVE_INFINITY,
        reuseThreshold: { nope: true },
        contextCeilingPct: 65,
      } as never,
    });
    expect(got.weights).toEqual(ROUTER_DEFAULTS.weights);
    expect(got.reuseThreshold).toBe(4);
    expect(got.contextCeilingPct).toBe(65);
  });

  it('ignores a router that is not an object', () => {
    expect(routerSettings({ router: 'fast' } as never)).toEqual(ROUTER_DEFAULTS);
    expect(routerSettings({ router: [3, 2] } as never)).toEqual(ROUTER_DEFAULTS);
    expect(routerSettings({ router: null } as never)).toEqual(ROUTER_DEFAULTS);
  });

  it('hands back a new object each time: changing one never changes the defaults', () => {
    const first = routerSettings(undefined);
    first.weights.sameFolder = 9;
    first.reuseThreshold = 19;
    expect(routerSettings(undefined)).toEqual({
      weights: { sameFolder: 3, taskWords: 2, idleOrWaiting: 2, headroom: 1, recentActivity: 1 },
      reuseThreshold: 4,
      contextCeilingPct: 80,
      runnersUp: 5,
    });
    expect(ROUTER_DEFAULTS.weights.sameFolder).toBe(3);
  });

  describe('from the loaded server config', () => {
    // `config` is the object serverConfig.ts built from server-config.json; a test edits it in place and puts back
    // whatever it found (the pattern runtime.test.ts uses for mcp.enabled).
    const original = config.mcp;
    afterEach(() => {
      if (original === undefined) delete config.mcp;
      else config.mcp = original;
    });

    it('reads config.mcp.router when no source is given', () => {
      config.mcp = { router: { reuseThreshold: 7, weightSameFolder: 4 } };
      const got = routerSettings();
      expect(got.reuseThreshold).toBe(7);
      expect(got.weights.sameFolder).toBe(4);
    });

    it('is the defaults when the config has no mcp at all', () => {
      delete config.mcp;
      expect(routerSettings()).toEqual(ROUTER_DEFAULTS);
    });
  });
});

describe('autoRoutingEnabled', () => {
  // P4-10: the replay on the owner's database measured 41.9 % (13 of 31) on 2026-10-24, under the 70 % bar.
  it('is off unless the config says true', () => {
    expect(AUTO_ROUTING_DEFAULT).toBe(false);
    expect(autoRoutingEnabled(undefined)).toBe(false);
    expect(autoRoutingEnabled({})).toBe(false);
    expect(autoRoutingEnabled({ autoRouting: true })).toBe(true);
    expect(autoRoutingEnabled({ autoRouting: false })).toBe(false);
  });

  it('is the default for a value that is not a boolean', () => {
    expect(autoRoutingEnabled({ autoRouting: 'no' } as never)).toBe(AUTO_ROUTING_DEFAULT);
    expect(autoRoutingEnabled({ autoRouting: 0 } as never)).toBe(AUTO_ROUTING_DEFAULT);
    expect(autoRoutingEnabled({ autoRouting: null } as never)).toBe(AUTO_ROUTING_DEFAULT);
  });
});

describe('idleWorkerMinutes', () => {
  it('is 30 unless the config says otherwise, and 0 turns clean-up off', () => {
    expect(IDLE_WORKER_MINUTES_DEFAULT).toBe(30);
    expect(idleWorkerMinutes(undefined)).toBe(30);
    expect(idleWorkerMinutes({})).toBe(30);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 45 })).toBe(45);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 0 })).toBe(0);
  });

  it('is capped at a day, and a negative or non-number value is the default', () => {
    expect(idleWorkerMinutes({ idleWorkerMinutes: 100_000 })).toBe(1_440);
    expect(idleWorkerMinutes({ idleWorkerMinutes: -5 })).toBe(30);
    expect(idleWorkerMinutes({ idleWorkerMinutes: Number.NaN })).toBe(30);
    expect(idleWorkerMinutes({ idleWorkerMinutes: '10' } as never)).toBe(30);
    expect(idleWorkerMinutes({ idleWorkerMinutes: Number.POSITIVE_INFINITY })).toBe(30);
  });

  it('is whole minutes, at least 1, unless it is 0 (off)', () => {
    expect(idleWorkerMinutes({ idleWorkerMinutes: 0.05 })).toBe(1);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 0.99 })).toBe(1);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 2.7 })).toBe(2);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 1_440.5 })).toBe(1_440);
    expect(idleWorkerMinutes({ idleWorkerMinutes: 0 })).toBe(0);
  });
});
