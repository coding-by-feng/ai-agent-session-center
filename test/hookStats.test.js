// test/hookStats.test.js — Tests for server/hookStats.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
      assert.equal(stats.totalHooks, 2);
    });

    it('tracks per-event counts', () => {
      recordHook('PreToolUse', null, 5);
      recordHook('PreToolUse', null, 3);
      recordHook('Stop', null, 2);
      const stats = getStats();
      assert.equal(stats.events.PreToolUse.count, 2);
      assert.equal(stats.events.Stop.count, 1);
    });

    it('records delivery latency when provided', () => {
      recordHook('PreToolUse', 50, 5);
      recordHook('PreToolUse', 100, 3);
      const stats = getStats();
      assert.equal(stats.events.PreToolUse.latency.min, 50);
      assert.equal(stats.events.PreToolUse.latency.max, 100);
    });

    it('ignores null delivery latency', () => {
      recordHook('PreToolUse', null, 5);
      const stats = getStats();
      // No latency data should yield zeroes
      assert.equal(stats.events.PreToolUse.latency.avg, 0);
      assert.equal(stats.events.PreToolUse.latency.p95, 0);
    });

    it('records processing time', () => {
      recordHook('Stop', null, 10);
      recordHook('Stop', null, 20);
      const stats = getStats();
      assert.equal(stats.events.Stop.processing.min, 10);
      assert.equal(stats.events.Stop.processing.max, 20);
      assert.equal(stats.events.Stop.processing.avg, 15);
    });
  });

  describe('getStats', () => {
    it('returns correct structure', () => {
      recordHook('SessionStart', 10, 2);
      const stats = getStats();
      assert.equal(typeof stats.totalHooks, 'number');
      assert.equal(typeof stats.hooksPerMin, 'number');
      assert.equal(typeof stats.events, 'object');
      assert.equal(typeof stats.sampledAt, 'number');
    });

    it('returns per-event rate (hooks in last minute)', () => {
      recordHook('PreToolUse', null, 1);
      recordHook('PreToolUse', null, 1);
      recordHook('PreToolUse', null, 1);
      const stats = getStats();
      // All recorded just now, should be 3
      assert.equal(stats.events.PreToolUse.rate, 3);
    });

    it('returns global hooksPerMin', () => {
      recordHook('A', null, 1);
      recordHook('B', null, 1);
      const stats = getStats();
      assert.equal(stats.hooksPerMin, 2);
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
      assert.equal(stats.events.Test.latency.p95, 20);
    });

    it('calculates p95 with single entry', () => {
      recordHook('Test', 42, 1);
      const stats = getStats();
      // p95 index = Math.floor(1 * 0.95) = 0, sorted[0] = 42
      assert.equal(stats.events.Test.latency.p95, 42);
    });
  });

  describe('resetStats', () => {
    it('resets all statistics', () => {
      recordHook('PreToolUse', 50, 5);
      recordHook('Stop', 30, 3);
      resetStats();
      const stats = getStats();
      assert.equal(stats.totalHooks, 0);
      assert.equal(stats.hooksPerMin, 0);
      assert.deepEqual(stats.events, {});
    });
  });
});
