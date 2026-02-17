// hookStats.ts — In-memory hook performance statistics
// Tracks delivery latency, server processing time, and throughput per event type.
// Stats are broadcast to the dashboard via WebSocket.

import type { HookStats, HookTimingStats, HookEventStats } from '../src/types/websocket.js';

const ROLLING_WINDOW = 200; // keep last N samples per event type
const RATE_WINDOW_MS = 60_000; // 1 minute for hooks/min calculation

interface EventBucket {
  count: number;
  latencies: number[];       // delivery latency (hook_sent_at -> server received), ms
  processingTimes: number[];  // server handleEvent() duration, ms
  timestamps: number[];       // for per-event rate
}

// Per event type
const byEvent: Record<string, EventBucket> = {};
// Global totals
let totalHooks = 0;
const globalTimestamps: number[] = []; // for hooks/min rate

function ensureEvent(eventType: string): EventBucket {
  if (!byEvent[eventType]) {
    byEvent[eventType] = {
      count: 0,
      latencies: [],
      processingTimes: [],
      timestamps: [],
    };
  }
  return byEvent[eventType];
}

/**
 * Record a hook event's timing.
 * @param eventType - e.g. 'PreToolUse', 'Stop'
 * @param deliveryLatencyMs - hook_sent_at -> server received (null if no timestamp)
 * @param processingTimeMs - server handleEvent() duration
 */
export function recordHook(eventType: string, deliveryLatencyMs: number | null, processingTimeMs: number): void {
  const now = Date.now();
  totalHooks++;

  // Global rate tracking
  globalTimestamps.push(now);
  while (globalTimestamps.length > 0 && now - globalTimestamps[0] > RATE_WINDOW_MS) {
    globalTimestamps.shift();
  }

  const ev = ensureEvent(eventType);
  ev.count++;
  ev.timestamps.push(now);

  if (deliveryLatencyMs !== null && deliveryLatencyMs >= 0) {
    ev.latencies.push(deliveryLatencyMs);
    if (ev.latencies.length > ROLLING_WINDOW) ev.latencies.shift();
  }

  ev.processingTimes.push(processingTimeMs);
  if (ev.processingTimes.length > ROLLING_WINDOW) ev.processingTimes.shift();

  // Trim timestamps
  while (ev.timestamps.length > 0 && now - ev.timestamps[0] > RATE_WINDOW_MS) {
    ev.timestamps.shift();
  }
}

function calcStats(arr: number[]): HookTimingStats {
  if (arr.length === 0) return { avg: 0, min: 0, max: 0, p95: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    avg: Math.round(sum / sorted.length),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: sorted[Math.floor(sorted.length * 0.95)],
  };
}

/**
 * Get current hook stats snapshot for API/WebSocket.
 */
export function getStats(): HookStats {
  const now = Date.now();
  const events: Record<string, HookEventStats> = {};

  for (const [eventType, ev] of Object.entries(byEvent)) {
    // Count hooks in last minute for per-event rate
    const recentCount = ev.timestamps.filter(t => now - t < RATE_WINDOW_MS).length;
    events[eventType] = {
      count: ev.count,
      rate: recentCount, // hooks in last minute
      latency: calcStats(ev.latencies),
      processing: calcStats(ev.processingTimes),
    };
  }

  return {
    totalHooks,
    hooksPerMin: globalTimestamps.filter(t => now - t < RATE_WINDOW_MS).length,
    events,
    sampledAt: now,
  };
}

/**
 * Reset all stats (for testing or manual reset).
 */
export function resetStats(): void {
  totalHooks = 0;
  globalTimestamps.length = 0;
  for (const key of Object.keys(byEvent)) {
    delete byEvent[key];
  }
}
