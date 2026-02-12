// @ts-check
// wsManager.js — WebSocket broadcast manager with bidirectional terminal support
import { getAllSessions, getAllTeams, getEventSeq, getEventsSince, updateQueueCount } from './sessionStore.js';
import { writeToTerminal, resizeTerminal, closeTerminal, setWsClient } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import log from './logger.js';

const clients = new Set();

// Heartbeat: ping every 30s, terminate connections that don't pong within 10s
const HEARTBEAT_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;
let heartbeatTimer = null;

// Backpressure: skip non-critical updates if client buffer exceeds 1MB
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;

// Throttle hook_stats broadcasts to once per second max
let lastHookStatsBroadcastAt = 0;
let pendingHookStats = null;
let hookStatsTimer = null;
const HOOK_STATS_THROTTLE_MS = 1000;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const ws of clients) {
      if (ws._isAlive === false) {
        // Didn't respond to last ping — terminate
        log.info('ws', 'Terminating unresponsive client');
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws._isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
}

export function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (hookStatsTimer) {
    clearTimeout(hookStatsTimer);
    hookStatsTimer = null;
  }
}

/**
 * Handle a new WebSocket connection: send snapshot and wire up message/close handlers.
 * @param {import('ws').WebSocket} ws
 */
export function handleConnection(ws) {
  clients.add(ws);
  ws._terminalIds = new Set(); // Track subscribed terminals
  ws._isAlive = true;
  log.info('ws', `Client connected (total: ${clients.size})`);

  // Start heartbeat on first connection
  startHeartbeat();

  // Handle pong responses
  ws.on('pong', () => {
    ws._isAlive = true;
  });

  // Send full snapshot on connect (includes teams + event sequence for replay)
  const sessions = getAllSessions();
  const teams = getAllTeams();
  const seq = getEventSeq();
  log.debug('ws', `Sending snapshot: ${Object.keys(sessions).length} sessions, ${Object.keys(teams).length} teams, seq=${seq}`);
  ws.send(JSON.stringify({ type: WS_TYPES.SNAPSHOT, sessions, teams, seq }));

  // Handle incoming messages (terminal input, resize, etc.)
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case WS_TYPES.TERMINAL_INPUT:
          if (msg.terminalId && msg.data) {
            writeToTerminal(msg.terminalId, msg.data);
          }
          break;
        case WS_TYPES.TERMINAL_RESIZE:
          if (msg.terminalId && msg.cols && msg.rows) {
            resizeTerminal(msg.terminalId, msg.cols, msg.rows);
          }
          break;
        case WS_TYPES.TERMINAL_DISCONNECT:
          if (msg.terminalId) {
            closeTerminal(msg.terminalId);
            ws._terminalIds.delete(msg.terminalId);
          }
          break;
        case WS_TYPES.TERMINAL_SUBSCRIBE:
          if (msg.terminalId) {
            ws._terminalIds.add(msg.terminalId);
            setWsClient(msg.terminalId, ws);
          }
          break;
        case WS_TYPES.UPDATE_QUEUE_COUNT:
          if (msg.sessionId != null && msg.count != null) {
            const updated = updateQueueCount(msg.sessionId, msg.count);
            if (updated) {
              broadcast({ type: WS_TYPES.SESSION_UPDATE, session: updated });
            }
          }
          break;
        case WS_TYPES.REPLAY:
          // Client reconnected and wants events since a certain sequence number
          if (typeof msg.sinceSeq === 'number') {
            const missed = getEventsSince(msg.sinceSeq);
            log.debug('ws', `Replaying ${missed.length} events since seq=${msg.sinceSeq}`);
            for (const evt of missed) {
              ws.send(JSON.stringify(evt.data));
            }
          }
          break;
        default:
          log.debug('ws', `Unknown message type: ${msg.type}`);
      }
    } catch (e) {
      log.debug('ws', `Invalid WS message: ${e.message}`);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    log.info('ws', `Client disconnected (total: ${clients.size})`);
    // Stop heartbeat if no clients remain
    if (clients.size === 0) {
      stopHeartbeat();
    }
  });
  ws.on('error', (err) => {
    clients.delete(ws);
    log.error('ws', 'Client error:', err.message);
  });
}

/**
 * Check if a broadcast type is critical (must not be skipped under backpressure).
 * Session updates and snapshots are critical; hook_stats are not.
 */
function isCriticalBroadcast(data) {
  return data.type !== WS_TYPES.HOOK_STATS;
}

/**
 * Broadcast a message to all connected WebSocket clients.
 * Throttles hook_stats to once per second; applies backpressure for non-critical messages.
 * @param {import('../types/websocket').ServerMessage} data
 */
export function broadcast(data) {
  // Throttle hook_stats broadcasts to once per second max
  if (data.type === WS_TYPES.HOOK_STATS) {
    const now = Date.now();
    if (now - lastHookStatsBroadcastAt < HOOK_STATS_THROTTLE_MS) {
      // Store for deferred send
      pendingHookStats = data;
      if (!hookStatsTimer) {
        hookStatsTimer = setTimeout(() => {
          hookStatsTimer = null;
          if (pendingHookStats) {
            const deferred = pendingHookStats;
            pendingHookStats = null;
            lastHookStatsBroadcastAt = Date.now();
            broadcastToClients(deferred, false);
          }
        }, HOOK_STATS_THROTTLE_MS - (now - lastHookStatsBroadcastAt));
      }
      return;
    }
    lastHookStatsBroadcastAt = now;
  }

  const critical = isCriticalBroadcast(data);
  broadcastToClients(data, critical);
}

function broadcastToClients(data, critical) {
  const msg = JSON.stringify(data);
  log.debug('ws', `Broadcasting ${data.type} to ${clients.size} clients`);
  for (const client of clients) {
    if (client.readyState !== 1) continue;
    // Backpressure: skip non-critical updates if buffer is too large
    if (!critical && client.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      log.debug('ws', `Skipping ${data.type} for client (buffered=${client.bufferedAmount})`);
      continue;
    }
    client.send(msg);
  }
}
