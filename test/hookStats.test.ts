// test/hookStats.test.ts — Tests for server/hookStats.ts
import { describe, it, beforeEach, expect } from 'vitest';
import { recordHook, getStats, resetStats } from '../server/hookStats.js';

describe('hookStats', () => {
  beforeEach(() => {
    resetStats();
  });

  describe('recordHook', () => {
    it('increments total hook count', () => {
      recordHook('PreToolUse', null, 5);
      recordHook('Stop', null, 3);
      const stats = getStats();
      expect(stats.totalHooks).toBe(2);
    });

    it('tracks per-event counts', () => {
      recordHook('PreToolUse', null, 5);
      recordHook('PreToolUse', null, 3);
      recordHook('Stop', null, 2);
      const stats = getStats();
      expect(stats.events.PreToolUse.count).toBe(2);
      expect(stats.events.Stop.count).toBe(1);
    });

    it('records delivery latency when provided', () => {
      recordHook('PreToolUse', 50, 5);
      recordHook('PreToolUse', 100, 3);
      const stats = getStats();
      expect(stats.events.PreToolUse.latency.min).toBe(50);
      expect(stats.events.PreToolUse.latency.max).toBe(100);
    });

    it('ignores null delivery latency', () => {
      recordHook('PreToolUse', null, 5);
      const stats = getStats();
      // No latency data should yield zeroes
      expect(stats.events.PreToolUse.latency.avg).toBe(0);
      expect(stats.events.PreToolUse.latency.p95).toBe(0);
    });

    it('records processing time', () => {
      recordHook('Stop', null, 10);
      recordHook('Stop', null, 20);
      const stats = getStats();
      expect(stats.events.Stop.processing.min).toBe(10);
      expect(stats.events.Stop.processing.max).toBe(20);
      expect(stats.events.Stop.processing.avg).toBe(15);
    });
  });

  describe('getStats', () => {
    it('returns correct structure', () => {
      recordHook('SessionStart', 10, 2);
      const stats = getStats();
      expect(typeof stats.totalHooks).toBe('number');
      expect(typeof stats.hooksPerMin).toBe('number');
      expect(typeof stats.events).toBe('object');
      expect(typeof stats.sampledAt).toBe('number');
    });

    it('returns per-event rate (hooks in last minute)', () => {
      recordHook('PreToolUse', null, 1);
      recordHook('PreToolUse', null, 1);
      recordHook('PreToolUse', null, 1);
      const stats = getStats();
      // All recorded just now, should be 3
      expect(stats.events.PreToolUse.rate).toBe(3);
    });

    it('returns global hooksPerMin', () => {
      recordHook('A', null, 1);
      recordHook('B', null, 1);
      const stats = getStats();
      expect(stats.hooksPerMin).toBe(2);
    });
  });

  describe('p95 calculation', () => {
    it('calculates p95 with known data', () => {
      // Record 20 hooks with latencies 1-20
      for (let i = 1; i <= 20; i++) {
        recordHook('Test', i, 1);
      }
      const stats = getStats();
      // p95 index = Math.floor(20 * 0.95) = 19, sorted[19] = 20
      expect(stats.events.Test.latency.p95).toBe(20);
    });

    it('calculates p95 with single entry', () => {
      recordHook('Test', 42, 1);
      const stats = getStats();
      // p95 index = Math.floor(1 * 0.95) = 0, sorted[0] = 42
      expect(stats.events.Test.latency.p95).toBe(42);
    });
  });

  describe('resetStats', () => {
    it('resets all statistics', () => {
      recordHook('PreToolUse', 50, 5);
      recordHook('Stop', 30, 3);
      resetStats();
      const stats = getStats();
      expect(stats.totalHooks).toBe(0);
      expect(stats.hooksPerMin).toBe(0);
      expect(stats.events).toEqual({});
    });
  });
});
