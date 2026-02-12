// @ts-check
// hookProcessor.js — Shared hook event processing pipeline
// Used by both hookRouter.js (HTTP) and mqReader.js (file-based MQ)
import { handleEvent } from './sessionStore.js';
import { broadcast } from './wsManager.js';
import { recordHook, getStats } from './hookStats.js';
import { KNOWN_EVENTS, WS_TYPES } from './constants.js';
import log from './logger.js';

/**
 * Validate a hook payload. Returns null if valid, or an error string if invalid.
 * @param {unknown} hookData
 * @returns {string | null}
 */
function validateHookPayload(hookData) {
  if (!hookData || typeof hookData !== 'object') {
    return 'payload must be a JSON object';
  }
  // session_id: required, must be string, reasonable length
  if (!hookData.session_id) {
    return 'missing session_id';
  }
  if (typeof hookData.session_id !== 'string') {
    return 'session_id must be a string';
  }
  if (hookData.session_id.length > 256) {
    return 'session_id too long (max 256 chars)';
  }
  // hook_event_name: required, must be a known event type
  const eventName = hookData.hook_event_name || hookData.event;
  if (!eventName) {
    return 'missing hook_event_name';
  }
  if (typeof eventName !== 'string' || !KNOWN_EVENTS.has(eventName)) {
    return `unknown event type: ${String(eventName).substring(0, 64)}`;
  }
  // claude_pid: if present, must be a positive integer
  if (hookData.claude_pid != null) {
    const pid = Number(hookData.claude_pid);
    if (!Number.isFinite(pid) || pid <= 0 || Math.floor(pid) !== pid) {
      return 'claude_pid must be a positive integer';
    }
  }
  // timestamp: if present, must be valid number
  if (hookData.timestamp != null) {
    const ts = Number(hookData.timestamp);
    if (!Number.isFinite(ts)) {
      return 'timestamp must be a valid number';
    }
  }
  return null;
}

/**
 * Process a hook event from any transport (HTTP or MQ).
 * Validates, calls handleEvent(), records stats, broadcasts to WebSocket clients.
 *
 * @param {import('../types/hook').HookPayload} hookData - Parsed hook JSON payload
 * @param {'http'|'mq'} [source='http'] - Transport source for logging
 * @returns {import('../types/session').HandleEventResult | { error: string } | null}
 */
export function processHookEvent(hookData, source = 'http') {
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
  let delta;
  try {
    delta = handleEvent(hookData);
  } catch (e) {
    log.error('hook', `handleEvent threw for session=${hookData.session_id}: ${e.message}`);
    return null;
  }
  const processingTime = Date.now() - processStart;

  // Calculate delivery latency (hook_sent_at is seconds * 1000 from bash `date +%s`)
  let deliveryLatency = null;
  if (hookData.hook_sent_at) {
    deliveryLatency = receivedAt - hookData.hook_sent_at;
    if (deliveryLatency < 0) deliveryLatency = 0;
  }

  // Record stats
  const eventType = hookData.hook_event_name || 'unknown';
  recordHook(eventType, deliveryLatency, processingTime);

  // Broadcast to WebSocket clients
  if (delta) {
    log.debug('hook', `Broadcasting session_update for ${hookData.session_id} status=${delta.session?.status}`);
    broadcast({ type: WS_TYPES.SESSION_UPDATE, ...delta });
    if (delta.team) {
      log.debug('hook', `Broadcasting team_update for team=${delta.team.teamId}`);
      broadcast({ type: WS_TYPES.TEAM_UPDATE, team: delta.team });
    }
    broadcast({ type: WS_TYPES.HOOK_STATS, stats: getStats() });
  }

  return delta;
}
