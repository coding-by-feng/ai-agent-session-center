// WebSocket client with auto-reconnect
let ws;
let reconnectDelay = 1000;
let onSnapshot = null;
let onSessionUpdate = null;
let onDurationAlert = null;
let onTeamUpdate = null;
let reconnectTimer = null;
let reconnectTarget = 0; // timestamp when reconnect fires

export let connected = false;

export function getReconnectRemaining() {
  if (connected || !reconnectTarget) return 0;
  return Math.max(0, Math.ceil((reconnectTarget - Date.now()) / 1000));
}

export function connect({ onSnapshotCb, onSessionUpdateCb, onDurationAlertCb, onTeamUpdateCb }) {
  onSnapshot = onSnapshotCb;
  onSessionUpdate = onSessionUpdateCb;
  onDurationAlert = onDurationAlertCb;
  onTeamUpdate = onTeamUpdateCb;
  _connect();
}

function _connect() {
  ws = new WebSocket(`ws://${window.location.host}`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    reconnectTarget = 0;
    connected = true;
    console.log('[WS] Connected');
    document.dispatchEvent(new CustomEvent('ws-status', { detail: 'connected' }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'snapshot' && onSnapshot) {
      onSnapshot(data.sessions, data.teams);
    } else if (data.type === 'session_update' && onSessionUpdate) {
      onSessionUpdate(data.session, data.team);
    } else if (data.type === 'team_update' && onTeamUpdate) {
      onTeamUpdate(data.team);
    } else if (data.type === 'duration_alert' && onDurationAlert) {
      onDurationAlert(data);
    }
  };

  ws.onclose = () => {
    connected = false;
    console.log(`[WS] Disconnected, reconnecting in ${reconnectDelay}ms`);
    document.dispatchEvent(new CustomEvent('ws-status', { detail: 'disconnected' }));
    reconnectTarget = Date.now() + reconnectDelay;
    reconnectTimer = setTimeout(_connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };

  ws.onerror = () => ws.close();
}
