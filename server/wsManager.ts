// wsManager.ts — WebSocket broadcast manager with bidirectional terminal support
import { getAllSessions, getAllTeams, getEventSeq, getEventsSince, updateQueueCount } from './sessionStore.js';
import { writeToTerminal, resizeTerminal, closeTerminal, setWsClient } from './sshManager.js';
import { WS_TYPES } from './constants.js';
import log from './logger.js';
import type WebSocket from 'ws';

interface WsClient extends WebSocket {
  _terminalIds: Set<string>;
  _isAlive: boolean;
}

const clients = new Set<WsClient>();

// Heartbeat: ping every 30s, terminate connections that don't pong within 10s
const HEARTBEAT_INTERVAL_MS = 30000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// Backpressure: skip non-critical updates if client buffer exceeds 1MB
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024;

// Throttle hook_stats broadcasts to once per second max
let lastHookStatsBroadcastAt = 0;
let pendingHookStats: unknown = null;
let hookStatsTimer: ReturnType<typeof setTimeout> | null = null;
const HOOK_STATS_THROTTLE_MS = 1000;

function startHeartbeat(): void {
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

export function stopHeartbeat(): void {
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
 */
export function handleConnection(ws: WebSocket): void {
  const client = ws as WsClient;
  clients.add(client);
  client._terminalIds = new Set();
  client._isAlive = true;
  log.info('ws', `Client connected (total: ${clients.size})`);

  // Start heartbeat on first connection
  startHeartbeat();

  // Handle pong responses
  client.on('pong', () => {
    client._isAlive = true;
  });

  // Send full snapshot on connect (includes teams + event sequence for replay)
  const sessions = getAllSessions();
  const teams = getAllTeams();
  const seq = getEventSeq();
  log.debug('ws', `Sending snapshot: ${Object.keys(sessions).length} sessions, ${Object.keys(teams).length} teams, seq=${seq}`);
  client.send(JSON.stringify({ type: WS_TYPES.SNAPSHOT, sessions, teams, seq }));

  // Handle incoming messages (terminal input, resize, etc.)
  client.on('message', (raw: WebSocket.RawData) => {
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
            // #31: Relay resize errors back to client
            const resizeErr = resizeTerminal(msg.terminalId, msg.cols, msg.rows);
            if (resizeErr && client.readyState === 1) {
              try { client.send(JSON.stringify({ type: 'terminal_error', terminalId: msg.terminalId, error: `Resize failed: ${resizeErr}` })); } catch { /* ignore */ }
            }
          }
          break;
        case WS_TYPES.TERMINAL_DISCONNECT:
          if (msg.terminalId) {
            closeTerminal(msg.terminalId);
            client._terminalIds.delete(msg.terminalId);
          }
          break;
        case WS_TYPES.TERMINAL_SUBSCRIBE:
          // #30/#44: Only subscribe if terminal actually exists
          if (msg.terminalId) {
            const exists = setWsClient(msg.terminalId, client);
            if (exists) {
              client._terminalIds.add(msg.terminalId);
            } else {
              log.debug('ws', `Terminal subscribe ignored — ${msg.terminalId} not found`);
            }
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
              client.send(JSON.stringify(evt.data));
            }
          }
          break;
        default:
          log.debug('ws', `Unknown message type: ${msg.type}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log.debug('ws', `Invalid WS message: ${msg}`);
    }
  });

  client.on('close', () => {
    clients.delete(client);
    log.info('ws', `Client disconnected (total: ${clients.size})`);
    // Stop heartbeat if no clients remain
    if (clients.size === 0) {
      stopHeartbeat();
    }
  });
  client.on('error', (err: Error) => {
    clients.delete(client);
    log.error('ws', 'Client error:', err.message);
  });
}

/**
 * Check if a broadcast type is critical (must not be skipped under backpressure).
 * Session updates and snapshots are critical; hook_stats are not.
 */
function isCriticalBroadcast(data: { type: string }): boolean {
  return data.type !== WS_TYPES.HOOK_STATS;
}

/**
 * Broadcast a message to all connected WebSocket clients.
 * Throttles hook_stats to once per second; applies backpressure for non-critical messages.
 */
export function broadcast(data: { type: string; [key: string]: unknown }): void {
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
            const deferred = pendingHookStats as { type: string; [key: string]: unknown };
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

function broadcastToClients(data: { type: string; [key: string]: unknown }, critical: boolean): void {
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
