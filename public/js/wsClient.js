// WebSocket client with auto-reconnect
import { debugLog, debugWarn } from './utils.js';

let ws;
let reconnectDelay = 1000;
let onSnapshot = null;
let onSessionUpdate = null;
let onDurationAlert = null;
let onTeamUpdate = null;
let onHookStats = null;
let onSessionRemoved = null;
let onTerminalOutput = null;
let onTerminalReady = null;
let onTerminalClosed = null;
let onClearBrowserDb = null;
let reconnectTimer = null;
let reconnectTarget = 0; // timestamp when reconnect fires

export let connected = false;

export function getReconnectRemaining() {
  if (connected || !reconnectTarget) return 0;
  return Math.max(0, Math.ceil((reconnectTarget - Date.now()) / 1000));
}

export function connect({ onSnapshotCb, onSessionUpdateCb, onSessionRemovedCb, onDurationAlertCb, onTeamUpdateCb, onHookStatsCb, onTerminalOutputCb, onTerminalReadyCb, onTerminalClosedCb, onClearBrowserDbCb }) {
  onSnapshot = onSnapshotCb;
  onSessionUpdate = onSessionUpdateCb;
  onSessionRemoved = onSessionRemovedCb || null;
  onDurationAlert = onDurationAlertCb;
  onTeamUpdate = onTeamUpdateCb;
  onHookStats = onHookStatsCb;
  onTerminalOutput = onTerminalOutputCb || null;
  onTerminalReady = onTerminalReadyCb || null;
  onTerminalClosed = onTerminalClosedCb || null;
  onClearBrowserDb = onClearBrowserDbCb || null;
  _connect();
}

export function getWs() {
  return ws;
}

function _connect() {
  // Include auth token in WS URL for authentication
  const token = localStorage.getItem('auth_token');
  const wsUrl = token
    ? `ws://${window.location.host}?token=${encodeURIComponent(token)}`
    : `ws://${window.location.host}`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    reconnectDelay = 1000;
    reconnectTarget = 0;
    connected = true;
    debugLog('[WS] Connected');
    document.dispatchEvent(new CustomEvent('ws-status', { detail: 'connected' }));
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      debugWarn('[WS] Malformed JSON message:', e.message);
      return;
    }

    if (!data || typeof data.type !== 'string') {
      debugWarn('[WS] Message missing type field:', data);
      return;
    }

    if (data.type === 'snapshot' && onSnapshot) {
      onSnapshot(data.sessions, data.teams);
    } else if (data.type === 'session_update' && onSessionUpdate) {
      onSessionUpdate(data.session, data.team);
    } else if (data.type === 'session_removed' && onSessionRemoved) {
      onSessionRemoved(data.sessionId);
    } else if (data.type === 'team_update' && onTeamUpdate) {
      onTeamUpdate(data.team);
    } else if (data.type === 'hook_stats' && onHookStats) {
      onHookStats(data.stats);
    } else if (data.type === 'duration_alert' && onDurationAlert) {
      onDurationAlert(data);
    } else if (data.type === 'terminal_output' && onTerminalOutput) {
      onTerminalOutput(data.terminalId, data.data);
    } else if (data.type === 'terminal_ready' && onTerminalReady) {
      onTerminalReady(data.terminalId);
    } else if (data.type === 'terminal_closed' && onTerminalClosed) {
      onTerminalClosed(data.terminalId, data.reason);
    } else if (data.type === 'clearBrowserDb' && onClearBrowserDb) {
      onClearBrowserDb();
    }
  };

  ws.onclose = (event) => {
    connected = false;

    // 4001 = Unauthorized — stop reconnecting, show login
    if (event.code === 4001) {
      debugWarn('[WS] Unauthorized — redirecting to login');
      localStorage.removeItem('auth_token');
      document.dispatchEvent(new CustomEvent('ws-auth-failed'));
      return;
    }

    debugLog(`[WS] Disconnected, reconnecting in ${reconnectDelay}ms`);
    document.dispatchEvent(new CustomEvent('ws-status', { detail: 'disconnected' }));
    reconnectTarget = Date.now() + reconnectDelay;
    reconnectTimer = setTimeout(_connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}
