// routerConfig.ts — the router's weights and P4's two other switches, read from server-config.json.
//
//   mcp.router             the scoring weights, the reuse threshold, the context ceiling, the runners-up count
//   mcp.autoRouting        `task_delegate(to: "auto")` on or off (default off: P4-10 let the replay check decide, and
//                          it measured 41.9 % on the owner's sessions on 2026-10-24, under 70 %). `task_route` and
//                          `project_resolve` stay on: they open and send nothing, and they are how a central picks
//                          from the top 5 itself (spec, Routing: "Who picks")
//   mcp.idleWorkerMinutes  how long an idle worker a central opened is left before AASC closes it, in whole minutes
//                          (0 = never)
//   mcp.notices            P5's typed notices into an idle central (notices.ts) on or off (default off, Ruling P5-19:
//                          a typed notice starts a paid model turn the person did not ask for, so they opt in)
//
// Read from `config` (serverConfig.ts) the way runtime.ts reads `mcp.enabled`: the file is loaded once at import, so
// a change needs a restart. Every number is clamped to a range that cannot break routing (a threshold of 0 would
// reuse anything, a ceiling of 5 % would reuse nothing), and a value that is not a finite number is ignored, so a
// typo in the file costs that one setting, never the router. Each call builds new objects: nothing a caller does to
// the answer reaches the defaults.

import type { McpRouterConfig, ServerConfig } from '../../src/types/settings.js';
import { config } from '../serverConfig.js';

/** The scoring terms, as the spec names them (same folder +3, task words +2, idle/waiting +2, headroom +1, recent +1). */
export interface RouterWeights {
  sameFolder: number;
  taskWords: number;
  idleOrWaiting: number;
  headroom: number;
  recentActivity: number;
}

export interface RouterSettings {
  weights: RouterWeights;
  /** Reuse a session when the best score is at least this. */
  reuseThreshold: number;
  /** A session whose context window is this full (%) or more is not eligible. */
  contextCeilingPct: number;
  /** How many other candidates a route lists. */
  runnersUp: number;
}

export const ROUTER_DEFAULTS: RouterSettings = Object.freeze({
  weights: Object.freeze({ sameFolder: 3, taskWords: 2, idleOrWaiting: 2, headroom: 1, recentActivity: 1 }),
  reuseThreshold: 4,
  contextCeilingPct: 80,
  runnersUp: 5,
});

export const AUTO_ROUTING_DEFAULT = false;
export const IDLE_WORKER_MINUTES_DEFAULT = 30;
export const NOTICES_DEFAULT = false;
/** A day: an idle worker is never left longer than this, whatever the file says. */
const IDLE_WORKER_MINUTES_MAX = 1_440;

type McpConfig = ServerConfig['mcp'];

/** `value` clamped into [min, max]; `fallback` when it is not a finite number. */
function clamped(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `mcp.router` object, or nothing when the file holds anything else in its place. */
function routerOf(mcp: McpConfig | undefined): McpRouterConfig {
  const router: unknown = mcp?.router;
  return isRecord(router) ? (router as McpRouterConfig) : {};
}

/** The router's settings: `mcp.router` of the loaded config (or of `mcp`, when given), clamped, over the spec's defaults. */
export function routerSettings(mcp: McpConfig | undefined = config.mcp): RouterSettings {
  const given = routerOf(mcp);
  const defaults = ROUTER_DEFAULTS;
  return {
    weights: {
      sameFolder: clamped(given.weightSameFolder, 0, 10, defaults.weights.sameFolder),
      taskWords: clamped(given.weightTaskWords, 0, 10, defaults.weights.taskWords),
      idleOrWaiting: clamped(given.weightIdleOrWaiting, 0, 10, defaults.weights.idleOrWaiting),
      headroom: clamped(given.weightHeadroom, 0, 10, defaults.weights.headroom),
      recentActivity: clamped(given.weightRecentActivity, 0, 10, defaults.weights.recentActivity),
    },
    reuseThreshold: clamped(given.reuseThreshold, 1, 20, defaults.reuseThreshold),
    contextCeilingPct: clamped(given.contextCeilingPct, 50, 95, defaults.contextCeilingPct),
    runnersUp: Math.round(clamped(given.runnersUp, 1, 10, defaults.runnersUp)),
  };
}

/** Is automatic routing on? `mcp.autoRouting`, else AUTO_ROUTING_DEFAULT; a value that is not a boolean counts as absent. */
export function autoRoutingEnabled(mcp: McpConfig | undefined = config.mcp): boolean {
  const value: unknown = mcp?.autoRouting;
  return typeof value === 'boolean' ? value : AUTO_ROUTING_DEFAULT;
}

/**
 * Minutes before an idle worker is closed: `mcp.idleWorkerMinutes` in whole minutes (0 = off; any other value rounds
 * down, at least 1, at most a day), else 30. A fraction would close a worker seconds after its answer.
 */
export function idleWorkerMinutes(mcp: McpConfig | undefined = config.mcp): number {
  const value: unknown = mcp?.idleWorkerMinutes;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return IDLE_WORKER_MINUTES_DEFAULT;
  if (value === 0) return 0;
  return Math.min(IDLE_WORKER_MINUTES_MAX, Math.max(1, Math.floor(value)));
}

/** Are typed notices on? `mcp.notices` when it is `true`; anything else, or nothing, is NOTICES_DEFAULT (off). */
export function noticesOn(mcp: McpConfig | undefined = config.mcp): boolean {
  // Not in ServerConfig's type yet (src/types/settings.ts): read from the object as the file holds it.
  const value: unknown = isRecord(mcp) ? (mcp as Record<string, unknown>).notices : undefined;
  return typeof value === 'boolean' ? value : NOTICES_DEFAULT;
}
