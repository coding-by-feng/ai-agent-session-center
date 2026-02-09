let wsConnected = false;

// Listen for WebSocket connection status events from wsClient
document.addEventListener('ws-status', (e) => {
  wsConnected = e.detail === 'connected';
});

let historicalLoaded = false;

export async function loadHistoricalStats() {
  if (historicalLoaded) return;
  try {
    const resp = await fetch('/api/analytics/summary');
    const stats = await resp.json();
    historicalLoaded = true;

    const el = document.getElementById('global-stats');
    // Append historical summary after the existing live stats
    const histSpan = document.createElement('span');
    histSpan.className = 'stat historical-stat';
    histSpan.innerHTML = `
      <span class="stat-label">History</span>
      <span class="stat-value">${stats.total_sessions} sessions</span>
    `;
    el.appendChild(histSpan);
  } catch (e) {
    // Server may not have /api/analytics/summary yet
  }
}

export function update(sessions) {
  const list = Object.values(sessions);
  const activeCount = list.filter(s => s.status !== 'ended').length;
  const totalTools = list.reduce((sum, s) => sum + (s.totalToolCalls || 0), 0);

  const el = document.getElementById('global-stats');
  el.innerHTML = `
    <span class="stat">
      <span class="stat-label">Sessions</span>
      <span class="stat-value">${activeCount}</span>
    </span>
    <span class="stat">
      <span class="stat-label">Tool Calls</span>
      <span class="stat-value">${totalTools}</span>
    </span>
  `;
}
