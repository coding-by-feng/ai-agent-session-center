// hookProcessor.ts — Shared hook event processing pipeline
// Used by both hookRouter.ts (HTTP) and mqReader.ts (file-based MQ)
import { handleEvent } from './sessionStore.js';
import { broadcast } from './wsManager.js';
import { recordHook, getStats } from './hookStats.js';
import { KNOWN_EVENTS, WS_TYPES } from './constants.js';
import log from './logger.js';
import type { HookPayload } from '../src/types/hook.js';
import type { HandleEventResult } from '../src/types/session.js';

// #80: Throttle session_update broadcasts to max 4/sec per session (250ms)
const SESSION_UPDATE_THROTTLE_MS = 250;
const pendingSessionUpdates = new Map<string, { delta: HandleEventResult; timer: ReturnType<typeof setTimeout> }>();

function scheduleBroadcast(sessionId: string, delta: HandleEventResult): void {
  const existing = pendingSessionUpdates.get(sessionId);
  if (existing) {
    // Update the pending delta with latest data (coalesce)
    existing.delta = delta;
    return;
  }
  // No pending broadcast — schedule one
  const timer = setTimeout(() => {
    const pending = pendingSessionUpdates.get(sessionId);
    if (!pending) return;
    pendingSessionUpdates.delete(sessionId);
    broadcast({ type: WS_TYPES.SESSION_UPDATE, ...pending.delta });
    if (pending.delta.team) {
      broadcast({ type: WS_TYPES.TEAM_UPDATE, team: pending.delta.team });
    }
  }, SESSION_UPDATE_THROTTLE_MS);
  pendingSessionUpdates.set(sessionId, { delta, timer });
}

/**
 * Validate a hook payload. Returns null if valid, or an error string if invalid.
 */
function validateHookPayload(hookData: unknown): string | null {
  if (!hookData || typeof hookData !== 'object') {
    return 'payload must be a JSON object';
  }
  const data = hookData as Record<string, unknown>;
  // session_id: required, must be string, reasonable length
  if (!data.session_id) {
    return 'missing session_id';
  }
  if (typeof data.session_id !== 'string') {
    return 'session_id must be a string';
  }
  if (data.session_id.length > 256) {
    return 'session_id too long (max 256 chars)';
  }
  // hook_event_name: required, must be a known event type
  const eventName = (data.hook_event_name || data.event) as string | undefined;
  if (!eventName) {
    return 'missing hook_event_name';
  }
  if (typeof eventName !== 'string' || !KNOWN_EVENTS.has(eventName)) {
    return `unknown event type: ${String(eventName).substring(0, 64)}`;
  }
  // claude_pid: if present, must be a positive integer
  if (data.claude_pid != null) {
    const pid = Number(data.claude_pid);
    if (!Number.isFinite(pid) || pid <= 0 || Math.floor(pid) !== pid) {
      return 'claude_pid must be a positive integer';
    }
  }
  // timestamp: if present, must be valid number
  if (data.timestamp != null) {
    const ts = Number(data.timestamp);
    if (!Number.isFinite(ts)) {
      return 'timestamp must be a valid number';
    }
  }
  return null;
}

/**
 * Process a hook event from any transport (HTTP or MQ).
 * Validates, calls handleEvent(), records stats, broadcasts to WebSocket clients.
 */
export function processHookEvent(
  hookData: HookPayload,
  source: 'http' | 'mq' = 'http',
): HandleEventResult | { error: string } | null {
  const receivedAt = Date.now();

  const validationError = validateHookPayload(hookData);
  if (validationError) {
    log.warn('hook', `Rejected hook payload (via ${source}): ${validationError}`);
    return { error: validationError };
  }

  log.debug('hook', `Event: ${hookData.hook_event_name || 'unknown'} session=${hookData.session_id} via=${source}`);
  log.debugJson('hook', 'Hook payload', hookData);

  // Measure server processing time
  const processStart = Date.now();
  let delta: HandleEventResult | null;
  try {
    delta = handleEvent(hookData);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('hook', `handleEvent threw for session=${hookData.session_id}: ${msg}`);
    return null;
  }
  const processingTime = Date.now() - processStart;

  // Calculate delivery latency (hook_sent_at is seconds * 1000 from bash `date +%s`)
  let deliveryLatency: number | null = null;
  if (hookData.hook_sent_at) {
    deliveryLatency = receivedAt - hookData.hook_sent_at;
    if (deliveryLatency < 0) deliveryLatency = 0;
  }

  // Record stats
  const eventType = hookData.hook_event_name || 'unknown';
  recordHook(eventType, deliveryLatency, processingTime);

  // #80: Use throttled broadcast for session updates to max 4/sec per session
  if (delta) {
    log.debug('hook', `Broadcasting session_update for ${hookData.session_id} status=${delta.session?.status}`);
    scheduleBroadcast(hookData.session_id, delta);
    broadcast({ type: WS_TYPES.HOOK_STATS, stats: getStats() });
  }

  return delta;
}
