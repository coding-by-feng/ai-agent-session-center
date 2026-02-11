// hookProcessor.js — Shared hook event processing pipeline
// Used by both hookRouter.js (HTTP) and mqReader.js (file-based MQ)
import { handleEvent } from './sessionStore.js';
import { broadcast } from './wsManager.js';
import { recordHook, getStats } from './hookStats.js';
import log from './logger.js';

/**
 * Process a hook event from any transport (HTTP or MQ).
 * Validates, calls handleEvent(), records stats, broadcasts to WebSocket clients.
 *
 * @param {object} hookData - Parsed hook JSON payload
 * @param {'http'|'mq'} [source='http'] - Transport source for logging
 * @returns {object|null} Session delta if event was processed, null otherwise
 */
export function processHookEvent(hookData, source = 'http') {
  const receivedAt = Date.now();

  if (!hookData || !hookData.session_id) {
    log.warn('hook', `Received hook without session_id (via ${source})`);
    return null;
  }

  log.debug('hook', `Event: ${hookData.hook_event_name || 'unknown'} session=${hookData.session_id} via=${source}`);
  log.debugJson('hook', 'Hook payload', hookData);

  // Measure server processing time
  const processStart = Date.now();
  const delta = handleEvent(hookData);
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
    broadcast({ type: 'session_update', ...delta });
    if (delta.team) {
      log.debug('hook', `Broadcasting team_update for team=${delta.team.teamId}`);
      broadcast({ type: 'team_update', team: delta.team });
    }
    broadcast({ type: 'hook_stats', stats: getStats() });
  }

  return delta;
}
